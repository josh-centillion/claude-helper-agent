import type { Env, SourceReference } from '../types';
import { getRateLimitKey } from './utils';

const DAILY_LLM_LIMIT = 3000; // 30% of 10K neurons for LLM

export interface LLMResponse {
  answer: string;
  tokensUsed?: number;
}

/**
 * Generate a response using the LLM with RAG context
 */
export async function generateRAGResponse(
  env: Env,
  query: string,
  context: Array<{
    content: string;
    filePath: string;
    projectName: string;
    startLine: number;
    endLine: number;
  }>,
  options: {
    conversationHistory?: Array<{ role: string; content: string }>;
    useFastModel?: boolean;
  } = {}
): Promise<LLMResponse> {
  // Check rate limit
  const rateLimitKey = getRateLimitKey('query');
  const currentCount = parseInt(await env.KV.get(rateLimitKey) || '0');

  if (currentCount >= DAILY_LLM_LIMIT) {
    throw new Error(`Daily LLM query limit reached (${DAILY_LLM_LIMIT}). Try again tomorrow.`);
  }

  // Build context string
  const contextStr = context.map((c, i) =>
    `[Source ${i + 1}] ${c.projectName}/${c.filePath}:${c.startLine}-${c.endLine}\n\`\`\`\n${c.content}\n\`\`\``
  ).join('\n\n');

  // Build messages
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    {
      role: 'system',
      content: `You are a helpful code assistant with access to the user's codebase. Answer questions based on the provided code context.

Guidelines:
- Be concise and direct
- Reference specific files and line numbers when relevant
- If the context doesn't contain enough information, say so
- Provide code examples when helpful
- Format code blocks with appropriate language tags`,
    },
  ];

  // Add conversation history if provided
  if (options.conversationHistory) {
    for (const msg of options.conversationHistory.slice(-6)) { // Last 6 messages
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }
  }

  // Add the current query with context
  messages.push({
    role: 'user',
    content: `Context from codebase:\n${contextStr}\n\nQuestion: ${query}`,
  });

  const model = options.useFastModel ? env.FAST_MODEL : env.LLM_MODEL;

  const result = await env.AI.run(model as any, {
    messages,
    max_tokens: 1024,
  });

  // Update rate limit counter
  await env.KV.put(rateLimitKey, String(currentCount + 1), {
    expirationTtl: 86400, // 24 hours
  });

  return {
    answer: result.response || 'Unable to generate response.',
  };
}

/**
 * Generate a summary or title for a conversation
 */
export async function generateConversationTitle(
  env: Env,
  firstMessage: string
): Promise<string> {
  const result = await env.AI.run(env.FAST_MODEL as any, {
    messages: [
      {
        role: 'system',
        content: 'Generate a very short title (max 6 words) for this conversation. Return only the title, no quotes or punctuation.',
      },
      {
        role: 'user',
        content: firstMessage,
      },
    ],
    max_tokens: 20,
  });

  return result.response?.trim().slice(0, 50) || 'New Conversation';
}

/**
 * Get LLM rate limit status
 */
export async function getLLMRateLimit(env: Env): Promise<{
  used: number;
  limit: number;
  remaining: number;
}> {
  const rateLimitKey = getRateLimitKey('query');
  const used = parseInt(await env.KV.get(rateLimitKey) || '0');

  return {
    used,
    limit: DAILY_LLM_LIMIT,
    remaining: Math.max(0, DAILY_LLM_LIMIT - used),
  };
}
