/**
 * CodingAgent - Main orchestrator for agentic coding tasks
 *
 * Extends the Cloudflare Agents SDK to provide:
 * - Task orchestration and state management
 * - MCP server for Claude CLI integration
 * - Tool execution (search, read, write, edit, git)
 * - Human-in-the-loop approval workflows
 */

import { Agent, callable } from 'agents';
import type { Env, AgentState, CodingTask, FileChange, GitHubContext } from '../types';
import { codeSearchTool, readFileTool, writeFileTool, editFileTool, createDiffTool } from '../tools/coding';
import { createBranchTool, commitTool, createPRTool, getFileTool } from '../tools/github';

type CodingAgentState = AgentState;

export class CodingAgent extends Agent<Env, CodingAgentState> {

  initialState: CodingAgentState = {
    currentTask: null,
    taskHistory: [],
    workingDirectory: null,
    gitBranch: null,
    pendingChanges: [],
  };

  /**
   * Execute a coding task
   */
  @callable({ description: 'Execute a coding task' })
  async executeTask(task: Omit<CodingTask, 'id' | 'status' | 'created_at'>): Promise<CodingTask> {
    const newTask: CodingTask = {
      ...task,
      id: crypto.randomUUID(),
      status: 'in_progress',
      created_at: Date.now(),
    };

    this.setState({
      ...this.state,
      currentTask: newTask,
    });

    try {
      const result = await this.runTask(newTask);

      const completedTask: CodingTask = {
        ...newTask,
        status: 'completed',
        output: result,
        completed_at: Date.now(),
      };

      this.setState({
        ...this.state,
        currentTask: null,
        taskHistory: [...this.state.taskHistory, completedTask],
      });

      return completedTask;
    } catch (error) {
      const failedTask: CodingTask = {
        ...newTask,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completed_at: Date.now(),
      };

      this.setState({
        ...this.state,
        currentTask: null,
        taskHistory: [...this.state.taskHistory, failedTask],
      });

      return failedTask;
    }
  }

  /**
   * Run the actual task based on type
   */
  private async runTask(task: CodingTask): Promise<Record<string, unknown>> {
    switch (task.type) {
      case 'search':
        return this.handleSearch(task.input);
      case 'read':
        return this.handleRead(task.input);
      case 'write':
        return this.handleWrite(task.input);
      case 'edit':
        return this.handleEdit(task.input);
      case 'diff':
        return this.handleDiff(task.input);
      case 'commit':
        return this.handleCommit(task.input);
      case 'pr':
        return this.handlePR(task.input);
      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }
  }

  /**
   * Search codebase using Vectorize
   */
  private async handleSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = input.query as string;
    const projectId = input.project_id as string | undefined;
    const topK = (input.top_k as number) || 10;

    // Use existing Vectorize search
    const embedding = await this.env.AI.run(this.env.EMBEDDING_MODEL as any, {
      text: query,
    });

    const results = await this.env.VECTORIZE.query(embedding.data[0], {
      topK,
      filter: projectId ? { project_id: projectId } : undefined,
      returnMetadata: 'all',
    });

    // Fetch chunk content from D1
    const chunks = await Promise.all(
      results.matches.map(async (match) => {
        const chunk = await this.env.DB.prepare(
          'SELECT c.*, f.relative_path, p.name as project_name FROM chunks c JOIN files f ON c.file_id = f.id JOIN projects p ON c.project_id = p.id WHERE c.id = ?'
        ).bind(match.id).first();
        return { ...chunk, score: match.score };
      })
    );

    return { results: chunks, query, total: chunks.length };
  }

  /**
   * Read file content
   */
  private async handleRead(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = input.path as string;
    const projectId = input.project_id as string;

    // Check if file is in our indexed content - fetch chunks individually
    const chunks = await this.env.DB.prepare(
      `SELECT c.content, c.start_line
       FROM files f
       JOIN chunks c ON f.id = c.file_id
       WHERE f.project_id = ? AND f.relative_path = ?
       ORDER BY c.start_line`
    ).bind(projectId, path).all();

    if (chunks.results.length > 0) {
      const content = chunks.results.map((c: any) => c.content).join('\n');
      return { path, content, source: 'indexed' };
    }

    // If GitHub context, fetch from GitHub
    const github = input.github as GitHubContext | undefined;
    if (github && this.env.GITHUB_TOKEN) {
      const content = await getFileTool(this.env.GITHUB_TOKEN, github, path);
      return { path, content, source: 'github' };
    }

    throw new Error(`File not found: ${path}`);
  }

  /**
   * Write file content (stages change, doesn't commit)
   */
  private async handleWrite(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = input.path as string;
    const content = input.content as string;

    const change: FileChange = {
      path,
      type: 'create',
      content,
    };

    this.setState({
      ...this.state,
      pendingChanges: [...this.state.pendingChanges, change],
    });

    // Store in R2 for retrieval
    const artifactKey = `changes/${this.name}/${Date.now()}/${path}`;
    await this.env.ARTIFACTS.put(artifactKey, content);

    return { path, staged: true, artifactKey };
  }

  /**
   * Edit file with diff
   */
  private async handleEdit(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = input.path as string;
    const oldContent = input.old_content as string;
    const newContent = input.new_content as string;

    const diff = createDiffTool(path, oldContent, newContent);

    const change: FileChange = {
      path,
      type: 'modify',
      diff,
      content: newContent,
    };

    this.setState({
      ...this.state,
      pendingChanges: [...this.state.pendingChanges, change],
    });

    // Store in R2
    const artifactKey = `changes/${this.name}/${Date.now()}/${path}`;
    await this.env.ARTIFACTS.put(artifactKey, newContent);
    await this.env.ARTIFACTS.put(`${artifactKey}.diff`, diff);

    return { path, staged: true, diff, artifactKey };
  }

  /**
   * Create diff between two contents
   */
  private async handleDiff(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = input.path as string;
    const oldContent = input.old_content as string;
    const newContent = input.new_content as string;

    const diff = createDiffTool(path, oldContent, newContent);
    return { path, diff };
  }

  /**
   * Commit pending changes to GitHub
   */
  private async handleCommit(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const message = input.message as string;
    const github = input.github as GitHubContext;

    if (!this.env.GITHUB_TOKEN) {
      throw new Error('GitHub token not configured');
    }

    if (this.state.pendingChanges.length === 0) {
      throw new Error('No pending changes to commit');
    }

    const result = await commitTool(
      this.env.GITHUB_TOKEN,
      github,
      message,
      this.state.pendingChanges
    );

    // Clear pending changes after commit
    this.setState({
      ...this.state,
      pendingChanges: [],
    });

    return result;
  }

  /**
   * Create a pull request
   */
  private async handlePR(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const title = input.title as string;
    const body = input.body as string;
    const github = input.github as GitHubContext;

    if (!this.env.GITHUB_TOKEN) {
      throw new Error('GitHub token not configured');
    }

    const result = await createPRTool(
      this.env.GITHUB_TOKEN,
      github,
      title,
      body
    );

    return result;
  }

  /**
   * Get current state for Claude CLI
   */
  @callable({ description: 'Get current agent state' })
  getState(): CodingAgentState {
    return this.state;
  }

  /**
   * Get pending changes
   */
  @callable({ description: 'Get pending file changes' })
  getPendingChanges(): FileChange[] {
    return this.state.pendingChanges;
  }

  /**
   * Clear pending changes
   */
  @callable({ description: 'Clear all pending changes' })
  clearPendingChanges(): void {
    this.setState({
      ...this.state,
      pendingChanges: [],
    });
  }

  /**
   * Set working context
   */
  @callable({ description: 'Set working directory and git context' })
  setContext(workingDirectory: string, gitBranch?: string): void {
    this.setState({
      ...this.state,
      workingDirectory,
      gitBranch: gitBranch || null,
    });
  }

  /**
   * Generate code using LLM
   */
  @callable({ description: 'Generate code using LLM' })
  async generateCode(prompt: string, context?: string): Promise<string> {
    const systemPrompt = `You are an expert code generator. Generate clean, well-documented code based on the user's request.
${context ? `\nContext:\n${context}` : ''}

Guidelines:
- Write production-quality code
- Include appropriate error handling
- Follow best practices for the language/framework
- Be concise but complete`;

    const result = await this.env.AI.run(this.env.LLM_MODEL as any, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
    });

    return result.response || '';
  }

  /**
   * Analyze code using reasoning model
   */
  @callable({ description: 'Analyze code for improvements or bugs' })
  async analyzeCode(code: string, analysisType: 'bugs' | 'improvements' | 'security' | 'general'): Promise<string> {
    const prompts: Record<string, string> = {
      bugs: 'Analyze this code for potential bugs, edge cases, and error conditions. Be specific about line numbers and issues.',
      improvements: 'Suggest improvements for this code including performance optimizations, readability, and best practices.',
      security: 'Analyze this code for security vulnerabilities including injection, authentication issues, and data exposure.',
      general: 'Provide a comprehensive code review covering bugs, improvements, and best practices.',
    };

    const result = await this.env.AI.run(this.env.REASONING_MODEL as any, {
      messages: [
        { role: 'system', content: prompts[analysisType] },
        { role: 'user', content: code },
      ],
      max_tokens: 2048,
    });

    return result.response || '';
  }
}
