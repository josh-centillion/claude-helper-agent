import type { Env, SearchRequest, SearchResult } from '../types';
import { generateQueryEmbedding, searchVectors } from '../lib/embeddings';
import { jsonResponse, errorResponse } from '../lib/utils';

/**
 * Handle direct vector search requests (without LLM)
 */
export async function handleSearch(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as SearchRequest;

    if (!body.query || body.query.trim().length === 0) {
      return errorResponse('Query is required');
    }

    const { query, project_id, top_k = 10, file_type } = body;

    // Generate query embedding
    const queryEmbedding = await generateQueryEmbedding(env, query);

    // Search for relevant chunks
    const vectorResults = await searchVectors(env, queryEmbedding, {
      topK: top_k,
      projectId: project_id,
      fileType: file_type,
    });

    if (vectorResults.length === 0) {
      return jsonResponse({
        results: [],
        message: 'No matching code found',
      });
    }

    // Fetch chunk content from D1
    const chunkIds = vectorResults.map(r => r.id);
    const placeholders = chunkIds.map(() => '?').join(',');
    const chunksResult = await env.DB.prepare(
      `SELECT c.*, f.relative_path, p.name as project_name
       FROM chunks c
       JOIN files f ON c.file_id = f.id
       JOIN projects p ON c.project_id = p.id
       WHERE c.id IN (${placeholders})`
    ).bind(...chunkIds).all();

    // Build results map
    const chunksMap = new Map<string, any>();
    for (const chunk of chunksResult.results) {
      chunksMap.set((chunk as any).id, chunk);
    }

    // Build response
    const results: SearchResult[] = vectorResults.map(vr => {
      const chunk = chunksMap.get(vr.id);
      return {
        chunk_id: vr.id,
        content: chunk ? (chunk as any).content : '',
        file_path: chunk ? (chunk as any).relative_path : vr.metadata.file_path,
        project_name: chunk ? (chunk as any).project_name : '',
        start_line: vr.metadata.start_line,
        end_line: vr.metadata.end_line,
        score: vr.score,
      };
    });

    // Cache results for frequent queries
    const cacheKey = `search:${query}:${project_id || 'all'}:${top_k}`;
    await env.KV.put(cacheKey, JSON.stringify(results), {
      expirationTtl: 300, // 5 minutes
    });

    return jsonResponse({ results });

  } catch (error) {
    console.error('Search error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Search failed',
      500
    );
  }
}
