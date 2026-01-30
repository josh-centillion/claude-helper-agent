/**
 * GitHub API Tools
 *
 * Tools for interacting with GitHub repositories:
 * - Create branches
 * - Commit files
 * - Create pull requests
 * - Read files
 */

import type { FileChange, GitHubContext } from '../types';

const GITHUB_API = 'https://api.github.com';

/**
 * Get file content from GitHub
 */
export async function getFileTool(
  token: string,
  context: GitHubContext,
  path: string
): Promise<string> {
  const { owner, repo, branch } = context;

  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.raw',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get file: ${response.statusText}`);
  }

  return response.text();
}

/**
 * Create a new branch
 */
export async function createBranchTool(
  token: string,
  context: GitHubContext,
  branchName: string
): Promise<{ branch: string; sha: string }> {
  const { owner, repo, baseBranch } = context;

  // Get base branch SHA
  const baseResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!baseResponse.ok) {
    throw new Error(`Base branch not found: ${baseBranch}`);
  }

  const baseData = await baseResponse.json() as { object: { sha: string } };

  // Create new branch
  const createResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: baseData.object.sha,
      }),
    }
  );

  if (!createResponse.ok) {
    const error = await createResponse.json() as { message: string };
    throw new Error(`Failed to create branch: ${error.message}`);
  }

  return {
    branch: branchName,
    sha: baseData.object.sha,
  };
}

/**
 * Commit multiple file changes
 */
export async function commitTool(
  token: string,
  context: GitHubContext,
  message: string,
  changes: FileChange[]
): Promise<{ sha: string; url: string; files: number }> {
  const { owner, repo, branch } = context;

  // Get current commit SHA
  const refResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!refResponse.ok) {
    throw new Error(`Branch not found: ${branch}`);
  }

  const refData = await refResponse.json() as { object: { sha: string } };
  const baseSha = refData.object.sha;

  // Get base tree
  const commitResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${baseSha}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );
  const commitData = await commitResponse.json() as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each changed file
  const treeItems = await Promise.all(
    changes
      .filter((change) => change.type !== 'delete' && change.content)
      .map(async (change) => {
        const blobResponse = await fetch(
          `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              content: change.content,
              encoding: 'utf-8',
            }),
          }
        );
        const blobData = await blobResponse.json() as { sha: string };

        return {
          path: change.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blobData.sha,
        };
      })
  );

  // Add deletions
  const deletions = changes
    .filter((change) => change.type === 'delete')
    .map((change) => ({
      path: change.path,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: null,
    }));

  // Create tree
  const treeResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [...treeItems, ...deletions],
      }),
    }
  );
  const treeData = await treeResponse.json() as { sha: string };

  // Create commit
  const newCommitResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `${message}\n\n🤖 Committed by Claude Agents`,
        tree: treeData.sha,
        parents: [baseSha],
      }),
    }
  );
  const newCommitData = await newCommitResponse.json() as { sha: string; html_url: string };

  // Update branch ref
  await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sha: newCommitData.sha,
      }),
    }
  );

  return {
    sha: newCommitData.sha,
    url: newCommitData.html_url,
    files: changes.length,
  };
}

/**
 * Create a pull request
 */
export async function createPRTool(
  token: string,
  context: GitHubContext,
  title: string,
  body: string
): Promise<{ number: number; url: string; title: string }> {
  const { owner, repo, branch, baseBranch } = context;

  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        body: `${body}\n\n---\n🤖 Created by Claude Agents`,
        head: branch,
        base: baseBranch,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json() as { message: string };
    throw new Error(`Failed to create PR: ${error.message}`);
  }

  const pr = await response.json() as { number: number; html_url: string; title: string };

  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
  };
}

/**
 * Get repository info
 */
export async function getRepoInfoTool(
  token: string,
  owner: string,
  repo: string
): Promise<{
  default_branch: string;
  full_name: string;
  description: string | null;
  private: boolean;
}> {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Repository not found: ${owner}/${repo}`);
  }

  const data = await response.json() as {
    default_branch: string;
    full_name: string;
    description: string | null;
    private: boolean;
  };

  return {
    default_branch: data.default_branch,
    full_name: data.full_name,
    description: data.description,
    private: data.private,
  };
}

/**
 * List branches
 */
export async function listBranchesTool(
  token: string,
  owner: string,
  repo: string
): Promise<Array<{ name: string; sha: string }>> {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/branches`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to list branches`);
  }

  const branches = await response.json() as Array<{
    name: string;
    commit: { sha: string };
  }>;

  return branches.map((b) => ({
    name: b.name,
    sha: b.commit.sha,
  }));
}

/**
 * Get file tree for a path
 */
export async function getTreeTool(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string = 'main'
): Promise<Array<{ path: string; type: 'file' | 'dir'; size?: number }>> {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Path not found: ${path}`);
  }

  const contents = await response.json() as Array<{
    name: string;
    path: string;
    type: 'file' | 'dir';
    size?: number;
  }>;

  return contents.map((item) => ({
    path: item.path,
    type: item.type,
    size: item.size,
  }));
}
