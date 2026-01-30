import type { Env, QueryRequest, QueryResponse, SourceReference, Chunk } from '../types';
import { generateQueryEmbedding, searchVectors } from '../lib/embeddings';
import { generateRAGResponse, generateConversationTitle } from '../lib/llm';
import { generateId, jsonResponse, errorResponse } from '../lib/utils';

/**
 * Handle RAG query requests
 */
export async function handleQuery(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as QueryRequest;

    if (!body.query || body.query.trim().length === 0) {
      return errorResponse('Query is required');
    }

    const { query, project_id, conversation_id, top_k = 10 } = body;

    // Generate query embedding
    const queryEmbedding = await generateQueryEmbedding(env, query);

    // Search for relevant chunks
    const vectorResults = await searchVectors(env, queryEmbedding, {
      topK: top_k,
      projectId: project_id,
    });

    if (vectorResults.length === 0) {
      return jsonResponse({
        answer: "I couldn't find any relevant code in the indexed projects for your query. Try indexing more files or rephrasing your question.",
        sources: [],
        conversation_id: conversation_id || generateId(),
      } as QueryResponse);
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

    // Build context for LLM
    const chunksMap = new Map<string, any>();
    for (const chunk of chunksResult.results) {
      chunksMap.set((chunk as any).id, chunk);
    }

    const context = vectorResults
      .map(vr => {
        const chunk = chunksMap.get(vr.id);
        if (!chunk) return null;
        return {
          content: (chunk as any).content,
          filePath: (chunk as any).relative_path,
          projectName: (chunk as any).project_name,
          startLine: (chunk as any).start_line,
          endLine: (chunk as any).end_line,
        };
      })
      .filter(Boolean) as Array<{
        content: string;
        filePath: string;
        projectName: string;
        startLine: number;
        endLine: number;
      }>;

    // Get conversation history if provided
    let conversationHistory: Array<{ role: string; content: string }> = [];
    let currentConversationId = conversation_id;

    if (conversation_id) {
      const messagesResult = await env.DB.prepare(
        `SELECT role, content FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC
         LIMIT 10`
      ).bind(conversation_id).all();
      conversationHistory = messagesResult.results as any[];
    } else {
      // Create new conversation
      currentConversationId = generateId();
      const title = await generateConversationTitle(env, query);
      await env.DB.prepare(
        `INSERT INTO conversations (id, project_id, title, message_count)
         VALUES (?, ?, ?, 0)`
      ).bind(currentConversationId, project_id || null, title).run();
    }

    // Generate LLM response
    const llmResponse = await generateRAGResponse(env, query, context, {
      conversationHistory,
    });

    // Build source references
    const sources: SourceReference[] = vectorResults.map(vr => {
      const chunk = chunksMap.get(vr.id);
      return {
        chunk_id: vr.id,
        file_path: chunk ? (chunk as any).relative_path : vr.metadata.file_path,
        project_name: chunk ? (chunk as any).project_name : '',
        start_line: vr.metadata.start_line,
        end_line: vr.metadata.end_line,
        score: vr.score,
      };
    });

    // Save messages to conversation
    const userMessageId = generateId();
    const assistantMessageId = generateId();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, role, content)
         VALUES (?, ?, 'user', ?)`
      ).bind(userMessageId, currentConversationId, query),
      env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, sources)
         VALUES (?, ?, 'assistant', ?, ?)`
      ).bind(assistantMessageId, currentConversationId, llmResponse.answer, JSON.stringify(sources)),
      env.DB.prepare(
        `UPDATE conversations SET message_count = message_count + 2
         WHERE id = ?`
      ).bind(currentConversationId),
    ]);

    return jsonResponse({
      answer: llmResponse.answer,
      sources,
      conversation_id: currentConversationId,
      tokens_used: llmResponse.tokensUsed,
    } as QueryResponse);

  } catch (error) {
    console.error('Query error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Query failed',
      500
    );
  }
}
