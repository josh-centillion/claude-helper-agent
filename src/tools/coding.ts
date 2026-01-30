/**
 * Coding Tools
 *
 * Tools for code operations:
 * - Semantic code search
 * - File read/write
 * - Diff generation
 * - Code analysis
 */

import type { Env, SearchResult } from '../types';

/**
 * Search code using semantic search
 */
export async function codeSearchTool(
  env: Env,
  query: string,
  options: {
    projectId?: string;
    topK?: number;
    fileType?: string;
  } = {}
): Promise<SearchResult[]> {
  const { projectId, topK = 10, fileType } = options;

  // Generate embedding for query
  const embedding = await env.AI.run(env.EMBEDDING_MODEL as any, {
    text: query,
  });

  // Build filter
  const filter: Record<string, string> = {};
  if (projectId) filter.project_id = projectId;
  if (fileType) filter.file_type = fileType;

  // Query Vectorize
  const results = await env.VECTORIZE.query(embedding.data[0], {
    topK,
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    returnMetadata: 'all',
  });

  // Fetch full chunk data from D1
  const chunks = await Promise.all(
    results.matches.map(async (match) => {
      const chunk = await env.DB.prepare(`
        SELECT
          c.id as chunk_id,
          c.content,
          c.start_line,
          c.end_line,
          f.relative_path as file_path,
          p.name as project_name
        FROM chunks c
        JOIN files f ON c.file_id = f.id
        JOIN projects p ON c.project_id = p.id
        WHERE c.id = ?
      `).bind(match.id).first();

      return {
        chunk_id: chunk?.chunk_id as string,
        content: chunk?.content as string,
        file_path: chunk?.file_path as string,
        project_name: chunk?.project_name as string,
        start_line: chunk?.start_line as number,
        end_line: chunk?.end_line as number,
        score: match.score,
      };
    })
  );

  return chunks.filter((c) => c.chunk_id); // Filter out any null results
}

/**
 * Read file content from indexed chunks
 */
export async function readFileTool(
  env: Env,
  projectId: string,
  filePath: string
): Promise<{ content: string; lineCount: number } | null> {
  const chunks = await env.DB.prepare(`
    SELECT c.content, c.start_line, c.end_line
    FROM chunks c
    JOIN files f ON c.file_id = f.id
    WHERE f.project_id = ? AND f.relative_path = ?
    ORDER BY c.start_line
  `).bind(projectId, filePath).all();

  if (chunks.results.length === 0) {
    return null;
  }

  const content = chunks.results.map((c: any) => c.content).join('\n');
  const lastChunk = chunks.results[chunks.results.length - 1] as any;

  return {
    content,
    lineCount: lastChunk.end_line,
  };
}

/**
 * Write file content (returns artifact key for later commit)
 */
export async function writeFileTool(
  env: Env,
  path: string,
  content: string,
  message?: string
): Promise<{ artifactKey: string; path: string }> {
  const artifactKey = `pending/${Date.now()}/${path.replace(/\//g, '_')}`;

  await env.ARTIFACTS.put(artifactKey, content, {
    customMetadata: {
      path,
      type: 'create',
      message: message || `Create ${path}`,
      timestamp: Date.now().toString(),
    },
  });

  return { artifactKey, path };
}

/**
 * Edit file content with find/replace
 */
export async function editFileTool(
  env: Env,
  projectId: string,
  filePath: string,
  oldString: string,
  newString: string
): Promise<{ artifactKey: string; diff: string; path: string } | null> {
  // Get current content
  const file = await readFileTool(env, projectId, filePath);

  if (!file) {
    return null;
  }

  if (!file.content.includes(oldString)) {
    throw new Error(`String not found in file: ${oldString.slice(0, 50)}...`);
  }

  const newContent = file.content.replaceAll(oldString, newString);
  const diff = createDiffTool(filePath, file.content, newContent);

  const artifactKey = `pending/${Date.now()}/${filePath.replace(/\//g, '_')}`;

  await env.ARTIFACTS.put(artifactKey, newContent, {
    customMetadata: {
      path: filePath,
      type: 'modify',
      diff,
      timestamp: Date.now().toString(),
    },
  });

  return { artifactKey, diff, path: filePath };
}

/**
 * Create a unified diff between two strings
 */
export function createDiffTool(
  path: string,
  oldContent: string,
  newContent: string
): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const diff: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
  ];

  // Simple diff algorithm - finds changes and creates hunks
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    // Find start of difference
    while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
    }

    if (i >= oldLines.length && j >= newLines.length) break;

    // Found a difference - create hunk
    const hunkStartOld = i + 1;
    const hunkStartNew = j + 1;
    const hunkLines: string[] = [];

    // Add context before (up to 3 lines)
    const contextStart = Math.max(0, i - 3);
    for (let c = contextStart; c < i; c++) {
      hunkLines.push(` ${oldLines[c]}`);
    }

    // Collect changed lines
    const changedOld: string[] = [];
    const changedNew: string[] = [];

    while (i < oldLines.length && j < newLines.length && oldLines[i] !== newLines[j]) {
      changedOld.push(oldLines[i]);
      changedNew.push(newLines[j]);
      i++;
      j++;
    }

    // Handle remaining old lines
    while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
      changedOld.push(oldLines[i]);
      i++;
    }

    // Handle remaining new lines
    while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
      changedNew.push(newLines[j]);
      j++;
    }

    // Add removed and added lines
    for (const line of changedOld) {
      hunkLines.push(`-${line}`);
    }
    for (const line of changedNew) {
      hunkLines.push(`+${line}`);
    }

    // Add context after (up to 3 lines)
    const contextEnd = Math.min(oldLines.length, i + 3);
    for (let c = i; c < contextEnd; c++) {
      if (oldLines[c] === newLines[j + (c - i)]) {
        hunkLines.push(` ${oldLines[c]}`);
      }
    }

    // Create hunk header
    const oldCount = changedOld.length + (contextEnd - i) + (i - contextStart);
    const newCount = changedNew.length + (contextEnd - i) + (i - contextStart);

    diff.push(`@@ -${hunkStartOld},${oldCount} +${hunkStartNew},${newCount} @@`);
    diff.push(...hunkLines);
  }

  return diff.join('\n');
}

/**
 * List all files in a project
 */
export async function listFilesTool(
  env: Env,
  projectId: string,
  pattern?: string
): Promise<Array<{ path: string; chunk_count: number }>> {
  let query = `
    SELECT f.relative_path as path, f.chunk_count
    FROM files f
    WHERE f.project_id = ?
  `;

  if (pattern) {
    query += ` AND f.relative_path LIKE ?`;
  }

  query += ` ORDER BY f.relative_path`;

  const stmt = pattern
    ? env.DB.prepare(query).bind(projectId, `%${pattern}%`)
    : env.DB.prepare(query).bind(projectId);

  const results = await stmt.all();

  return results.results as Array<{ path: string; chunk_count: number }>;
}

/**
 * Get file metadata
 */
export async function getFileMetadataTool(
  env: Env,
  projectId: string,
  filePath: string
): Promise<{
  path: string;
  chunk_count: number;
  content_hash: string;
  indexed_at: number | null;
} | null> {
  const file = await env.DB.prepare(`
    SELECT
      f.relative_path as path,
      f.chunk_count,
      f.content_hash,
      f.indexed_at
    FROM files f
    WHERE f.project_id = ? AND f.relative_path = ?
  `).bind(projectId, filePath).first();

  return file as {
    path: string;
    chunk_count: number;
    content_hash: string;
    indexed_at: number | null;
  } | null;
}

/**
 * Get pending changes from R2
 */
export async function getPendingChangesTool(
  env: Env
): Promise<Array<{
  key: string;
  path: string;
  type: string;
  timestamp: number;
}>> {
  const objects = await env.ARTIFACTS.list({ prefix: 'pending/' });

  return objects.objects.map((obj) => ({
    key: obj.key,
    path: obj.customMetadata?.path || 'unknown',
    type: obj.customMetadata?.type || 'unknown',
    timestamp: parseInt(obj.customMetadata?.timestamp || '0'),
  }));
}

/**
 * Clear pending changes
 */
export async function clearPendingChangesTool(env: Env): Promise<number> {
  const objects = await env.ARTIFACTS.list({ prefix: 'pending/' });

  await Promise.all(objects.objects.map((obj) => env.ARTIFACTS.delete(obj.key)));

  return objects.objects.length;
}

/**
 * Analyze code with LLM
 */
export async function analyzeCodeTool(
  env: Env,
  code: string,
  analysisType: 'bugs' | 'improvements' | 'security' | 'explain'
): Promise<string> {
  const prompts: Record<string, string> = {
    bugs: `Analyze this code for potential bugs, edge cases, and error conditions.
List each issue with:
- Line number or location
- Description of the issue
- Suggested fix

Code:
${code}`,
    improvements: `Suggest improvements for this code including:
- Performance optimizations
- Readability improvements
- Best practices
- Design pattern suggestions

Code:
${code}`,
    security: `Analyze this code for security vulnerabilities including:
- Injection vulnerabilities
- Authentication/authorization issues
- Data exposure risks
- Input validation issues

Code:
${code}`,
    explain: `Explain what this code does in detail:
- Overall purpose
- Key functions and their roles
- Data flow
- Important algorithms or patterns used

Code:
${code}`,
  };

  const result = await env.AI.run(env.REASONING_MODEL as any, {
    messages: [
      { role: 'user', content: prompts[analysisType] },
    ],
    max_tokens: 2048,
  });

  return result.response || 'Analysis failed';
}
