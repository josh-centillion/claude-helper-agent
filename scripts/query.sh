#!/bin/bash

# Query claude-agents
# Usage: ./scripts/query.sh "How does authentication work?"

set -e

WORKER_URL="${CLAUDE_AGENTS_URL:-https://claude-agents.nick-9a6.workers.dev}"
QUERY="${1:?Usage: $0 <query> [project-id]}"
PROJECT_ID="$2"

# Build request
if [[ -n "$PROJECT_ID" ]]; then
  REQUEST_BODY=$(jq -n --arg q "$QUERY" --arg p "$PROJECT_ID" '{query: $q, project_id: $p}')
else
  REQUEST_BODY=$(jq -n --arg q "$QUERY" '{query: $q}')
fi

# Query
RESPONSE=$(curl -s -X POST "$WORKER_URL/api/query" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY")

# Check for error
if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
  echo "Error: $(echo "$RESPONSE" | jq -r '.error')"
  exit 1
fi

# Print answer
echo ""
echo "🤖 Answer:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "$RESPONSE" | jq -r '.answer'
echo ""

# Print sources
SOURCE_COUNT=$(echo "$RESPONSE" | jq '.sources | length')
if [[ "$SOURCE_COUNT" -gt 0 ]]; then
  echo "📚 Sources ($SOURCE_COUNT):"
  echo "$RESPONSE" | jq -r '.sources[] | "  • \(.project_name)/\(.file_path):\(.start_line)-\(.end_line) (score: \(.score | . * 100 | floor)%)"'
fi

# Print conversation ID for follow-ups
echo ""
echo "💬 Conversation: $(echo "$RESPONSE" | jq -r '.conversation_id')"
