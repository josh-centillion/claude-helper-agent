# Claude-Agents v2.0

Distributed agentic coding system on Cloudflare Workers with Claude CLI integration.

## Features

- **MCP Server** - Expose tools to Claude CLI for agentic coding
- **Code RAG** - Semantic search over indexed projects
- **GitHub Integration** - Create branches, commits, PRs directly
- **File Operations** - Read, write, edit files with diff generation
- **Code Generation** - Generate and analyze code using Workers AI (Llama 70B, DeepSeek R1)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CLAUDE CLI / DESKTOP                              │
│                    (Orchestrator)                                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ MCP Protocol (/mcp endpoint)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKER                                 │
├─────────────────────────────────────────────────────────────────────┤
│  MCP Tools                        │  REST API                        │
│  ├─ code_search                   │  ├─ /api/query (RAG)            │
│  ├─ read_file                     │  ├─ /api/search (vector)        │
│  ├─ write_file                    │  ├─ /api/index (index project)  │
│  ├─ edit_file                     │  ├─ /api/projects               │
│  ├─ commit_changes                │  └─ /api/pending                 │
│  ├─ create_branch                 │                                  │
│  ├─ create_pull_request           │                                  │
│  ├─ generate_code                 │                                  │
│  └─ analyze_code                  │                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Storage                                                             │
│  ├── Vectorize: Semantic code search                                │
│  ├── D1: Projects, files, chunks, conversations                     │
│  ├── R2: Pending changes, artifacts                                 │
│  ├── KV: Cache, rate limits                                         │
│  └── Workers AI: Llama 70B, DeepSeek R1                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ GitHub API
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    GITHUB                                            │
│  Branches, commits, pull requests                                    │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Deploy

```bash
npm install
npm run deploy
```

### 2. Configure Claude CLI

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "claude-agents": {
      "url": "https://claude-agents.nick-9a6.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY_HERE"
      }
    }
  }
}
```

Replace `YOUR_API_KEY_HERE` with the API key you set in step 3.

### 3. Add Secrets

**Option A: Via CLI (recommended for CI/CD)**
```bash
# Generate and set API key
API_KEY=$(openssl rand -hex 32)
echo "Your API_KEY: $API_KEY"  # Save this!
echo "$API_KEY" | npx wrangler secret put API_KEY

# Optional: GitHub token
npx wrangler secret put GITHUB_TOKEN
```

**Option B: Via Cloudflare Dashboard**
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages
2. Select `claude-agents` → Settings → Variables
3. Add under "Secrets":
   - `API_KEY`: Your generated key
   - `GITHUB_TOKEN`: Your GitHub PAT (optional)

**Option C: For local development**
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your values
```

### 4. Index a Project

```bash
./scripts/index-project.sh ~/Projects/my-app "My App"
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `code_search` | Semantic search over indexed codebase |
| `read_file` | Read file content from index or GitHub |
| `write_file` | Stage file for commit |
| `edit_file` | Edit file with find/replace, generates diff |
| `list_pending_changes` | List staged changes |
| `commit_changes` | Commit staged changes to GitHub |
| `create_branch` | Create new Git branch |
| `create_pull_request` | Create GitHub PR |
| `list_projects` | List indexed projects |
| `generate_code` | Generate code with Llama 70B |
| `analyze_code` | Analyze code for bugs/security/improvements |

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP server endpoint |
| `/api/query` | POST | RAG query with LLM response |
| `/api/search` | POST | Direct vector search |
| `/api/index` | POST | Index project files |
| `/api/projects` | GET | List all projects |
| `/api/pending` | GET | List pending changes |
| `/api/pending` | DELETE | Clear pending changes |

## Example: Agentic Coding Session

```
You: Search for authentication code in my project

Claude: [Uses code_search tool]
Found 3 relevant files:
- src/auth/login.ts:45-89 (score: 0.92)
- src/middleware/auth.ts:12-34 (score: 0.87)
...

You: Add rate limiting to the login endpoint

Claude: [Uses read_file, then edit_file]
I've staged the following changes:

--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -45,6 +45,15 @@
+import { rateLimit } from '../middleware/rateLimit';
+
+const loginLimiter = rateLimit({
+  windowMs: 15 * 60 * 1000,
+  max: 5
+});
+
 export async function login(req, res) {
...

You: Commit and create PR

Claude: [Uses commit_changes, create_pull_request]
✅ Committed to branch: feature/add-rate-limiting
✅ PR #42 created: https://github.com/user/repo/pull/42
```

## Models Used

| Model | Purpose | Free Tier |
|-------|---------|-----------|
| `@cf/baai/bge-base-en-v1.5` | Embeddings | 10K/day |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Code generation | 10K neurons/day |
| `@cf/meta/llama-3.1-8b-instruct-fast` | Fast tasks | 10K neurons/day |
| `@cf/deepseek-ai/deepseek-r1-distill-llama-70b` | Code analysis | 10K neurons/day |

## Development

```bash
# Local development
npm run dev

# Deploy
npm run deploy

# Initialize D1 schema
npm run db:init

# Type check
npm run typecheck
```

## File Structure

```
claude-agents/
├── src/
│   ├── index.ts              # Main entry, routing, MCP
│   ├── types.ts              # TypeScript types
│   ├── agents/
│   │   └── CodingAgent.ts    # Stateful coding agent (DO)
│   ├── mcp/
│   │   └── server.ts         # MCP server with all tools
│   ├── tools/
│   │   ├── coding.ts         # File operations, search
│   │   └── github.ts         # GitHub API integration
│   ├── handlers/             # REST API handlers
│   ├── lib/                  # Utilities
│   └── do/                   # Durable Objects
├── scripts/
│   ├── index-project.sh      # Index local project
│   └── query.sh              # CLI query helper
├── schema.sql                # D1 database schema
└── wrangler.toml             # Worker configuration
```

## Circular Sync Flow

1. **Claude CLI** dispatches task via MCP
2. **Worker** executes using free models (Llama 70B)
3. **Changes** staged in R2
4. **Commit** pushed to GitHub branch
5. **PR created** for review
6. **Claude CLI** notified of completion

## License

MIT
