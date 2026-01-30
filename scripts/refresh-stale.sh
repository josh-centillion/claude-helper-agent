#!/bin/bash

# Refresh stale projects in claude-agents
# Add to crontab: 0 8 * * * ~/Projects/claude-agents/scripts/refresh-stale.sh
# Usage: ./scripts/refresh-stale.sh [days-threshold]

WORKER_URL="${CLAUDE_AGENTS_URL:-https://claude-agents.nick-9a6.workers.dev}"
DAYS="${1:-7}"  # Default: refresh projects not indexed in 7 days
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔍 Checking for stale projects (>${DAYS} days old)..."

# Get stale projects
STALE=$(curl -s "$WORKER_URL/api/stale?days=$DAYS")
COUNT=$(echo "$STALE" | jq -r '.count')

if [[ "$COUNT" -eq 0 ]]; then
  echo "✅ All projects are up to date!"
  exit 0
fi

echo "📋 Found $COUNT stale projects:"
echo "$STALE" | jq -r '.stale_projects[] | "  • \(.name) (\(.days_stale | floor) days old)"'
echo ""

# Re-index each stale project
echo "$STALE" | jq -r '.stale_projects[] | "\(.path)|\(.name)"' | while IFS='|' read -r path name; do
  if [[ -d "$path" ]]; then
    echo "🔄 Re-indexing: $name"
    "$SCRIPT_DIR/index-project.sh" "$path" "$name" 2>&1 | tail -5
    echo ""
  else
    echo "⚠️  Skipping $name - path not found: $path"
  fi
done

echo "✅ Refresh complete!"
