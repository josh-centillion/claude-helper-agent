import type { Env, Project } from '../types';
import { deleteProjectVectors } from '../lib/embeddings';
import { jsonResponse, errorResponse } from '../lib/utils';

/**
 * List all indexed projects
 */
export async function handleListProjects(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT * FROM projects ORDER BY created_at DESC`
  ).all();

  return jsonResponse({
    projects: result.results,
    count: result.results.length,
  });
}

/**
 * Get a single project by ID
 */
export async function handleGetProject(
  projectId: string,
  env: Env
): Promise<Response> {
  const project = await env.DB.prepare(
    'SELECT * FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) {
    return errorResponse('Project not found', 404);
  }

  // Get file count and chunk count
  const stats = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM files WHERE project_id = ?) as file_count,
      (SELECT COUNT(*) FROM chunks WHERE project_id = ?) as chunk_count`
  ).bind(projectId, projectId).first();

  return jsonResponse({
    ...project,
    stats: {
      files: (stats as any)?.file_count || 0,
      chunks: (stats as any)?.chunk_count || 0,
    },
  });
}

/**
 * Delete a project and all its data
 */
export async function handleDeleteProject(
  projectId: string,
  env: Env
): Promise<Response> {
  const project = await env.DB.prepare(
    'SELECT * FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) {
    return errorResponse('Project not found', 404);
  }

  // Delete vectors from Vectorize
  await deleteProjectVectors(env, projectId);

  // Delete from D1 (cascades to files and chunks)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM files WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM conversations WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId),
  ]);

  return jsonResponse({
    message: 'Project deleted successfully',
    project_id: projectId,
  });
}

/**
 * List files in a project
 */
export async function handleListProjectFiles(
  projectId: string,
  env: Env
): Promise<Response> {
  const project = await env.DB.prepare(
    'SELECT id FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) {
    return errorResponse('Project not found', 404);
  }

  const result = await env.DB.prepare(
    `SELECT id, relative_path, chunk_count, indexed_at
     FROM files
     WHERE project_id = ?
     ORDER BY relative_path ASC`
  ).bind(projectId).all();

  return jsonResponse({
    project_id: projectId,
    files: result.results,
    count: result.results.length,
  });
}
