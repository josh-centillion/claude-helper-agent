import type { Env, VectorMetadata } from '../types';
import { getRateLimitKey } from './utils';

const DAILY_EMBEDDING_LIMIT = 7000; // 70% of 10K neurons for embeddings
const BATCH_SIZE = 100;

export interface EmbeddingResult {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

/**
 * Generate embeddings for text chunks using Workers AI
 */
export async function generateEmbeddings(
  env: Env,
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Check rate limit
  const rateLimitKey = getRateLimitKey('embedding');
  const currentCount = parseInt(await env.KV.get(rateLimitKey) || '0');

  if (currentCount + texts.length > DAILY_EMBEDDING_LIMIT) {
    throw new Error(`Daily embedding limit reached (${DAILY_EMBEDDING_LIMIT}). Try again tomorrow.`);
  }

  const result = await env.AI.run(env.EMBEDDING_MODEL as any, {
    text: texts,
  });

  // Update rate limit counter
  await env.KV.put(rateLimitKey, String(currentCount + texts.length), {
    expirationTtl: 86400, // 24 hours
  });

  return result.data;
}

/**
 * Generate embedding for a single query
 */
export async function generateQueryEmbedding(
  env: Env,
  query: string
): Promise<number[]> {
  const [embedding] = await generateEmbeddings(env, [query]);
  return embedding;
}

/**
 * Upsert vectors to Vectorize in batches
 */
export async function upsertVectors(
  env: Env,
  vectors: EmbeddingResult[]
): Promise<{ inserted: number; errors: number }> {
  let inserted = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);

    try {
      const vectorizeVectors = batch.map(v => ({
        id: v.id,
        values: v.values,
        metadata: v.metadata as Record<string, any>,
      }));

      await env.VECTORIZE.upsert(vectorizeVectors);
      inserted += batch.length;
    } catch (error) {
      console.error('Vector upsert error:', error);
      errors += batch.length;
    }
  }

  return { inserted, errors };
}

/**
 * Search vectors by query embedding
 */
export async function searchVectors(
  env: Env,
  queryEmbedding: number[],
  options: {
    topK?: number;
    projectId?: string;
    fileType?: string;
  } = {}
): Promise<Array<{ id: string; score: number; metadata: VectorMetadata }>> {
  const { topK = 10, projectId, fileType } = options;

  const filter: Record<string, string> = {};
  if (projectId) filter.project_id = projectId;
  if (fileType) filter.file_type = fileType;

  const results = await env.VECTORIZE.query(queryEmbedding, {
    topK,
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    returnMetadata: 'all',
  });

  return results.matches.map(match => ({
    id: match.id,
    score: match.score,
    metadata: match.metadata as unknown as VectorMetadata,
  }));
}

/**
 * Delete vectors by project ID
 */
export async function deleteProjectVectors(
  env: Env,
  projectId: string
): Promise<void> {
  // Get all chunk IDs for this project
  const chunks = await env.DB.prepare(
    'SELECT id FROM chunks WHERE project_id = ?'
  ).bind(projectId).all();

  if (chunks.results.length === 0) return;

  // Delete vectors in batches of 100 (Vectorize limit)
  const chunkIds = chunks.results.map((c: any) => c.id);
  for (let i = 0; i < chunkIds.length; i += 100) {
    const batch = chunkIds.slice(i, i + 100);
    try {
      await env.VECTORIZE.deleteByIds(batch);
    } catch (error) {
      console.error(`Vector delete error for batch ${i}:`, error);
      // Continue with remaining batches
    }
  }
}

/**
 * Get embedding rate limit status
 */
export async function getEmbeddingRateLimit(env: Env): Promise<{
  used: number;
  limit: number;
  remaining: number;
}> {
  const rateLimitKey = getRateLimitKey('embedding');
  const used = parseInt(await env.KV.get(rateLimitKey) || '0');

  return {
    used,
    limit: DAILY_EMBEDDING_LIMIT,
    remaining: Math.max(0, DAILY_EMBEDDING_LIMIT - used),
  };
}
