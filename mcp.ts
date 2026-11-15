// mcp.ts — the Model Context Protocol surface (/mcp), Streamable HTTP.
//
// Plain JSON-RPC 2.0 over POST (the suite's client also accepts SSE, but a
// single JSON body is the transport's other legal answer). Both protocol
// eras are served: the modern 2026-07-28 `server/discover` and the legacy
// `initialize` handshake with a session id.

import { store } from './store.ts';
import { mergePullRequest, repoJson } from './api.ts';

// -------------------------------------------------------------------------------------------
// tool catalogue (byte-stable: tools/list answers the same JSON every time)
// -------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository in the forge.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findToolDef(name: string): McpToolDef | null {
  const normalized = normalizeName(name);
  for (const tool of TOOLS) {
    const wanted = [tool.name, ...(TOOL_ALIASES[tool.name] ?? [])].map(normalizeName);
    if (wanted.includes(normalized)) return tool;
    for (const suffix of wanted) {
      if (normalized.length > suffix.length && normalized.endsWith(suffix)) return tool;
    }
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------

function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = pick(args, ...names);
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(args: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = pick(args, ...names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

interface ToolOutcome {
  isError: boolean;
  payload: Record<string, unknown>;
}

function toolResult(payload: Record<string, unknown>, isError = false): ToolOutcome {
  return { isError, payload };
}

function toolError(message: string): ToolOutcome {
  return toolResult({ error: message }, true);
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = findToolDef(name);
  if (tool === null) return toolError(`Unknown tool: ${name}`);
  switch (tool.name) {
    case 'create_repo': {
      const repoName = pickString(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
      if (repoName === undefined || repoName === '') return toolError('Missing required argument: name');
      const description = pickString(args, 'description', 'about', 'summary', 'body') ?? '';
      const isPrivate = pick(args, 'private', 'is_private') === true;
      const created = store.createRepo(repoName, isPrivate, description);
      if (created === null) return toolError('Repository already exists');
      return toolResult(repoJson(created) as Record<string, unknown>);
    }
    case 'get_repo': {
      const owner = pickString(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace');
      const repoName = pickString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      if (owner === undefined || repoName === undefined) return toolError('Missing required arguments: owner, repo');
      const repo = store.findRepo(owner, repoName);
      if (repo === null) return toolError('Repository not found');
      return toolResult(repoJson(repo) as Record<string, unknown>);
    }
    case 'create_issue': {
      const owner = pickString(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace');
      const repoName = pickString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      const title = pickString(args, 'title', 'issue_title', 'pr_title', 'subject');
      if (owner === undefined || repoName === undefined || title === undefined) {
        return toolError('Missing required arguments: owner, repo, title');
      }
      const repo = store.findRepo(owner, repoName);
      if (repo === null) return toolError('Repository not found');
      const bodyText = pickString(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment') ?? '';
      const issue = store.createIssue(repo, title, bodyText, []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      });
    }
    case 'list_issues': {
      const owner = pickString(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace');
      const repoName = pickString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      if (owner === undefined || repoName === undefined) return toolError('Missing required arguments: owner, repo');
      const repo = store.findRepo(owner, repoName);
      if (repo === null) return toolError('Repository not found');
      const state = pickString(args, 'state', 'status') ?? 'open';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return toolResult({
        issues: list.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
        })),
      });
    }
    case 'create_pull_request': {
      const owner = pickString(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace');
      const repoName = pickString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      const title = pickString(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject');
      const head = pickString(args, 'head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch');
      const base = pickString(args, 'base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch');
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        return toolError('Missing required arguments: owner, repo, title, head, base');
      }
      const repo = store.findRepo(owner, repoName);
      if (repo === null) return toolError('Repository not found');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolError('Head or base branch does not exist');
      const open = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (open !== undefined) return toolError('A pull request already exists for this head and base');
      const bodyText = pickString(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment') ?? '';
      const pull = store.createPull(repo, title, bodyText, head, base, headSha, baseSha);
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        merged: pull.merged,
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
      });
    }
    case 'merge_pull_request': {
      const owner = pickString(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace');
      const repoName = pickString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      const number = pickNumber(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
      if (owner === undefined || repoName === undefined || number === undefined) {
        return toolError('Missing required arguments: owner, repo, pull_number');
      }
      const repo = store.findRepo(owner, repoName);
      if (repo === null) return toolError('Repository not found');
      const pull = repo.pullByNumber.get(number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.state !== 'open') return toolError('Pull request is already closed');
      const mergeSha = mergePullRequest(repo, pull);
      if (mergeSha === null) return toolError('Merge conflict');
      return toolResult({ merged: true, number: pull.number, sha: mergeSha, state: pull.state });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// -------------------------------------------------------------------------------------------
// JSON-RPC entry point
// -------------------------------------------------------------------------------------------

export interface McpResult {
  status: number;
  json: unknown | null;
  headers?: Record<string, string>;
}

const SESSION_ID = 'github-forge-session-1';

const DISCOVER_RESULT = {
  protocolVersion: '2026-07-28',
  supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
  capabilities: { tools: {} },
  serverInfo: { name: 'github-forge', version: '1.0.0' },
};

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpResult {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, error } };
}

function rpcResult(id: unknown, result: unknown, headers?: Record<string, string>): McpResult {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result }, headers };
}

export function handleMcp(rawBody: string): McpResult {
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const request = body as Record<string, unknown>;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  // A notification has no id: acknowledge it and send nothing back.
  if (id === undefined) {
    return { status: 202, json: null };
  }
  const params = (request.params !== null && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, DISCOVER_RESULT);
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const supported = DISCOVER_RESULT.supportedVersions;
      const version = requested !== null && supported.includes(requested) ? requested : '2025-11-25';
      return rpcResult(
        id,
        {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: 'github-forge', version: '1.0.0' },
        },
        { 'mcp-session-id': SESSION_ID },
      );
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      if (name === '') return rpcError(id, -32602, 'Invalid params: tool name is required');
      if (findToolDef(name) === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const outcome = callTool(name, args);
      const result: Record<string, unknown> = {
        content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
        structuredContent: outcome.payload,
      };
      if (outcome.isError) result.isError = true;
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
