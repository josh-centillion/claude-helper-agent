import type { Env, IndexRequest, IndexProgress, Chunk, VectorMetadata } from '../types';
import { chunkFile, assignChunkIds } from '../lib/chunker';
import { generateEmbeddings, upsertVectors, deleteProjectVectors } from '../lib/embeddings';
import {
  generateId,
  hashContent,
  shouldIndexFile,
  extractProjectName,
  getFileType,
  jsonResponse,
  errorResponse
} from '../lib/utils';

const EMBEDDING_BATCH_SIZE = 50;

/**
 * Handle project indexing requests
 * Note: This expects file content to be provided in the request since Workers can't access local filesystem
 */
export async function handleIndex(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as IndexRequest & {
      files?: Array<{ path: string; content: string }>;
      append?: boolean;  // Append mode: add files without clearing existing data
    };

    if (!body.project_path) {
      return errorResponse('project_path is required');
    }

    if (!body.files || body.files.length === 0) {
      return errorResponse('files array is required with path and content for each file');
    }

    const projectName = body.project_name || extractProjectName(body.project_path);
    const projectPath = body.project_path;
    const appendMode = body.append === true;

    // Check if project exists
    let project = await env.DB.prepare(
      'SELECT * FROM projects WHERE path = ?'
    ).bind(projectPath).first();

    let projectId: string;
    let existingFilePaths: Set<string> = new Set();

    if (project) {
      projectId = (project as any).id;

      if (appendMode) {
        // Append mode: get existing file paths to skip duplicates
        const existingFiles = await env.DB.prepare(
          'SELECT relative_path FROM files WHERE project_id = ?'
        ).bind(projectId).all();
        existingFilePaths = new Set(existingFiles.results.map((f: any) => f.relative_path));

        // Update status to indexing
        await env.DB.prepare(
          'UPDATE projects SET status = ? WHERE id = ?'
        ).bind('indexing', projectId).run();
      } else if (!body.force) {
        // Check if already indexed recently (within 1 hour)
        const lastIndexed = (project as any).last_indexed_at;
        if (lastIndexed && Date.now() / 1000 - lastIndexed < 3600) {
          return jsonResponse({
            message: 'Project was indexed recently. Use force=true to re-index or append=true to add files.',
            project_id: projectId,
            last_indexed_at: lastIndexed,
          });
        }
        // Not recent, do full re-index
        await deleteProjectVectors(env, projectId);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM chunks WHERE project_id = ?').bind(projectId),
          env.DB.prepare('DELETE FROM files WHERE project_id = ?').bind(projectId),
          env.DB.prepare(
            'UPDATE projects SET status = ?, file_count = 0 WHERE id = ?'
          ).bind('indexing', projectId),
        ]);
      } else {
        // Force mode: clear existing data for re-index
        await deleteProjectVectors(env, projectId);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM chunks WHERE project_id = ?').bind(projectId),
          env.DB.prepare('DELETE FROM files WHERE project_id = ?').bind(projectId),
          env.DB.prepare(
            'UPDATE projects SET status = ?, file_count = 0 WHERE id = ?'
          ).bind('indexing', projectId),
        ]);
      }
    } else {
      // Create new project
      projectId = generateId();
      await env.DB.prepare(
        'INSERT INTO projects (id, name, path, status) VALUES (?, ?, ?, ?)'
      ).bind(projectId, projectName, projectPath, 'indexing').run();
    }

    // Filter out already-indexed files in append mode
    let filesToProcess = body.files.filter(f => shouldIndexFile(f.path));
    if (appendMode && existingFilePaths.size > 0) {
      const beforeCount = filesToProcess.length;
      filesToProcess = filesToProcess.filter(f => !existingFilePaths.has(f.path));
      console.log(`Append mode: skipped ${beforeCount - filesToProcess.length} existing files`);
    }

    // Process files
    const progress: IndexProgress = {
      project_id: projectId,
      status: 'chunking',
      total_files: filesToProcess.length,
      processed_files: 0,
      total_chunks: 0,
    };

    // If no new files to process in append mode, return early
    if (filesToProcess.length === 0) {
      await env.DB.prepare(
        'UPDATE projects SET status = ? WHERE id = ?'
      ).bind('ready', projectId).run();

      return jsonResponse({
        ...progress,
        status: 'complete',
        message: 'No new files to index',
        vectors_inserted: 0,
        vectors_errors: 0,
      });
    }

    const allChunks: Chunk[] = [];
    const fileRecords: Array<{
      id: string;
      project_id: string;
      relative_path: string;
      content_hash: string;
      chunk_count: number;
    }> = [];

    // Process each file
    for (const file of filesToProcess) {
      const fileId = generateId();
      const contentHash = await hashContent(file.content);

      // Chunk the file
      const chunks = assignChunkIds(chunkFile(file.content, {
        fileId,
        projectId,
        filePath: file.path,
      }));

      allChunks.push(...chunks);

      fileRecords.push({
        id: fileId,
        project_id: projectId,
        relative_path: file.path,
        content_hash: contentHash,
        chunk_count: chunks.length,
      });

      progress.processed_files++;
    }

    progress.total_chunks = allChunks.length;
    progress.status = 'embedding';

    // Insert file records
    const fileInsertStatements = fileRecords.map(f =>
      env.DB.prepare(
        'INSERT INTO files (id, project_id, relative_path, content_hash, chunk_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(f.id, f.project_id, f.relative_path, f.content_hash, f.chunk_count, Math.floor(Date.now() / 1000))
    );

    if (fileInsertStatements.length > 0) {
      // Batch insert files (D1 limits batch to 100)
      for (let i = 0; i < fileInsertStatements.length; i += 100) {
        await env.DB.batch(fileInsertStatements.slice(i, i + 100));
      }
    }

    // Insert chunks
    const chunkInsertStatements = allChunks.map(c =>
      env.DB.prepare(
        'INSERT INTO chunks (id, file_id, project_id, content, start_line, end_line, chunk_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(c.id, c.file_id, c.project_id, c.content, c.start_line, c.end_line, c.chunk_type)
    );

    if (chunkInsertStatements.length > 0) {
      for (let i = 0; i < chunkInsertStatements.length; i += 100) {
        await env.DB.batch(chunkInsertStatements.slice(i, i + 100));
      }
    }

    // Generate embeddings and upsert to Vectorize
    const vectorResults: Array<{
      id: string;
      values: number[];
      metadata: VectorMetadata;
    }> = [];

    for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const texts = batch.map(c => c.content);

      try {
        const embeddings = await generateEmbeddings(env, texts);

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const fileRecord = fileRecords.find(f => f.id === chunk.file_id);

          vectorResults.push({
            id: chunk.id,
            values: embeddings[j],
            metadata: {
              chunk_id: chunk.id,
              project_id: projectId,
              file_path: fileRecord?.relative_path || '',
              file_type: getFileType(fileRecord?.relative_path || ''),
              start_line: chunk.start_line,
              end_line: chunk.end_line,
            },
          });
        }
      } catch (error) {
        console.error(`Embedding error for batch ${i}:`, error);
        // Continue with remaining batches
      }
    }

    // Upsert vectors
    const { inserted, errors } = await upsertVectors(env, vectorResults);

    // Update project status
    if (appendMode) {
      // Append mode: increment file count
      await env.DB.prepare(
        `UPDATE projects
         SET status = ?, file_count = file_count + ?, last_indexed_at = ?
         WHERE id = ?`
      ).bind(
        errors === 0 ? 'ready' : 'error',
        fileRecords.length,
        Math.floor(Date.now() / 1000),
        projectId
      ).run();
    } else {
      // Full index: set file count
      await env.DB.prepare(
        `UPDATE projects
         SET status = ?, file_count = ?, last_indexed_at = ?
         WHERE id = ?`
      ).bind(
        errors === 0 ? 'ready' : 'error',
        fileRecords.length,
        Math.floor(Date.now() / 1000),
        projectId
      ).run();
    }

    progress.status = errors === 0 ? 'complete' : 'error';
    if (errors > 0) {
      progress.error = `${errors} vectors failed to upsert`;
    }

    return jsonResponse({
      ...progress,
      vectors_inserted: inserted,
      vectors_errors: errors,
    });

  } catch (error) {
    console.error('Index error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Indexing failed',
      500
    );
  }
}

/**
 * Get indexing progress for a project
 */
export async function handleIndexProgress(
  projectId: string,
  env: Env
): Promise<Response> {
  const project = await env.DB.prepare(
    'SELECT * FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) {
    return errorResponse('Project not found', 404);
  }

  const fileCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM files WHERE project_id = ?'
  ).bind(projectId).first();

  const chunkCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM chunks WHERE project_id = ?'
  ).bind(projectId).first();

  return jsonResponse({
    project_id: projectId,
    status: (project as any).status,
    total_files: (project as any).file_count,
    processed_files: (fileCount as any)?.count || 0,
    total_chunks: (chunkCount as any)?.count || 0,
    last_indexed_at: (project as any).last_indexed_at,
  });
}
