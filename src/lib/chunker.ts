import { getFileType, generateId } from './utils';
import type { Chunk } from '../types';

const MAX_CHUNK_TOKENS = 512;
const OVERLAP_LINES = 3;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;

export interface ChunkOptions {
  fileId: string;
  projectId: string;
  filePath: string;
}

/**
 * Chunk file content based on file type
 */
export function chunkFile(
  content: string,
  options: ChunkOptions
): Omit<Chunk, 'id'>[] {
  const fileType = getFileType(options.filePath);

  switch (fileType) {
    case 'markdown':
      return chunkMarkdown(content, options);
    case 'code':
      return chunkCode(content, options);
    case 'config':
      return chunkConfig(content, options);
    default:
      return chunkText(content, options);
  }
}

/**
 * Chunk code files - try to preserve function boundaries
 */
function chunkCode(
  content: string,
  options: ChunkOptions
): Omit<Chunk, 'id'>[] {
  const lines = content.split('\n');
  const chunks: Omit<Chunk, 'id'>[] = [];

  // Detect function/class boundaries
  const boundaries = detectCodeBoundaries(lines, options.filePath);

  if (boundaries.length > 0) {
    // Chunk by detected boundaries
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1] ?? lines.length;
      const chunkLines = lines.slice(start, end);
      const chunkContent = chunkLines.join('\n');

      // If chunk is too large, split it further
      if (chunkContent.length > MAX_CHUNK_CHARS) {
        const subChunks = splitLargeChunk(chunkLines, start, options);
        chunks.push(...subChunks);
      } else if (chunkContent.trim().length > 0) {
        chunks.push({
          file_id: options.fileId,
          project_id: options.projectId,
          content: chunkContent,
          start_line: start + 1,
          end_line: end,
          chunk_type: 'code',
        });
      }
    }
  } else {
    // Fall back to line-based chunking
    chunks.push(...chunkByLines(lines, options, 'code'));
  }

  return chunks;
}

/**
 * Detect function/class boundaries in code
 */
function detectCodeBoundaries(lines: string[], filePath: string): number[] {
  const boundaries: number[] = [0];
  const ext = filePath.split('.').pop()?.toLowerCase();

  // Patterns for different languages
  const patterns: Record<string, RegExp[]> = {
    ts: [/^(export\s+)?(async\s+)?function\s+\w+/, /^(export\s+)?class\s+\w+/, /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/],
    tsx: [/^(export\s+)?(async\s+)?function\s+\w+/, /^(export\s+)?class\s+\w+/, /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/],
    js: [/^(export\s+)?(async\s+)?function\s+\w+/, /^(export\s+)?class\s+\w+/, /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/],
    jsx: [/^(export\s+)?(async\s+)?function\s+\w+/, /^(export\s+)?class\s+\w+/],
    py: [/^(async\s+)?def\s+\w+/, /^class\s+\w+/],
    go: [/^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/, /^type\s+\w+\s+struct/],
    rs: [/^(pub\s+)?(async\s+)?fn\s+\w+/, /^(pub\s+)?struct\s+\w+/, /^impl\s+/],
  };

  const langPatterns = patterns[ext || ''] || [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const pattern of langPatterns) {
      if (pattern.test(line)) {
        // Don't add if too close to previous boundary
        const lastBoundary = boundaries[boundaries.length - 1];
        if (i - lastBoundary > 5) {
          boundaries.push(i);
        }
        break;
      }
    }
  }

  return boundaries;
}

/**
 * Chunk markdown files by headers
 */
function chunkMarkdown(
  content: string,
  options: ChunkOptions
): Omit<Chunk, 'id'>[] {
  const lines = content.split('\n');
  const chunks: Omit<Chunk, 'id'>[] = [];
  const headerPattern = /^#{1,3}\s+/;

  let currentChunkStart = 0;
  let currentChunkLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (headerPattern.test(line) && currentChunkLines.length > 0) {
      // Save current chunk
      const chunkContent = currentChunkLines.join('\n');
      if (chunkContent.trim().length > 0) {
        chunks.push({
          file_id: options.fileId,
          project_id: options.projectId,
          content: chunkContent,
          start_line: currentChunkStart + 1,
          end_line: i,
          chunk_type: 'markdown',
        });
      }
      currentChunkStart = i;
      currentChunkLines = [line];
    } else {
      currentChunkLines.push(line);

      // Check if chunk is getting too large
      if (currentChunkLines.join('\n').length > MAX_CHUNK_CHARS) {
        const splitPoint = Math.floor(currentChunkLines.length / 2);
        const firstHalf = currentChunkLines.slice(0, splitPoint);
        const secondHalf = currentChunkLines.slice(splitPoint);

        chunks.push({
          file_id: options.fileId,
          project_id: options.projectId,
          content: firstHalf.join('\n'),
          start_line: currentChunkStart + 1,
          end_line: currentChunkStart + splitPoint,
          chunk_type: 'markdown',
        });

        currentChunkStart = currentChunkStart + splitPoint;
        currentChunkLines = secondHalf;
      }
    }
  }

  // Don't forget the last chunk
  if (currentChunkLines.length > 0) {
    const chunkContent = currentChunkLines.join('\n');
    if (chunkContent.trim().length > 0) {
      chunks.push({
        file_id: options.fileId,
        project_id: options.projectId,
        content: chunkContent,
        start_line: currentChunkStart + 1,
        end_line: lines.length,
        chunk_type: 'markdown',
      });
    }
  }

  return chunks;
}

/**
 * Chunk config files - keep them whole if small enough
 */
function chunkConfig(
  content: string,
  options: ChunkOptions
): Omit<Chunk, 'id'>[] {
  if (content.length <= MAX_CHUNK_CHARS) {
    return [{
      file_id: options.fileId,
      project_id: options.projectId,
      content,
      start_line: 1,
      end_line: content.split('\n').length,
      chunk_type: 'config',
    }];
  }

  // If too large, chunk by lines
  return chunkByLines(content.split('\n'), options, 'config');
}

/**
 * Chunk generic text files by lines
 */
function chunkText(
  content: string,
  options: ChunkOptions
): Omit<Chunk, 'id'>[] {
  return chunkByLines(content.split('\n'), options, 'text');
}

/**
 * Generic line-based chunking with overlap
 */
function chunkByLines(
  lines: string[],
  options: ChunkOptions,
  chunkType: Chunk['chunk_type']
): Omit<Chunk, 'id'>[] {
  const chunks: Omit<Chunk, 'id'>[] = [];
  let currentChunk: string[] = [];
  let chunkStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);

    if (currentChunk.join('\n').length >= MAX_CHUNK_CHARS || i === lines.length - 1) {
      const chunkContent = currentChunk.join('\n');
      if (chunkContent.trim().length > 0) {
        chunks.push({
          file_id: options.fileId,
          project_id: options.projectId,
          content: chunkContent,
          start_line: chunkStartLine + 1,
          end_line: i + 1,
          chunk_type: chunkType,
        });
      }

      // Start new chunk with overlap
      const overlapStart = Math.max(0, currentChunk.length - OVERLAP_LINES);
      currentChunk = currentChunk.slice(overlapStart);
      chunkStartLine = i - currentChunk.length + 1;
    }
  }

  return chunks;
}

/**
 * Split a large chunk into smaller pieces
 */
function splitLargeChunk(
  lines: string[],
  startLine: number,
  options: ChunkOptions
): Omit<Chunk, 'id'>[] {
  const chunks: Omit<Chunk, 'id'>[] = [];
  let currentChunk: string[] = [];
  let chunkStartLine = startLine;

  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);

    if (currentChunk.join('\n').length >= MAX_CHUNK_CHARS) {
      chunks.push({
        file_id: options.fileId,
        project_id: options.projectId,
        content: currentChunk.join('\n'),
        start_line: chunkStartLine + 1,
        end_line: startLine + i + 1,
        chunk_type: 'code',
      });

      // Overlap
      const overlapStart = Math.max(0, currentChunk.length - OVERLAP_LINES);
      currentChunk = currentChunk.slice(overlapStart);
      chunkStartLine = startLine + i - currentChunk.length + 1;
    }
  }

  // Remaining lines
  if (currentChunk.length > 0 && currentChunk.join('\n').trim().length > 0) {
    chunks.push({
      file_id: options.fileId,
      project_id: options.projectId,
      content: currentChunk.join('\n'),
      start_line: chunkStartLine + 1,
      end_line: startLine + lines.length,
      chunk_type: 'code',
    });
  }

  return chunks;
}

/**
 * Assign IDs to chunks
 */
export function assignChunkIds(chunks: Omit<Chunk, 'id'>[]): Chunk[] {
  return chunks.map(chunk => ({
    ...chunk,
    id: generateId(),
  }));
}
