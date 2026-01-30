import type { Ai, D1Database, KVNamespace, VectorizeIndex, DurableObjectNamespace, R2Bucket, Fetcher } from '@cloudflare/workers-types';

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  KV: KVNamespace;
  ARTIFACTS: R2Bucket;
  PROJECT_AGENTS: DurableObjectNamespace;
  CODING_AGENT: DurableObjectNamespace;
  // Browser Rendering binding for web automation
  BROWSER: Fetcher;
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  FAST_MODEL: string;
  REASONING_MODEL: string;
  // Optional: GitHub token for API access
  GITHUB_TOKEN?: string;
  // REQUIRED: API key for MCP endpoint authentication
  API_KEY?: string;
  // Optional: Comma-separated list of allowed CORS origins (defaults to restrictive list)
  ALLOWED_ORIGINS?: string;
}

// Task types for the agentic coding system
export type TaskStatus = 'pending' | 'in_progress' | 'waiting_approval' | 'completed' | 'failed';

export interface CodingTask {
  id: string;
  type: 'search' | 'read' | 'write' | 'edit' | 'diff' | 'commit' | 'pr';
  description: string;
  status: TaskStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  created_at: number;
  completed_at?: number;
}

export interface AgentState {
  currentTask: CodingTask | null;
  taskHistory: CodingTask[];
  workingDirectory: string | null;
  gitBranch: string | null;
  pendingChanges: FileChange[];
}

export interface FileChange {
  path: string;
  type: 'create' | 'modify' | 'delete';
  diff?: string;
  content?: string;
}

export interface GitHubContext {
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  status: 'pending' | 'indexing' | 'ready' | 'error';
  file_count: number;
  last_indexed_at: number | null;
  created_at: number;
}

export interface FileRecord {
  id: string;
  project_id: string;
  relative_path: string;
  content_hash: string;
  chunk_count: number;
  indexed_at: number | null;
}

export interface Chunk {
  id: string;
  file_id: string;
  project_id: string;
  content: string;
  start_line: number;
  end_line: number;
  chunk_type: 'code' | 'markdown' | 'config' | 'text';
}

export interface Conversation {
  id: string;
  project_id: string | null;
  title: string | null;
  message_count: number;
  created_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources?: SourceReference[];
  created_at: number;
}

export interface SourceReference {
  chunk_id: string;
  file_path: string;
  project_name: string;
  start_line: number;
  end_line: number;
  score: number;
}

export interface QueryRequest {
  query: string;
  project_id?: string;
  conversation_id?: string;
  top_k?: number;
}

export interface QueryResponse {
  answer: string;
  sources: SourceReference[];
  conversation_id: string;
  tokens_used?: number;
}

export interface SearchRequest {
  query: string;
  project_id?: string;
  top_k?: number;
  file_type?: string;
}

export interface SearchResult {
  chunk_id: string;
  content: string;
  file_path: string;
  project_name: string;
  start_line: number;
  end_line: number;
  score: number;
}

export interface IndexRequest {
  project_path: string;
  project_name?: string;
  force?: boolean;
  append?: boolean;  // Add files to existing project without clearing
}

export interface IndexProgress {
  project_id: string;
  status: 'pending' | 'scanning' | 'chunking' | 'embedding' | 'complete' | 'error';
  total_files: number;
  processed_files: number;
  total_chunks: number;
  error?: string;
}

export interface VectorMetadata {
  chunk_id: string;
  project_id: string;
  file_path: string;
  file_type: string;
  start_line: number;
  end_line: number;
}

export interface MetricsResponse {
  projects: number;
  total_files: number;
  total_chunks: number;
  conversations: number;
  queries_today: number;
  embeddings_today: number;
}
