/**
 * Claude Agents - Distributed Agentic Coding System
 *
 * Main entry point that handles:
 * - REST API for project management and RAG queries
 * - MCP server for Claude CLI integration
 * - Durable Objects for stateful agents
 */

import type { Env } from './types';
import { handleQuery } from './handlers/query';
import { handleSearch } from './handlers/search';
import { handleIndex, handleIndexProgress } from './handlers/index';
import { handleListProjects, handleGetProject, handleDeleteProject, handleListProjectFiles } from './handlers/projects';
import { handleMetrics, handleHealth } from './handlers/metrics';
import { jsonResponse, errorResponse } from './lib/utils';
import { createMcpServer } from './mcp/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

// Export Durable Objects
export { ProjectAgent } from './do/ProjectAgent';
export { CodingAgent } from './agents/CodingAgent';

// CORS configuration - Use ALLOWED_ORIGINS env var or default to restrictive list
const DEFAULT_ALLOWED_ORIGINS = [
  'https://claude.ai',
  'https://console.anthropic.com',
  'http://localhost:3000',
  'http://localhost:8787',
];

function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : DEFAULT_ALLOWED_ORIGINS;

  // Check if origin is allowed
  const isAllowed = allowedOrigins.includes(origin) || allowedOrigins.includes('*');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, mcp-session-id, mcp-protocol-version',
    'Access-Control-Expose-Headers': 'mcp-session-id',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function withCors(response: Response, request: Request, env: Env): Response {
  const newResponse = new Response(response.body, response);
  const corsHeaders = getCorsHeaders(request, env);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

// Rate limiting helper using KV
async function checkRateLimit(env: Env, key: string, maxRequests: number = 100, windowMs: number = 60000): Promise<boolean> {
  const now = Date.now();
  const rateLimitKey = `ratelimit:${key}`;

  const data = await env.KV.get(rateLimitKey, { type: 'json' }) as { count: number; resetAt: number } | null;

  if (!data || now > data.resetAt) {
    // New window
    await env.KV.put(rateLimitKey, JSON.stringify({ count: 1, resetAt: now + windowMs }), { expirationTtl: Math.ceil(windowMs / 1000) + 60 });
    return true;
  }

  if (data.count >= maxRequests) {
    return false; // Rate limited
  }

  // Increment
  await env.KV.put(rateLimitKey, JSON.stringify({ count: data.count + 1, resetAt: data.resetAt }), { expirationTtl: Math.ceil((data.resetAt - now) / 1000) + 60 });
  return true;
}

// Input validation helpers
function sanitizePath(path: string): string | null {
  // Prevent path traversal
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
    return null;
  }
  return path;
}

function validateQueryParams(params: Record<string, unknown>): { valid: boolean; error?: string } {
  if (params.top_k !== undefined) {
    const topK = Number(params.top_k);
    if (isNaN(topK) || topK < 1 || topK > 100) {
      return { valid: false, error: 'top_k must be between 1 and 100' };
    }
  }
  if (params.query !== undefined && typeof params.query === 'string') {
    if (params.query.length > 2000) {
      return { valid: false, error: 'query must be under 2000 characters' };
    }
  }
  return { valid: true };
}

export default {
  /**
   * Scheduled handler - runs daily to clean up and report stats
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled maintenance...');

    try {
      // Get stats
      const stats = await env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM projects) as projects,
          (SELECT COUNT(*) FROM files) as files,
          (SELECT COUNT(*) FROM chunks) as chunks,
          (SELECT COUNT(*) FROM conversations) as conversations
      `).first();

      // Find stale projects (not indexed in 7 days)
      const staleThreshold = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
      const staleProjects = await env.DB.prepare(
        `SELECT id, name, last_indexed_at FROM projects
         WHERE last_indexed_at < ? OR last_indexed_at IS NULL`
      ).bind(staleThreshold).all();

      // Clean up old conversations (>30 days, no recent messages)
      const oldConvThreshold = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
      await env.DB.prepare(
        `DELETE FROM conversations WHERE created_at < ? AND message_count < 5`
      ).bind(oldConvThreshold).run();

      // Clean up old pending changes (>7 days)
      const oldArtifacts = await env.ARTIFACTS.list({ prefix: 'pending/' });
      const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      for (const obj of oldArtifacts.objects) {
        const timestamp = parseInt(obj.customMetadata?.timestamp || '0');
        if (timestamp && timestamp < weekAgo) {
          await env.ARTIFACTS.delete(obj.key);
        }
      }

      // Log maintenance report
      console.log('Maintenance complete:', {
        stats,
        stale_projects: staleProjects.results.length,
        timestamp: new Date().toISOString(),
      });

      // Store last maintenance run
      await env.KV.put('last_maintenance', JSON.stringify({
        timestamp: new Date().toISOString(),
        stats,
        stale_projects: staleProjects.results.map((p: any) => p.name),
      }));

    } catch (error) {
      console.error('Scheduled maintenance error:', error);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request, env) });
    }

    try {
      // Get client IP for rate limiting
      const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';

      // MCP Server endpoint - for Claude CLI integration
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        // SECURITY: API_KEY is REQUIRED for MCP endpoint
        if (!env.API_KEY) {
          return withCors(new Response(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Server misconfigured: API_KEY not set' },
            id: null,
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }), request, env);
        }

        // Authenticate MCP requests
        const authHeader = request.headers.get('Authorization');
        const apiKeyHeader = request.headers.get('X-API-Key');
        const authToken = authHeader?.replace('Bearer ', '') || apiKeyHeader;

        if (!authToken || authToken !== env.API_KEY) {
          return withCors(new Response(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized: Invalid or missing API key' },
            id: null,
          }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }), request, env);
        }

        // Rate limit MCP requests (100 req/min per IP)
        if (!(await checkRateLimit(env, `mcp:${clientIP}`, 100, 60000))) {
          return withCors(new Response(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Rate limit exceeded. Try again later.' },
            id: null,
          }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }), request, env);
        }

        const mcpServer = createMcpServer(env);
        const transport = new WebStandardStreamableHTTPServerTransport();
        await mcpServer.connect(transport);
        return withCors(await transport.handleRequest(request), request, env);
      }

      // API Routes
      if (path.startsWith('/api/')) {
        const apiPath = path.replace('/api', '');

        // Rate limit API requests (200 req/min per IP for reads, 50 for writes)
        const isWrite = method === 'POST' || method === 'DELETE';
        const rateLimit = isWrite ? 50 : 200;
        if (!(await checkRateLimit(env, `api:${clientIP}`, rateLimit, 60000))) {
          return withCors(errorResponse('Rate limit exceeded. Try again later.', 429), request, env);
        }

        // Health check (no auth required)
        if (apiPath === '/health' && method === 'GET') {
          return withCors(await handleHealth(env), request, env);
        }

        // Metrics (no auth required)
        if (apiPath === '/metrics' && method === 'GET') {
          return withCors(await handleMetrics(env), request, env);
        }

        // All other API endpoints require authentication
        if (env.API_KEY) {
          const authHeader = request.headers.get('Authorization');
          const apiKeyHeader = request.headers.get('X-API-Key');
          const authToken = authHeader?.replace('Bearer ', '') || apiKeyHeader;

          if (!authToken || authToken !== env.API_KEY) {
            return withCors(errorResponse('Unauthorized: Invalid or missing API key', 401), request, env);
          }
        }

        // Stale projects (need re-indexing)
        if (apiPath === '/stale' && method === 'GET') {
          const daysParam = url.searchParams.get('days') || '7';
          const days = parseInt(daysParam);
          const threshold = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

          const stale = await env.DB.prepare(
            `SELECT id, name, path, last_indexed_at,
                    (? - last_indexed_at) / 86400 as days_stale
             FROM projects
             WHERE last_indexed_at < ? OR last_indexed_at IS NULL
             ORDER BY last_indexed_at ASC`
          ).bind(Math.floor(Date.now() / 1000), threshold).all();

          return withCors(jsonResponse({
            stale_projects: stale.results,
            threshold_days: days,
            count: stale.results.length,
          }), request, env);
        }

        // Query (RAG) - with input validation
        if (apiPath === '/query' && method === 'POST') {
          return withCors(await handleQuery(request, env), request, env);
        }

        // Search (vector only)
        if (apiPath === '/search' && method === 'POST') {
          return withCors(await handleSearch(request, env), request, env);
        }

        // Index project
        if (apiPath === '/index' && method === 'POST') {
          return withCors(await handleIndex(request, env), request, env);
        }

        // Index progress
        if (apiPath.startsWith('/index/') && method === 'GET') {
          const projectId = apiPath.replace('/index/', '');
          return withCors(await handleIndexProgress(projectId, env), request, env);
        }

        // List projects
        if (apiPath === '/projects' && method === 'GET') {
          return withCors(await handleListProjects(env), request, env);
        }

        // Get/delete single project
        if (apiPath.startsWith('/projects/') && !apiPath.includes('/files')) {
          const projectId = apiPath.replace('/projects/', '');

          if (method === 'GET') {
            return withCors(await handleGetProject(projectId, env), request, env);
          }

          if (method === 'DELETE') {
            return withCors(await handleDeleteProject(projectId, env), request, env);
          }
        }

        // List project files
        if (apiPath.match(/^\/projects\/[^/]+\/files$/) && method === 'GET') {
          const projectId = apiPath.replace('/projects/', '').replace('/files', '');
          return withCors(await handleListProjectFiles(projectId, env), request, env);
        }

        // Pending changes
        if (apiPath === '/pending' && method === 'GET') {
          const objects = await env.ARTIFACTS.list({ prefix: 'pending/' });
          const changes = objects.objects.map((obj) => ({
            key: obj.key,
            path: obj.customMetadata?.path,
            type: obj.customMetadata?.type,
            timestamp: obj.customMetadata?.timestamp,
          }));
          return withCors(jsonResponse({ pending_changes: changes, count: changes.length }), request, env);
        }

        // Clear pending changes
        if (apiPath === '/pending' && method === 'DELETE') {
          const objects = await env.ARTIFACTS.list({ prefix: 'pending/' });
          await Promise.all(objects.objects.map((obj) => env.ARTIFACTS.delete(obj.key)));
          return withCors(jsonResponse({ cleared: objects.objects.length }), request, env);
        }

        return withCors(errorResponse('Not found', 404), request, env);
      }

      // Root - API documentation
      if (path === '/' && method === 'GET') {
        return withCors(jsonResponse({
          name: 'claude-agents',
          version: '2.0.0',
          description: 'Distributed agentic coding system with Claude CLI integration',
          mcp_endpoint: '/mcp',
          endpoints: {
            // MCP
            'POST /mcp': 'MCP server for Claude CLI integration',
            // RAG
            'POST /api/query': 'RAG query with LLM response',
            'POST /api/search': 'Direct vector search',
            // Projects
            'POST /api/index': 'Index project files',
            'GET /api/index/:projectId': 'Get indexing progress',
            'GET /api/projects': 'List all projects',
            'GET /api/projects/:id': 'Get project details',
            'DELETE /api/projects/:id': 'Delete project',
            'GET /api/projects/:id/files': 'List project files',
            // Pending changes
            'GET /api/pending': 'List pending file changes',
            'DELETE /api/pending': 'Clear pending changes',
            // System
            'GET /api/metrics': 'Usage statistics',
            'GET /api/health': 'Health check',
            'GET /api/stale': 'List stale projects',
          },
          mcp_tools: [
            'code_search - Semantic search over indexed codebase',
            'read_file - Read file content',
            'write_file - Stage file for commit',
            'edit_file - Edit file with diff',
            'list_pending_changes - List staged changes',
            'commit_changes - Commit to GitHub',
            'create_branch - Create Git branch',
            'create_pull_request - Create GitHub PR',
            'list_projects - List indexed projects',
            'generate_code - Generate code with AI',
            'analyze_code - Analyze code for bugs/improvements',
          ],
          examples: {
            query: {
              method: 'POST',
              path: '/api/query',
              body: {
                query: 'How does the authentication work?',
                project_id: 'optional-project-id',
                top_k: 10,
              },
            },
            mcp_config: {
              description: 'Add to Claude CLI config (~/.claude/mcp.json)',
              config: {
                'mcpServers': {
                  'claude-agents': {
                    'url': 'https://claude-agents.<your-subdomain>.workers.dev/mcp'
                  }
                }
              }
            },
          },
        }), request, env);
      }

      return withCors(errorResponse('Not found', 404), request, env);

    } catch (error) {
      console.error('Unhandled error:', error);
      return withCors(errorResponse(
        error instanceof Error ? error.message : 'Internal server error',
        500
      ), request, env);
    }
  },
};
