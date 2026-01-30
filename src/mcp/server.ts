/**
 * MCP Server for Claude CLI Integration
 *
 * Exposes the CodingAgent tools via MCP protocol so Claude CLI
 * can dispatch tasks to the Cloudflare-hosted agent.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import puppeteer from '@cloudflare/puppeteer';
import type { Env } from '../types';

/**
 * Create MCP server with all coding tools
 */
export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'claude-agents',
    version: '2.0.0',
  });

  // Tool: Search codebase
  server.registerTool(
    'code_search',
    {
      description: 'Search the indexed codebase using semantic search. Returns relevant code chunks with file paths and line numbers.',
      inputSchema: {
        query: z.string().describe('Natural language search query'),
        project_id: z.string().optional().describe('Filter to specific project'),
        top_k: z.number().optional().default(10).describe('Number of results to return'),
      },
    },
    async ({ query, project_id, top_k }) => {
      const embedding = await env.AI.run(env.EMBEDDING_MODEL as any, { text: query });

      const results = await env.VECTORIZE.query(embedding.data[0], {
        topK: top_k || 10,
        filter: project_id ? { project_id } : undefined,
        returnMetadata: 'all',
      });

      const chunks = await Promise.all(
        results.matches.map(async (match) => {
          const chunk = await env.DB.prepare(
            'SELECT c.content, c.start_line, c.end_line, f.relative_path, p.name as project_name FROM chunks c JOIN files f ON c.file_id = f.id JOIN projects p ON c.project_id = p.id WHERE c.id = ?'
          ).bind(match.id).first();
          return { ...chunk, score: match.score };
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ results: chunks, total: chunks.length }, null, 2),
        }],
      };
    }
  );

  // Tool: Read file
  server.registerTool(
    'read_file',
    {
      description: 'Read the contents of a file from the indexed codebase or GitHub.',
      inputSchema: {
        path: z.string().describe('File path relative to project root'),
        project_id: z.string().describe('Project ID'),
        github_owner: z.string().optional().describe('GitHub owner for direct fetch'),
        github_repo: z.string().optional().describe('GitHub repo for direct fetch'),
        github_ref: z.string().optional().describe('Git ref (branch/tag/sha)'),
      },
    },
    async ({ path, project_id, github_owner, github_repo, github_ref }) => {
      // Try indexed content first - fetch chunks individually to avoid GROUP_CONCAT limit
      const chunks = await env.DB.prepare(
        `SELECT c.content, c.start_line
         FROM files f
         JOIN chunks c ON f.id = c.file_id
         WHERE f.project_id = ? AND f.relative_path = ?
         ORDER BY c.start_line`
      ).bind(project_id, path).all();

      if (chunks.results.length > 0) {
        const content = chunks.results.map((c: any) => c.content).join('\n');
        return {
          content: [{
            type: 'text',
            text: content,
          }],
        };
      }

      // Try GitHub if configured
      if (github_owner && github_repo && env.GITHUB_TOKEN) {
        const response = await fetch(
          `https://api.github.com/repos/${github_owner}/${github_repo}/contents/${path}${github_ref ? `?ref=${github_ref}` : ''}`,
          {
            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: 'application/vnd.github.v3.raw',
            },
          }
        );

        if (response.ok) {
          const content = await response.text();
          return {
            content: [{ type: 'text', text: content }],
          };
        }
      }

      return {
        content: [{ type: 'text', text: `File not found: ${path}` }],
        isError: true,
      };
    }
  );

  // Tool: Write file (stages change)
  server.registerTool(
    'write_file',
    {
      description: 'Write content to a file. This stages the change for later commit.',
      inputSchema: {
        path: z.string().describe('File path'),
        content: z.string().describe('File content to write'),
        message: z.string().optional().describe('Description of the change'),
      },
    },
    async ({ path, content, message }) => {
      const artifactKey = `pending/${Date.now()}/${path}`;
      await env.ARTIFACTS.put(artifactKey, content, {
        customMetadata: { path, message: message || 'File write', type: 'create' },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            staged: true,
            path,
            artifactKey,
            message: `File staged: ${path}. Use commit_changes to push to GitHub.`,
          }),
        }],
      };
    }
  );

  // Tool: Edit file with diff
  server.registerTool(
    'edit_file',
    {
      description: 'Edit a file by specifying old and new content. Generates a diff and stages the change.',
      inputSchema: {
        path: z.string().describe('File path'),
        old_string: z.string().describe('Text to find and replace'),
        new_string: z.string().describe('Replacement text'),
        project_id: z.string().describe('Project ID to find current content'),
      },
    },
    async ({ path, old_string, new_string, project_id }) => {
      // Get current content - fetch chunks individually to avoid GROUP_CONCAT limit
      const chunks = await env.DB.prepare(
        `SELECT c.content, c.start_line
         FROM files f
         JOIN chunks c ON f.id = c.file_id
         WHERE f.project_id = ? AND f.relative_path = ?
         ORDER BY c.start_line`
      ).bind(project_id, path).all();

      if (chunks.results.length === 0) {
        return {
          content: [{ type: 'text', text: `File not found: ${path}` }],
          isError: true,
        };
      }

      const oldContent = chunks.results.map((c: any) => c.content).join('\n');
      if (!oldContent.includes(old_string)) {
        return {
          content: [{ type: 'text', text: `String not found in file: ${old_string.slice(0, 50)}...` }],
          isError: true,
        };
      }

      const newContent = oldContent.replaceAll(old_string, new_string);

      // Generate simple diff
      const diff = generateSimpleDiff(path, oldContent, newContent);

      const artifactKey = `pending/${Date.now()}/${path}`;
      await env.ARTIFACTS.put(artifactKey, newContent, {
        customMetadata: { path, type: 'modify', diff },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            staged: true,
            path,
            diff,
            message: `Edit staged: ${path}`,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: List pending changes
  server.registerTool(
    'list_pending_changes',
    {
      description: 'List all staged file changes waiting to be committed.',
      inputSchema: {},
    },
    async () => {
      const objects = await env.ARTIFACTS.list({ prefix: 'pending/' });

      const changes = await Promise.all(
        objects.objects.map(async (obj) => {
          const metadata = obj.customMetadata || {};
          return {
            key: obj.key,
            path: metadata.path,
            type: metadata.type,
            uploaded: obj.uploaded,
          };
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ pending_changes: changes, count: changes.length }, null, 2),
        }],
      };
    }
  );

  // Tool: Commit changes to GitHub
  server.registerTool(
    'commit_changes',
    {
      description: 'Commit all pending changes to GitHub. Creates a new commit on the specified branch.',
      inputSchema: {
        owner: z.string().describe('GitHub repository owner'),
        repo: z.string().describe('GitHub repository name'),
        branch: z.string().describe('Branch to commit to'),
        message: z.string().describe('Commit message'),
      },
    },
    async ({ owner, repo, branch, message }) => {
      if (!env.GITHUB_TOKEN) {
        return {
          content: [{ type: 'text', text: 'GitHub token not configured' }],
          isError: true,
        };
      }

      // Get all pending changes
      const objects = await env.ARTIFACTS.list({ prefix: 'pending/' });

      if (objects.objects.length === 0) {
        return {
          content: [{ type: 'text', text: 'No pending changes to commit' }],
          isError: true,
        };
      }

      // Get current commit SHA
      const refResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (!refResponse.ok) {
        return {
          content: [{ type: 'text', text: `Branch not found: ${branch}` }],
          isError: true,
        };
      }

      const refData = await refResponse.json() as any;
      const baseSha = refData.object.sha;

      // Get base tree
      const commitResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/commits/${baseSha}`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );
      const commitData = await commitResponse.json() as any;
      const baseTreeSha = commitData.tree.sha;

      // Create blobs for each file
      const treeItems = await Promise.all(
        objects.objects.map(async (obj) => {
          const content = await env.ARTIFACTS.get(obj.key);
          const text = await content?.text();
          const metadata = obj.customMetadata || {};

          // Create blob
          const blobResponse = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                content: text,
                encoding: 'utf-8',
              }),
            }
          );
          const blobData = await blobResponse.json() as any;

          return {
            path: metadata.path,
            mode: '100644',
            type: 'blob',
            sha: blobData.sha,
          };
        })
      );

      // Create tree
      const treeResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: treeItems,
          }),
        }
      );
      const treeData = await treeResponse.json() as any;

      // Create commit
      const newCommitResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/commits`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message,
            tree: treeData.sha,
            parents: [baseSha],
          }),
        }
      );
      const newCommitData = await newCommitResponse.json() as any;

      // Update branch ref
      await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sha: newCommitData.sha,
          }),
        }
      );

      // Clear pending changes
      await Promise.all(
        objects.objects.map((obj) => env.ARTIFACTS.delete(obj.key))
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            commit_sha: newCommitData.sha,
            message,
            files_committed: treeItems.length,
            branch,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: Create branch
  server.registerTool(
    'create_branch',
    {
      description: 'Create a new Git branch from the specified base branch.',
      inputSchema: {
        owner: z.string().describe('GitHub repository owner'),
        repo: z.string().describe('GitHub repository name'),
        branch_name: z.string().describe('Name for the new branch'),
        base_branch: z.string().optional().default('main').describe('Base branch to create from'),
      },
    },
    async ({ owner, repo, branch_name, base_branch }) => {
      if (!env.GITHUB_TOKEN) {
        return {
          content: [{ type: 'text', text: 'GitHub token not configured' }],
          isError: true,
        };
      }

      // Get base branch SHA
      const baseResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${base_branch}`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (!baseResponse.ok) {
        return {
          content: [{ type: 'text', text: `Base branch not found: ${base_branch}` }],
          isError: true,
        };
      }

      const baseData = await baseResponse.json() as any;

      // Create new branch
      const createResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ref: `refs/heads/${branch_name}`,
            sha: baseData.object.sha,
          }),
        }
      );

      if (!createResponse.ok) {
        const error = await createResponse.json() as any;
        return {
          content: [{ type: 'text', text: `Failed to create branch: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            branch: branch_name,
            base: base_branch,
            sha: baseData.object.sha,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: Create pull request
  server.registerTool(
    'create_pull_request',
    {
      description: 'Create a pull request on GitHub.',
      inputSchema: {
        owner: z.string().describe('GitHub repository owner'),
        repo: z.string().describe('GitHub repository name'),
        title: z.string().describe('PR title'),
        body: z.string().describe('PR description'),
        head: z.string().describe('Branch with changes'),
        base: z.string().optional().default('main').describe('Branch to merge into'),
      },
    },
    async ({ owner, repo, title, body, head, base }) => {
      if (!env.GITHUB_TOKEN) {
        return {
          content: [{ type: 'text', text: 'GitHub token not configured' }],
          isError: true,
        };
      }

      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title,
            body: `${body}\n\n---\n🤖 Created by Claude Agents`,
            head,
            base,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.json() as any;
        return {
          content: [{ type: 'text', text: `Failed to create PR: ${error.message}` }],
          isError: true,
        };
      }

      const pr = await response.json() as any;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            pr_number: pr.number,
            url: pr.html_url,
            title,
            head,
            base,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: List projects
  server.registerTool(
    'list_projects',
    {
      description: 'List all indexed projects in the system.',
      inputSchema: {},
    },
    async () => {
      const projects = await env.DB.prepare(
        'SELECT id, name, path, status, file_count, last_indexed_at FROM projects ORDER BY name'
      ).all();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(projects.results, null, 2),
        }],
      };
    }
  );

  // Tool: Generate code
  server.registerTool(
    'generate_code',
    {
      description: 'Generate code using AI based on a prompt and optional context.',
      inputSchema: {
        prompt: z.string().describe('Description of code to generate'),
        language: z.string().optional().describe('Programming language'),
        context: z.string().optional().describe('Additional context or existing code'),
      },
    },
    async ({ prompt, language, context }) => {
      const systemPrompt = `You are an expert code generator. Generate clean, well-documented ${language || ''} code.
${context ? `\nContext:\n${context}` : ''}

Guidelines:
- Write production-quality code
- Include appropriate error handling
- Follow best practices
- Be concise but complete
- Output ONLY the code, no explanations unless in comments`;

      const result = await env.AI.run(env.LLM_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
      });

      return {
        content: [{
          type: 'text',
          text: result.response || 'Failed to generate code',
        }],
      };
    }
  );

  // Tool: Analyze code
  server.registerTool(
    'analyze_code',
    {
      description: 'Analyze code for bugs, improvements, or security issues using a reasoning model.',
      inputSchema: {
        code: z.string().describe('Code to analyze'),
        analysis_type: z.enum(['bugs', 'improvements', 'security', 'general']).describe('Type of analysis'),
      },
    },
    async ({ code, analysis_type }) => {
      const prompts: Record<string, string> = {
        bugs: 'Analyze this code for potential bugs, edge cases, and error conditions. Be specific about issues found.',
        improvements: 'Suggest improvements for this code including performance optimizations, readability, and best practices.',
        security: 'Analyze this code for security vulnerabilities including injection, authentication issues, and data exposure.',
        general: 'Provide a comprehensive code review covering bugs, improvements, and best practices.',
      };

      const result = await env.AI.run(env.REASONING_MODEL as any, {
        messages: [
          { role: 'system', content: prompts[analysis_type] },
          { role: 'user', content: code },
        ],
        max_tokens: 2048,
      });

      return {
        content: [{
          type: 'text',
          text: result.response || 'Failed to analyze code',
        }],
      };
    }
  );

  // Tool: Explain error
  server.registerTool(
    'explain_error',
    {
      description: 'Analyze a stack trace or error message and explain what went wrong and how to fix it.',
      inputSchema: {
        error: z.string().describe('The error message or stack trace'),
        context: z.string().optional().describe('Additional context about what was being done'),
        language: z.string().optional().describe('Programming language for better context'),
      },
    },
    async ({ error, context, language }) => {
      const systemPrompt = `You are an expert debugger. Analyze the error and provide:
1. **What happened**: A clear explanation of the error
2. **Root cause**: The likely underlying issue
3. **How to fix**: Step-by-step solution
4. **Prevention**: How to avoid this in the future

${language ? `Language: ${language}` : ''}
${context ? `Context: ${context}` : ''}

Be specific and actionable.`;

      const result = await env.AI.run(env.REASONING_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: error },
        ],
        max_tokens: 2048,
      });

      return {
        content: [{
          type: 'text',
          text: result.response || 'Failed to analyze error',
        }],
      };
    }
  );

  // Tool: Summarize project
  server.registerTool(
    'summarize_project',
    {
      description: 'Get a high-level summary of an indexed project including structure, key files, and purpose.',
      inputSchema: {
        project_id: z.string().describe('Project ID to summarize'),
      },
    },
    async ({ project_id }) => {
      // Get project info
      const project = await env.DB.prepare(
        'SELECT id, name, path, file_count FROM projects WHERE id = ?'
      ).bind(project_id).first();

      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${project_id}` }],
          isError: true,
        };
      }

      // Get file list grouped by directory
      const files = await env.DB.prepare(
        'SELECT relative_path FROM files WHERE project_id = ? ORDER BY relative_path'
      ).bind(project_id).all();

      // Get sample chunks for understanding
      const sampleChunks = await env.DB.prepare(
        `SELECT c.content, f.relative_path
         FROM chunks c
         JOIN files f ON c.file_id = f.id
         WHERE c.project_id = ?
         AND (f.relative_path LIKE '%README%' OR f.relative_path LIKE '%index%' OR f.relative_path LIKE '%main%')
         LIMIT 5`
      ).bind(project_id).all();

      // Build structure
      const dirs = new Map<string, string[]>();
      for (const file of files.results as any[]) {
        const parts = file.relative_path.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir)!.push(parts[parts.length - 1]);
      }

      // Use AI to generate summary
      const contextText = sampleChunks.results.map((c: any) =>
        `--- ${c.relative_path} ---\n${c.content.slice(0, 500)}`
      ).join('\n\n');

      const structureText = Array.from(dirs.entries())
        .map(([dir, files]) => `${dir}/\n  ${files.slice(0, 10).join('\n  ')}${files.length > 10 ? `\n  ... (${files.length - 10} more)` : ''}`)
        .join('\n');

      const result = await env.AI.run(env.LLM_MODEL as any, {
        messages: [
          { role: 'system', content: 'You are a code analyst. Provide a concise project summary including: purpose, main technologies, key components, and how it works. Be specific but brief.' },
          { role: 'user', content: `Project: ${(project as any).name}\nFiles: ${(project as any).file_count}\n\nStructure:\n${structureText}\n\nSample code:\n${contextText}` },
        ],
        max_tokens: 1024,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            project: (project as any).name,
            path: (project as any).path,
            file_count: (project as any).file_count,
            structure: Object.fromEntries(dirs),
            summary: result.response,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: Find similar code
  server.registerTool(
    'find_similar_code',
    {
      description: 'Find code snippets similar to the provided code across all indexed projects.',
      inputSchema: {
        code: z.string().describe('Code snippet to find similar matches for'),
        top_k: z.number().optional().default(5).describe('Number of similar snippets to return'),
        project_id: z.string().optional().describe('Limit search to specific project'),
      },
    },
    async ({ code, top_k, project_id }) => {
      // Generate embedding for the code
      const embedding = await env.AI.run(env.EMBEDDING_MODEL as any, { text: code });

      const results = await env.VECTORIZE.query(embedding.data[0], {
        topK: top_k || 5,
        filter: project_id ? { project_id } : undefined,
        returnMetadata: 'all',
      });

      const similar = await Promise.all(
        results.matches.map(async (match) => {
          const chunk = await env.DB.prepare(
            `SELECT c.content, c.start_line, c.end_line, f.relative_path, p.name as project_name
             FROM chunks c
             JOIN files f ON c.file_id = f.id
             JOIN projects p ON c.project_id = p.id
             WHERE c.id = ?`
          ).bind(match.id).first();
          return { ...chunk, similarity: match.score };
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ similar_code: similar, count: similar.length }, null, 2),
        }],
      };
    }
  );

  // Tool: Refactor suggestion
  server.registerTool(
    'suggest_refactor',
    {
      description: 'Suggest how to refactor code with specific improvements and the refactored version.',
      inputSchema: {
        code: z.string().describe('Code to refactor'),
        goal: z.string().optional().describe('Specific refactoring goal (e.g., "extract function", "reduce complexity")'),
        language: z.string().optional().describe('Programming language'),
      },
    },
    async ({ code, goal, language }) => {
      const systemPrompt = `You are an expert code refactorer. ${goal ? `Goal: ${goal}` : 'Improve the code quality.'}
${language ? `Language: ${language}` : ''}

Provide:
1. **Issues identified**: What problems exist in the current code
2. **Refactoring strategy**: What changes will be made and why
3. **Refactored code**: The improved version
4. **Benefits**: What improvements were achieved

Output the refactored code in a code block.`;

      const result = await env.AI.run(env.LLM_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: code },
        ],
        max_tokens: 4096,
      });

      return {
        content: [{
          type: 'text',
          text: result.response || 'Failed to generate refactoring suggestion',
        }],
      };
    }
  );

  // Tool: Get project context
  server.registerTool(
    'get_project_context',
    {
      description: 'Get relevant context from a project for a specific task or question.',
      inputSchema: {
        question: z.string().describe('What you want to understand or accomplish'),
        project_id: z.string().describe('Project to search'),
        max_chunks: z.number().optional().default(10).describe('Maximum context chunks to return'),
      },
    },
    async ({ question, project_id, max_chunks }) => {
      // Generate embedding for the question
      const embedding = await env.AI.run(env.EMBEDDING_MODEL as any, { text: question });

      const results = await env.VECTORIZE.query(embedding.data[0], {
        topK: max_chunks || 10,
        filter: { project_id },
        returnMetadata: 'all',
      });

      const context = await Promise.all(
        results.matches.map(async (match) => {
          const chunk = await env.DB.prepare(
            `SELECT c.content, c.start_line, c.end_line, f.relative_path
             FROM chunks c
             JOIN files f ON c.file_id = f.id
             WHERE c.id = ?`
          ).bind(match.id).first();
          return {
            file: (chunk as any)?.relative_path,
            lines: `${(chunk as any)?.start_line}-${(chunk as any)?.end_line}`,
            content: (chunk as any)?.content,
            relevance: match.score,
          };
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            question,
            project_id,
            context_chunks: context,
            total: context.length,
          }, null, 2),
        }],
      };
    }
  );

  // ==================== CODE QUALITY TOOLS ====================

  // Tool: Lint code
  server.registerTool(
    'lint_code',
    {
      description: 'Analyze code for style issues, best practices, and potential improvements using AI-powered linting.',
      inputSchema: {
        code: z.string().describe('Code to lint'),
        language: z.string().describe('Programming language (typescript, javascript, python, etc.)'),
        rules: z.array(z.string()).optional().describe('Specific rules to check (e.g., ["no-unused-vars", "prefer-const"])'),
      },
    },
    async ({ code, language, rules }) => {
      const rulesList = rules?.length ? `Focus on these rules: ${rules.join(', ')}` : '';

      const systemPrompt = `You are an expert code linter for ${language}. Analyze the code and report issues in this format:

For each issue found:
- **Line X**: [severity: error|warning|info] [rule-name] Description

Categories to check:
1. **Errors**: Syntax errors, type errors, undefined variables
2. **Warnings**: Unused variables, deprecated APIs, potential bugs
3. **Style**: Inconsistent formatting, naming conventions
4. **Best Practices**: Modern syntax, performance, security

${rulesList}

End with a summary: X errors, Y warnings, Z style issues.
If the code is clean, say "No issues found."`;

      const result = await env.AI.run(env.LLM_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: code },
        ],
        max_tokens: 2048,
      });

      return {
        content: [{
          type: 'text',
          text: result.response || 'Failed to lint code',
        }],
      };
    }
  );

  // Tool: Run tests (simulated via AI analysis)
  server.registerTool(
    'run_tests',
    {
      description: 'Analyze test files and predict test outcomes. Can also generate test cases for code.',
      inputSchema: {
        code: z.string().describe('Code to test OR test file content'),
        mode: z.enum(['analyze', 'generate', 'coverage']).describe('analyze: predict test results, generate: create tests, coverage: identify untested code'),
        test_framework: z.string().optional().describe('Test framework (jest, vitest, pytest, etc.)'),
      },
    },
    async ({ code, mode, test_framework }) => {
      const framework = test_framework || 'jest';

      const prompts: Record<string, string> = {
        analyze: `You are a test analyzer. Given this test file, predict which tests will pass or fail and why.
For each test:
- ✅ PASS: [test name] - reason
- ❌ FAIL: [test name] - expected failure reason
- ⚠️ SKIP: [test name] - reason if skipped

End with: Expected: X pass, Y fail, Z skip`,

        generate: `You are a test generator for ${framework}. Generate comprehensive test cases for this code.
Include:
1. Happy path tests
2. Edge cases (empty inputs, nulls, boundaries)
3. Error handling tests
4. Integration points

Output valid ${framework} test code with describe/it blocks.`,

        coverage: `You are a test coverage analyzer. Identify untested code paths in this implementation.
List:
1. **Untested functions**: Functions with no apparent test coverage
2. **Untested branches**: if/else paths not covered
3. **Edge cases missing**: Boundary conditions not tested
4. **Error paths**: Exception handling not tested

Provide specific line numbers and suggest test cases for each gap.`,
      };

      const result = await env.AI.run(env.REASONING_MODEL as any, {
        messages: [
          { role: 'system', content: prompts[mode] },
          { role: 'user', content: code },
        ],
        max_tokens: 4096,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mode,
            framework,
            analysis: result.response,
          }, null, 2),
        }],
      };
    }
  );

  // ==================== GITHUB TOOLS ====================

  // Tool: Review PR
  server.registerTool(
    'review_pr',
    {
      description: 'Fetch and review a GitHub Pull Request. Provides code review feedback.',
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
        pr_number: z.number().describe('Pull request number'),
        focus: z.enum(['security', 'performance', 'bugs', 'style', 'all']).optional().default('all').describe('Review focus area'),
      },
    },
    async ({ owner, repo, pr_number, focus }) => {
      if (!env.GITHUB_TOKEN) {
        return {
          content: [{ type: 'text', text: 'GitHub token not configured' }],
          isError: true,
        };
      }

      // Fetch PR details
      const prResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pr_number}`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (!prResponse.ok) {
        return {
          content: [{ type: 'text', text: `PR not found: ${owner}/${repo}#${pr_number}` }],
          isError: true,
        };
      }

      const pr = await prResponse.json() as any;

      // Fetch PR diff
      const diffResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pr_number}`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3.diff',
          },
        }
      );

      const diff = await diffResponse.text();

      // Fetch PR files for context
      const filesResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pr_number}/files`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      const files = await filesResponse.json() as any[];

      const focusPrompts: Record<string, string> = {
        security: 'Focus on security vulnerabilities: injection, auth issues, data exposure, secrets in code.',
        performance: 'Focus on performance: N+1 queries, unnecessary loops, memory leaks, caching opportunities.',
        bugs: 'Focus on bugs: logic errors, edge cases, null handling, race conditions.',
        style: 'Focus on code style: naming, formatting, code organization, documentation.',
        all: 'Provide comprehensive review covering security, performance, bugs, and style.',
      };

      const systemPrompt = `You are an expert code reviewer. Review this Pull Request.

PR: ${pr.title}
Author: ${pr.user.login}
Files changed: ${files.length}
Additions: +${pr.additions} Deletions: -${pr.deletions}

${focusPrompts[focus || 'all']}

Format your review as:
## Summary
Brief overview of the changes

## Issues Found
For each issue:
- **[severity]** file:line - description
  \`\`\`suggestion
  suggested fix if applicable
  \`\`\`

## Approval Recommendation
✅ APPROVE / ⚠️ REQUEST CHANGES / 💬 COMMENT

Severities: 🔴 critical, 🟠 major, 🟡 minor, 🔵 nitpick`;

      const result = await env.AI.run(env.REASONING_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `PR Description:\n${pr.body || 'No description'}\n\nFiles:\n${files.map((f: any) => `- ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n')}\n\nDiff:\n${diff.slice(0, 15000)}` },
        ],
        max_tokens: 4096,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            pr: {
              number: pr_number,
              title: pr.title,
              author: pr.user.login,
              url: pr.html_url,
              files: files.length,
              additions: pr.additions,
              deletions: pr.deletions,
            },
            review: result.response,
          }, null, 2),
        }],
      };
    }
  );

  // ==================== MULTI-FILE REFACTORING ====================

  // Tool: Plan refactor
  server.registerTool(
    'plan_refactor',
    {
      description: 'Create a multi-file refactoring plan. Analyzes dependencies and suggests coordinated changes.',
      inputSchema: {
        goal: z.string().describe('Refactoring goal (e.g., "extract authentication into separate module")'),
        project_id: z.string().describe('Project to refactor'),
        entry_file: z.string().optional().describe('Starting file path for the refactor'),
      },
    },
    async ({ goal, project_id, entry_file }) => {
      // Get project context
      const embedding = await env.AI.run(env.EMBEDDING_MODEL as any, { text: goal });

      const results = await env.VECTORIZE.query(embedding.data[0], {
        topK: 20,
        filter: { project_id },
        returnMetadata: 'all',
      });

      // Fetch relevant code chunks
      const context = await Promise.all(
        results.matches.map(async (match) => {
          const chunk = await env.DB.prepare(
            `SELECT c.content, f.relative_path
             FROM chunks c
             JOIN files f ON c.file_id = f.id
             WHERE c.id = ?`
          ).bind(match.id).first();
          return chunk;
        })
      );

      // Group by file
      const fileMap = new Map<string, string[]>();
      for (const chunk of context) {
        if (!chunk) continue;
        const path = (chunk as any).relative_path;
        if (!fileMap.has(path)) fileMap.set(path, []);
        fileMap.get(path)!.push((chunk as any).content);
      }

      const codeContext = Array.from(fileMap.entries())
        .map(([path, chunks]) => `=== ${path} ===\n${chunks.join('\n...\n')}`)
        .join('\n\n');

      const systemPrompt = `You are an expert software architect. Create a detailed refactoring plan.

Goal: ${goal}
${entry_file ? `Starting point: ${entry_file}` : ''}

Analyze the code and create a step-by-step plan:

## Refactoring Plan

### 1. Analysis
- Current state summary
- Dependencies identified
- Risk assessment

### 2. Files to Modify
For each file:
| File | Change Type | Description |
|------|-------------|-------------|
| path | create/modify/delete | what changes |

### 3. Execution Order
List files in order they should be changed (respecting dependencies):
1. First: [file] - reason
2. Then: [file] - reason
...

### 4. Code Changes
For each file, show:
\`\`\`diff
- old code
+ new code
\`\`\`

### 5. Testing Strategy
- What to test after each step
- Rollback plan if issues

### 6. Migration Notes
- Breaking changes
- Required updates to dependents`;

      const result = await env.AI.run(env.REASONING_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: codeContext },
        ],
        max_tokens: 8192,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            goal,
            project_id,
            files_analyzed: fileMap.size,
            plan: result.response,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: Execute refactor step
  server.registerTool(
    'execute_refactor',
    {
      description: 'Execute a single step of a refactoring plan. Stages changes for review.',
      inputSchema: {
        project_id: z.string().describe('Project ID'),
        file_path: z.string().describe('File to refactor'),
        instruction: z.string().describe('Specific refactoring instruction for this file'),
        related_files: z.array(z.string()).optional().describe('Other files that may need coordinated changes'),
      },
    },
    async ({ project_id, file_path, instruction, related_files }) => {
      // Get current file content
      const chunks = await env.DB.prepare(
        `SELECT c.content, c.start_line
         FROM files f
         JOIN chunks c ON f.id = c.file_id
         WHERE f.project_id = ? AND f.relative_path = ?
         ORDER BY c.start_line`
      ).bind(project_id, file_path).all();

      if (chunks.results.length === 0) {
        return {
          content: [{ type: 'text', text: `File not found: ${file_path}` }],
          isError: true,
        };
      }

      const currentContent = chunks.results.map((c: any) => c.content).join('\n');

      // Get related file content if specified
      let relatedContext = '';
      if (related_files?.length) {
        for (const relPath of related_files) {
          const relChunks = await env.DB.prepare(
            `SELECT c.content FROM files f JOIN chunks c ON f.id = c.file_id
             WHERE f.project_id = ? AND f.relative_path = ? ORDER BY c.start_line`
          ).bind(project_id, relPath).all();
          if (relChunks.results.length > 0) {
            relatedContext += `\n=== ${relPath} ===\n${relChunks.results.map((c: any) => c.content).join('\n')}`;
          }
        }
      }

      const systemPrompt = `You are a code refactoring assistant. Apply the requested change to the file.

Instruction: ${instruction}

Output ONLY the complete new file content, no explanations.
Preserve all functionality unless explicitly asked to remove it.
Maintain consistent style with the existing code.`;

      const result = await env.AI.run(env.LLM_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Current file (${file_path}):\n${currentContent}${relatedContext ? `\n\nRelated files for context:${relatedContext}` : ''}` },
        ],
        max_tokens: 8192,
      });

      const newContent = result.response || '';

      // Stage the change
      const artifactKey = `pending/${Date.now()}/${file_path}`;
      await env.ARTIFACTS.put(artifactKey, newContent, {
        customMetadata: {
          path: file_path,
          type: 'modify',
          instruction,
          timestamp: Date.now().toString(),
        },
      });

      // Generate diff preview
      const oldLines = currentContent.split('\n');
      const newLines = newContent.split('\n');
      const changes = {
        additions: newLines.filter(l => !oldLines.includes(l)).length,
        deletions: oldLines.filter(l => !newLines.includes(l)).length,
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            staged: true,
            file: file_path,
            artifact_key: artifactKey,
            changes,
            instruction,
            message: 'Refactor staged. Use list_pending_changes to review, commit_changes to apply.',
          }, null, 2),
        }],
      };
    }
  );

  // ==================== BROWSER AUTOMATION TOOLS ====================

  // Tool: Browser navigate
  server.registerTool(
    'browser_navigate',
    {
      description: 'Navigate a headless browser to a URL and return the page content. Uses Cloudflare Browser Rendering.',
      inputSchema: {
        url: z.string().url().describe('The URL to navigate to'),
        wait_for: z.string().optional().describe('CSS selector to wait for before returning'),
        timeout: z.number().optional().default(30000).describe('Timeout in milliseconds'),
      },
    },
    async ({ url, wait_for, timeout }) => {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle0', timeout: timeout || 30000 });

        if (wait_for) {
          await page.waitForSelector(wait_for, { timeout: timeout || 30000 });
        }

        const title = await page.title();
        const content = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || '');

        await browser.close();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url,
              title,
              html_length: content.length,
              text_preview: text.slice(0, 2000),
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Browser error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Browser screenshot
  server.registerTool(
    'browser_screenshot',
    {
      description: 'Take a screenshot of a webpage. Returns base64-encoded image.',
      inputSchema: {
        url: z.string().url().describe('The URL to screenshot'),
        full_page: z.boolean().optional().default(false).describe('Capture full scrollable page'),
        selector: z.string().optional().describe('CSS selector to screenshot specific element'),
      },
    },
    async ({ url, full_page, selector }) => {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(url, { waitUntil: 'networkidle0' });

        let screenshot: string;
        if (selector) {
          const element = await page.$(selector);
          if (!element) {
            await browser.close();
            return {
              content: [{ type: 'text', text: `Selector not found: ${selector}` }],
              isError: true,
            };
          }
          screenshot = await element.screenshot({ encoding: 'base64' }) as string;
        } else {
          screenshot = await page.screenshot({
            encoding: 'base64',
            fullPage: full_page || false
          }) as string;
        }

        const title = await page.title();
        await browser.close();

        // Store screenshot in R2 for retrieval
        const key = `screenshots/${Date.now()}.png`;
        await env.ARTIFACTS.put(key, Buffer.from(screenshot, 'base64'), {
          httpMetadata: { contentType: 'image/png' },
          customMetadata: { url, title },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url,
              title,
              artifact_key: key,
              size_bytes: screenshot.length,
              message: 'Screenshot stored in R2',
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Screenshot error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Browser scrape
  server.registerTool(
    'browser_scrape',
    {
      description: 'Scrape data from a webpage using CSS selectors. Returns extracted text/attributes.',
      inputSchema: {
        url: z.string().url().describe('The URL to scrape'),
        selectors: z.record(z.string()).describe('Object mapping names to CSS selectors (e.g., {"title": "h1", "links": "a[href]"})'),
        attribute: z.string().optional().describe('Attribute to extract (default: innerText). Use "href", "src", etc.'),
      },
    },
    async ({ url, selectors, attribute }) => {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle0' });

        const results: Record<string, string | string[]> = {};

        for (const [name, selector] of Object.entries(selectors)) {
          const elements = await page.$$(selector);
          const values: string[] = [];

          for (const element of elements) {
            if (attribute) {
              const value = await element.evaluate((el, attr) => el.getAttribute(attr), attribute);
              if (value) values.push(value);
            } else {
              const text = await element.evaluate(el => el.textContent?.trim() || '');
              if (text) values.push(text);
            }
          }

          results[name] = values.length === 1 ? values[0] : values;
        }

        await browser.close();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url,
              data: results,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Scrape error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Browser click
  server.registerTool(
    'browser_click',
    {
      description: 'Navigate to a URL, click on an element, and return the result.',
      inputSchema: {
        url: z.string().url().describe('The URL to navigate to'),
        selector: z.string().describe('CSS selector of element to click'),
        wait_after: z.number().optional().default(2000).describe('Time to wait after click (ms)'),
      },
    },
    async ({ url, selector, wait_after }) => {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle0' });

        await page.waitForSelector(selector);
        await page.click(selector);
        await page.waitForTimeout(wait_after || 2000);

        const newUrl = page.url();
        const title = await page.title();
        const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');

        await browser.close();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              clicked: selector,
              navigated: newUrl !== url,
              current_url: newUrl,
              title,
              text_preview: text,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Click error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Browser fill form
  server.registerTool(
    'browser_fill_form',
    {
      description: 'Fill out a form on a webpage with provided values.',
      inputSchema: {
        url: z.string().url().describe('The URL with the form'),
        fields: z.record(z.string()).describe('Object mapping CSS selectors to values (e.g., {"#email": "test@example.com"})'),
        submit_selector: z.string().optional().describe('CSS selector of submit button to click after filling'),
      },
    },
    async ({ url, fields, submit_selector }) => {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle0' });

        const filled: string[] = [];
        for (const [selector, value] of Object.entries(fields)) {
          await page.waitForSelector(selector);
          await page.type(selector, value);
          filled.push(selector);
        }

        let submitted = false;
        if (submit_selector) {
          await page.click(submit_selector);
          await page.waitForTimeout(3000);
          submitted = true;
        }

        const newUrl = page.url();
        const title = await page.title();

        await browser.close();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              fields_filled: filled,
              submitted,
              current_url: newUrl,
              title,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Form fill error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Browser evaluate
  server.registerTool(
    'browser_evaluate',
    {
      description: 'Execute JavaScript code on a webpage and return the result.',
      inputSchema: {
        url: z.string().url().describe('The URL to navigate to'),
        script: z.string().describe('JavaScript code to execute in the page context'),
      },
    },
    async ({ url, script }) => {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle0' });

        // Execute the script
        const result = await page.evaluate(script);

        await browser.close();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url,
              result,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Evaluate error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Browser PDF
  server.registerTool(
    'browser_pdf',
    {
      description: 'Generate a PDF of a webpage.',
      inputSchema: {
        url: z.string().url().describe('The URL to convert to PDF'),
        format: z.enum(['A4', 'Letter', 'Legal']).optional().default('A4').describe('Page format'),
      },
    },
    async ({ url, format }) => {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({
          format: format || 'A4',
          printBackground: true,
        });

        const title = await page.title();
        await browser.close();

        // Store PDF in R2
        const key = `pdfs/${Date.now()}.pdf`;
        await env.ARTIFACTS.put(key, pdf, {
          httpMetadata: { contentType: 'application/pdf' },
          customMetadata: { url, title },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url,
              title,
              artifact_key: key,
              size_bytes: pdf.length,
              message: 'PDF stored in R2',
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `PDF error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

/**
 * Generate a simple unified diff
 */
function generateSimpleDiff(path: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let diff = `--- a/${path}\n+++ b/${path}\n`;

  // Simple line-by-line diff (not a true unified diff algorithm, but useful for display)
  const maxLines = Math.max(oldLines.length, newLines.length);
  let inHunk = false;
  let hunkStart = 0;
  let hunkLines: string[] = [];

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (!inHunk) {
        inHunk = true;
        hunkStart = i + 1;
        hunkLines = [];
      }
      if (oldLine !== undefined) {
        hunkLines.push(`-${oldLine}`);
      }
      if (newLine !== undefined) {
        hunkLines.push(`+${newLine}`);
      }
    } else if (inHunk) {
      // End of hunk
      diff += `@@ -${hunkStart},${hunkLines.filter(l => l.startsWith('-')).length} +${hunkStart},${hunkLines.filter(l => l.startsWith('+')).length} @@\n`;
      diff += hunkLines.join('\n') + '\n';
      inHunk = false;
    }
  }

  // Handle remaining hunk
  if (inHunk) {
    diff += `@@ -${hunkStart},${hunkLines.filter(l => l.startsWith('-')).length} +${hunkStart},${hunkLines.filter(l => l.startsWith('+')).length} @@\n`;
    diff += hunkLines.join('\n') + '\n';
  }

  return diff;
}
