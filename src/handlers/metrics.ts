import type { Env, MetricsResponse } from '../types';
import { getEmbeddingRateLimit } from '../lib/embeddings';
import { getLLMRateLimit } from '../lib/llm';
import { jsonResponse } from '../lib/utils';

/**
 * Get usage metrics and rate limit status
 */
export async function handleMetrics(env: Env): Promise<Response> {
  // Get counts from D1
  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects) as projects,
      (SELECT COUNT(*) FROM files) as files,
      (SELECT COUNT(*) FROM chunks) as chunks,
      (SELECT COUNT(*) FROM conversations) as conversations
  `).first();

  // Get rate limit status
  const embeddingLimits = await getEmbeddingRateLimit(env);
  const llmLimits = await getLLMRateLimit(env);

  return jsonResponse({
    counts: {
      projects: (counts as any)?.projects || 0,
      files: (counts as any)?.files || 0,
      chunks: (counts as any)?.chunks || 0,
      conversations: (counts as any)?.conversations || 0,
    },
    rate_limits: {
      embeddings: embeddingLimits,
      llm: llmLimits,
    },
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Health check endpoint
 */
export async function handleHealth(env: Env): Promise<Response> {
  try {
    // Quick D1 connectivity check
    await env.DB.prepare('SELECT 1').first();

    return jsonResponse({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return jsonResponse({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, 503);
  }
}
