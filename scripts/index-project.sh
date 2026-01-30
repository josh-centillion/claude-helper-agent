#!/bin/bash

# Index a local project to claude-agents
# Usage: ./scripts/index-project.sh ~/Projects/MyProject [project-name]

set -e

WORKER_URL="${CLAUDE_AGENTS_URL:-https://claude-agents.nick-9a6.workers.dev}"
PROJECT_PATH="${1:?Usage: $0 <project-path> [project-name]}"
PROJECT_NAME="${2:-$(basename "$PROJECT_PATH")}"
BATCH_SIZE=50  # Files per batch

# Resolve path
if [[ "$PROJECT_PATH" == ~* ]]; then
  PROJECT_PATH="${PROJECT_PATH/#\~/$HOME}"
fi

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "Error: Directory not found: $PROJECT_PATH"
  exit 1
fi

echo "📁 Indexing project: $PROJECT_NAME"
echo "   Path: $PROJECT_PATH"
echo "   Worker: $WORKER_URL"
echo ""

# Create temp file for file list
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Collect file paths
find "$PROJECT_PATH" \
  -type f \
  \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
     -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" \
     -o -name "*.md" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" \
     -o -name "*.toml" -o -name "*.sql" -o -name "*.sh" \) \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -path "*/dist/*" \
  ! -path "*/build/*" \
  ! -path "*/.next/*" \
  ! -path "*/__pycache__/*" \
  ! -path "*/.wrangler/*" \
  ! -path "*/target/*" \
  ! -path "*/.venv/*" \
  ! -name "package-lock.json" \
  ! -name "yarn.lock" \
  ! -name "pnpm-lock.yaml" \
  2>/dev/null > "$TEMP_DIR/files.txt" || true

TOTAL_FILES=$(wc -l < "$TEMP_DIR/files.txt" | tr -d ' ')
echo "📊 Found $TOTAL_FILES files to index"

if [[ "$TOTAL_FILES" -eq 0 ]]; then
  echo "❌ No indexable files found"
  exit 1
fi

# Process in batches
BATCH_NUM=0
PROCESSED=0
SKIPPED=0

while IFS= read -r file; do
  # Skip large files (> 50KB)
  size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "999999")
  if [[ $size -gt 51200 ]]; then
    rel_path="${file#$PROJECT_PATH/}"
    echo "   Skipping large file: $rel_path ($(($size / 1024))KB)"
    ((SKIPPED++))
    continue
  fi

  rel_path="${file#$PROJECT_PATH/}"

  # Read and encode content
  content=$(cat "$file" 2>/dev/null | head -c 50000 | jq -Rs . 2>/dev/null || echo '""')

  # Add to batch
  echo "{\"path\":\"$rel_path\",\"content\":$content}" >> "$TEMP_DIR/batch_$BATCH_NUM.json"
  ((PROCESSED++))

  # Check if batch is full
  BATCH_FILE_COUNT=$(wc -l < "$TEMP_DIR/batch_$BATCH_NUM.json" | tr -d ' ')
  if [[ $BATCH_FILE_COUNT -ge $BATCH_SIZE ]]; then
    ((BATCH_NUM++))
  fi
done < "$TEMP_DIR/files.txt"

TOTAL_BATCHES=$((BATCH_NUM + 1))
echo "📦 Processing $PROCESSED files in $TOTAL_BATCHES batches (skipped $SKIPPED large files)"
echo ""

# Track totals
TOTAL_CHUNKS=0
TOTAL_VECTORS=0

# Send batches
for i in $(seq 0 $BATCH_NUM); do
  BATCH_FILE="$TEMP_DIR/batch_$i.json"
  if [[ ! -f "$BATCH_FILE" ]]; then
    continue
  fi

  BATCH_FILE_COUNT=$(wc -l < "$BATCH_FILE" | tr -d ' ')
  echo -n "🚀 Batch $((i + 1))/$TOTAL_BATCHES ($BATCH_FILE_COUNT files)... "

  # Build JSON array from batch file
  FILES_JSON="[$(paste -sd, "$BATCH_FILE")]"

  # Build request - first batch uses force=true, subsequent use append=true
  if [[ $i -eq 0 ]]; then
    REQUEST_BODY="{\"project_path\":\"$PROJECT_PATH\",\"project_name\":\"$PROJECT_NAME\",\"files\":$FILES_JSON,\"force\":true}"
  else
    REQUEST_BODY="{\"project_path\":\"$PROJECT_PATH\",\"project_name\":\"$PROJECT_NAME\",\"files\":$FILES_JSON,\"append\":true}"
  fi

  # Send to worker
  RESPONSE=$(curl -s -X POST "$WORKER_URL/api/index" \
    -H "Content-Type: application/json" \
    -d "$REQUEST_BODY" 2>&1)

  # Check response
  if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    echo "⚠️  Error: $(echo "$RESPONSE" | jq -r '.error')"
  else
    CHUNKS=$(echo "$RESPONSE" | jq -r '.total_chunks // 0')
    VECTORS=$(echo "$RESPONSE" | jq -r '.vectors_inserted // 0')
    TOTAL_CHUNKS=$((TOTAL_CHUNKS + CHUNKS))
    TOTAL_VECTORS=$((TOTAL_VECTORS + VECTORS))
    echo "✅ $CHUNKS chunks, $VECTORS vectors"
  fi
done

echo ""
echo "════════════════════════════════════════════════════"
echo "✅ Indexing complete!"
echo "   Total chunks: $TOTAL_CHUNKS"
echo "   Total vectors: $TOTAL_VECTORS"
echo ""

# Get final project stats
curl -s "$WORKER_URL/api/projects" | jq --arg name "$PROJECT_NAME" '.projects[] | select(.name == $name) | {name, file_count, status}'
