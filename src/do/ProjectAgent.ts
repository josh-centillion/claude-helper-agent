import type { DurableObject, DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types';

interface ProjectAgentState {
  projectId: string;
  projectName: string;
  lastActivity: number;
  indexingStatus: 'idle' | 'indexing' | 'error';
  context: string[];
}

/**
 * Durable Object for managing per-project state and context
 */
export class ProjectAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private agentState: ProjectAgentState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async loadState(): Promise<ProjectAgentState> {
    if (this.agentState) return this.agentState;

    const stored = await this.state.storage.get<ProjectAgentState>('state');
    this.agentState = stored || {
      projectId: '',
      projectName: '',
      lastActivity: Date.now(),
      indexingStatus: 'idle',
      context: [],
    };
    return this.agentState;
  }

  private async saveState(): Promise<void> {
    if (this.agentState) {
      await this.state.storage.put('state', this.agentState);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/init':
          return this.handleInit(request);
        case '/status':
          return this.handleStatus();
        case '/context':
          return this.handleContext(request);
        case '/clear':
          return this.handleClear();
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500 }
      );
    }
  }

  /**
   * Initialize the project agent
   */
  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json() as { projectId: string; projectName: string };
    const state = await this.loadState();

    state.projectId = body.projectId;
    state.projectName = body.projectName;
    state.lastActivity = Date.now();

    await this.saveState();

    return new Response(JSON.stringify({ success: true, state }));
  }

  /**
   * Get current status
   */
  private async handleStatus(): Promise<Response> {
    const state = await this.loadState();
    return new Response(JSON.stringify(state));
  }

  /**
   * Add context from a query
   */
  private async handleContext(request: Request): Promise<Response> {
    const body = await request.json() as { context: string };
    const state = await this.loadState();

    // Keep last 10 context items
    state.context.push(body.context);
    if (state.context.length > 10) {
      state.context = state.context.slice(-10);
    }
    state.lastActivity = Date.now();

    await this.saveState();

    return new Response(JSON.stringify({ success: true, contextCount: state.context.length }));
  }

  /**
   * Clear agent state
   */
  private async handleClear(): Promise<Response> {
    await this.state.storage.deleteAll();
    this.agentState = null;

    return new Response(JSON.stringify({ success: true }));
  }
}
