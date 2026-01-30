/**
 * Generate a unique ID
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Hash content using SHA-256
 */
export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get file extension from path
 */
export function getFileExtension(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Determine file type from extension
 */
export function getFileType(path: string): 'code' | 'markdown' | 'config' | 'text' {
  const ext = getFileExtension(path);

  const codeExtensions = ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sql', 'sh', 'bash'];
  const markdownExtensions = ['md', 'mdx'];
  const configExtensions = ['json', 'yaml', 'yml', 'toml', 'xml', 'env', 'ini', 'cfg'];

  if (codeExtensions.includes(ext)) return 'code';
  if (markdownExtensions.includes(ext)) return 'markdown';
  if (configExtensions.includes(ext)) return 'config';
  return 'text';
}

/**
 * Check if file should be indexed
 */
export function shouldIndexFile(path: string): boolean {
  const ext = getFileExtension(path);
  const indexableExtensions = [
    'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
    'sql', 'sh', 'bash', 'md', 'mdx', 'json', 'yaml', 'yml', 'toml', 'txt'
  ];

  // Skip common non-code files
  const skipPatterns = [
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    'venv', '.venv', 'target', '.idea', '.vscode', 'coverage',
    '.wrangler', '.turbo', '.cache'
  ];

  if (skipPatterns.some(p => path.includes(p))) return false;
  if (path.includes('package-lock.json') || path.includes('yarn.lock') || path.includes('pnpm-lock.yaml')) return false;

  return indexableExtensions.includes(ext);
}

/**
 * Normalize project path
 */
export function normalizeProjectPath(path: string): string {
  // Expand ~ to home directory marker (will be resolved server-side)
  if (path.startsWith('~/')) {
    return path;
  }
  return path;
}

/**
 * Extract project name from path
 */
export function extractProjectName(path: string): string {
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || 'unknown';
}

/**
 * Create JSON response
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Create error response
 */
export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Rate limit key for today
 */
export function getRateLimitKey(type: 'query' | 'embedding'): string {
  const today = new Date().toISOString().split('T')[0];
  return `rate:${type}:${today}`;
}

/**
 * Truncate text to max length
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
