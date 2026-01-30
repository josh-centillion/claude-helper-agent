# Claude Agents Session State

## Deployment Info

- **Worker URL**: `https://claude-agents.nick-9a6.workers.dev`
- **API Key**: `fe941f6eca5f8b6a86c6e7627fb286d2eec678d3988ebc6466c2fcb1fb1ed12c`
- **Version**: 2.2.0

## What's Done

- [x] Full agentic coding system deployed on Cloudflare Workers
- [x] MCP server with 28 tools (code_search, read_file, browser_navigate, review_pr, etc.)
- [x] API key authentication on /mcp AND /api endpoints
- [x] GitHub token configured for commits/PRs
- [x] CodingAgent Durable Object for stateful task orchestration
- [x] Workers AI integration (Llama 70B, DeepSeek R1)
- [x] **Self-indexed** - claude-agents can query its own codebase (25 files, 152 vectors)
- [x] **12 projects indexed** including SDK references:
  - Dentist-Scrapers (89 files)
  - health-app (383 files)
  - cloudflare-agents-sdk (373 files, 1,873 vectors)
  - cf-mcp-reference (283 files, 1,321 vectors)
  - cf-playwright-mcp (84 files, 254 vectors)
  - stagehand-mcp (38 files, 133 vectors)
  - puppeteer-mcp (11 files, 136 vectors)
  - claude-agents, Car-Research, Centillion-*
- [x] **Security hardened (2026-01-30)**:
  - CORS restricted to allowed origins (no more wildcard)
  - Rate limiting: 100 req/min MCP, 200/50 req/min API
  - API key required for all endpoints (except /health, /metrics)
  - Input validation helpers added
  - Path traversal protection
- [x] **Browser automation tools (2026-01-30)**:
  - Cloudflare Browser Rendering integration
  - 7 new tools: navigate, screenshot, scrape, click, fill_form, evaluate, pdf

## Configure Claude CLI

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "claude-agents": {
      "url": "https://claude-agents.nick-9a6.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer fe941f6eca5f8b6a86c6e7627fb286d2eec678d3988ebc6466c2fcb1fb1ed12c"
      }
    }
  }
}
```

## MCP Tools Available (28 tools)

### Code & Git Tools
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

### AI Analysis Tools
| Tool | Description |
|------|-------------|
| `generate_code` | Generate code with Llama 70B |
| `analyze_code` | Analyze code for bugs/security/improvements |
| `explain_error` | Analyze stack traces with DeepSeek R1 |
| `summarize_project` | High-level project summary |
| `find_similar_code` | Find similar code across projects |
| `suggest_refactor` | AI-powered refactoring suggestions |
| `get_project_context` | Get relevant context for a task |

### Code Quality Tools
| Tool | Description |
|------|-------------|
| `lint_code` | AI-powered linting for any language |
| `run_tests` | Analyze tests, generate tests, find coverage gaps |

### GitHub Tools
| Tool | Description |
|------|-------------|
| `review_pr` | Fetch and review PRs with AI feedback |

### Multi-file Refactoring
| Tool | Description |
|------|-------------|
| `plan_refactor` | Create multi-file refactoring plan |
| `execute_refactor` | Execute refactor step, stage changes |

### Browser Automation Tools
| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL, return page content |
| `browser_screenshot` | Take webpage screenshot, store in R2 |
| `browser_scrape` | Scrape data using CSS selectors |
| `browser_click` | Click on element, return result |
| `browser_fill_form` | Fill and submit forms |
| `browser_evaluate` | Execute JavaScript on page |
| `browser_pdf` | Generate PDF of webpage |

## Test Commands

```bash
# Test search
curl -s -X POST "https://claude-agents.nick-9a6.workers.dev/api/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fe941f6eca5f8b6a86c6e7627fb286d2eec678d3988ebc6466c2fcb1fb1ed12c" \
  -d '{"query":"your search query","top_k":5}'

# List projects
curl -s "https://claude-agents.nick-9a6.workers.dev/api/projects" \
  -H "Authorization: Bearer fe941f6eca5f8b6a86c6e7627fb286d2eec678d3988ebc6466c2fcb1fb1ed12c"

# Index another project
./scripts/index-project.sh ~/Projects/your-project "Project Name"
```

## Next Steps

1. ~~Configure Claude CLI with MCP server~~ ✅ Done
2. ~~Index claude-agents itself~~ ✅ Done (self-aware)
3. ~~Add AI analysis tools~~ ✅ Done (explain_error, summarize_project, etc.)
4. ~~Add browser automation tools~~ ✅ Done (7 browser tools)
5. Potential additions:
   - `run_tests` - Execute project test suites
   - `lint_code` - Run linters (ESLint, Prettier)
   - Multi-file refactoring agent
   - Code review agent
6. Test full workflow: search → edit → commit → PR
