// api.ts — the GitHub REST v3 surface (/api/v3).
//
// Pure request handling: the HTTP layer (app.ts) parses the request and
// serialises the {status, json, headers} this returns. All state lives in
// store.ts; all git object work goes through git.ts.

import type { Issue, Pull, Repo } from './store.ts';
import { store, ZERO_OID, nowIso } from './store.ts';
import {
  buildCommit,
  buildTree,
  clearFetchCache,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTree,
  putObject,
  treeDirLookup,
  treeLookup,
  treeSetPath,
} from './git.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const ok = (json: unknown, status = 200, headers?: Record<string, string>): RestResult => ({ status, json, headers });
const err = (status: number, message: string): RestResult => ({ status, json: { message } });

export function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin();
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoFromSeq(repo.createdSeq),
    updated_at: isoFromSeq(repo.createdSeq),
    has_issues: true,
    fork: false,
  };
}

/** A stable ISO timestamp derived from a creation sequence (deterministic). */
function isoFromSeq(seq: number): string {
  return new Date(1_700_000_000_000 + seq * 1_000).toISOString();
}

export function repoNodeId(repo: Repo): string {
  return Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64url');
}

export function issueNodeId(repo: Repo, issue: Issue): string {
  return Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url');
}

export function pullNodeId(repo: Repo, pull: Pull): string {
  return Buffer.from(`pull:${repo.id}:${pull.number}`, 'utf8').toString('base64url');
}

export function commentNodeId(repo: Repo, issue: Issue, commentId: number): string {
  return Buffer.from(`comment:${repo.id}:${issue.number}:${commentId}`, 'utf8').toString('base64url');
}

export function decodeNodeId(id: string): { kind: string; repoId: number; number?: number; commentId?: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'repo' && parts.length === 2) return { kind: 'repo', repoId: Number(parts[1]) };
    if (parts[0] === 'issue' && parts.length === 3) {
      return { kind: 'issue', repoId: Number(parts[1]), number: Number(parts[2]) };
    }
    if (parts[0] === 'pull' && parts.length === 3) {
      return { kind: 'pull', repoId: Number(parts[1]), number: Number(parts[2]) };
    }
    if (parts[0] === 'comment' && parts.length === 4) {
      return { kind: 'comment', repoId: Number(parts[1]), number: Number(parts[2]), commentId: Number(parts[3]) };
    }
    return null;
  } catch {
    return null;
  }
}

export function findRepoByDbId(dbId: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: store.viewerLogin(), id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin();
  return {
    id: pull.id,
    node_id: pullNodeId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    user: { login: owner, id: 1, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentNodeId(repo, issue, comment.id),
    body: comment.body,
    user: { login: store.viewerLogin(), id: 1, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// -------------------------------------------------------------------------------------------
// git helpers for the contents API and merges
// -------------------------------------------------------------------------------------------

function authorLine(): string {
  const login = store.viewerLogin();
  return `${login} <${login}@example.invalid>`;
}

/** Resolve a ref name (branch, full ref, or commit oid) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return null;
}

/** Commits reachable from `tip`, newest first, following first parents. */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | null = tip;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    out.push(current);
    const parents = parseCommit(object.data).parents;
    current = parents.length > 0 ? parents[0]! : null;
  }
  return out;
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid)!;
  const commit = parseCommit(object.data);
  // The stored commit message ends with a newline (git convention); the API
  // surface reports it without the trailing newline.
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  return {
    sha: oid,
    commit: {
      message,
      author: { name: authorLine(), date: nowIso() },
      committer: { name: authorLine(), date: nowIso() },
    },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

/**
 * Create a commit on `branch` that sets `segments` to `content` (or deletes
 * the path when content is null). Creates the branch from the default branch
 * when it does not exist yet. Returns the new commit oid.
 */
function commitFile(
  repo: Repo,
  branch: string,
  segments: string[],
  content: Buffer | null,
  message: string,
): string {
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  let parentTree: string | null = null;
  if (tip === undefined) {
    // A new branch starts from the default branch tip (or from nothing).
    const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    tip = base;
    if (base !== undefined) {
      parentTree = parseCommit(repo.objects.get(base)!.data).tree;
    }
  } else {
    parentTree = parseCommit(repo.objects.get(tip)!.data).tree;
  }
  const blobOid = content === null ? null : putObject(repo, 'blob', content);
  const newTree = treeSetPath(repo, parentTree, segments, blobOid);
  const stamp = Math.floor(Date.now() / 1000);
  const identity = authorLine();
  const commitData = buildCommit({
    tree: newTree,
    parents: tip === undefined ? [] : [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: identity,
    committer: identity,
    timestamp: stamp,
  });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitOid);
  clearFetchCache();
  return commitOid;
}

// -------------------------------------------------------------------------------------------
// pull-request files and merging
// -------------------------------------------------------------------------------------------

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

function blobText(repo: Repo, oid: string | null): string {
  if (oid === null) return '';
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** The file diff between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from !== undefined && to === undefined) {
      const deletions = countLines(blobText(repo, from.oid));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (from === undefined && to !== undefined) {
      const additions = countLines(blobText(repo, to.oid));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const counts = diffLineCounts(blobText(repo, from.oid), blobText(repo, to.oid));
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return out;
}

/** Whether merging `pull` now would conflict with the base branch tip. */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (headTip === undefined) return false;
  const baseAtCreation = repo.objects.get(pull.baseSha);
  const headObject = repo.objects.get(headTip);
  const currentBaseObject = repo.objects.get(baseTip);
  if (baseAtCreation === undefined || headObject === undefined || currentBaseObject === undefined) return false;
  if (baseAtCreation.type !== 'commit' || headObject.type !== 'commit' || currentBaseObject.type !== 'commit') return false;
  const mergeBaseTree = parseCommit(baseAtCreation.data).tree;
  const headTree = parseCommit(headObject.data).tree;
  const currentTree = parseCommit(currentBaseObject.data).tree;
  const changed = diffTrees(repo, mergeBaseTree, headTree);
  const currentFlat = flattenTree(repo, currentTree);
  const baseFlat = flattenTree(repo, mergeBaseTree);
  const headFlat = flattenTree(repo, headTree);
  for (const change of changed) {
    const baseEntry = baseFlat.get(change.filename);
    const currentEntry = currentFlat.get(change.filename);
    const headEntry = headFlat.get(change.filename);
    const currentOid = currentEntry?.oid ?? null;
    const baseOid = baseEntry?.oid ?? null;
    const headOid = headEntry?.oid ?? null;
    if (currentOid !== baseOid && currentOid !== headOid) return true;
  }
  return false;
}

export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  if (repo.refs.get(`refs/heads/${pull.headRef}`) === undefined) return 'UNKNOWN';
  if (repo.refs.get(`refs/heads/${pull.baseRef}`) === undefined) return 'UNKNOWN';
  return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge an open pull request onto its base branch. Returns the merge sha, or null on conflict. */
export function mergePullRequest(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  if (pullConflicts(repo, pull)) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const headObject = repo.objects.get(headTip);
  if (headObject === undefined || headObject.type !== 'commit') return null;
  const headTree = parseCommit(headObject.data).tree;
  const stamp = Math.floor(Date.now() / 1000);
  const identity = authorLine();
  const message = pull.title === '' ? `Merge pull request #${pull.number}\n` : `${pull.title}\n`;
  const commitData = buildCommit({
    tree: headTree,
    parents: [baseTip],
    message,
    author: identity,
    committer: identity,
    timestamp: stamp,
  });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeSha = mergeSha;
  pull.updatedAt = nowIso();
  clearFetchCache();
  return mergeSha;
}

// -------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------

function parseBodyObject(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNum: number; perPage: number } {
  const perPage = queryInt(query, 'per_page', 30);
  const pageNum = queryInt(query, 'page', 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, pageNum, perPage };
}

export function handleRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestResult {
  const seg = (index: number): string | undefined => segments[index];
  const rest = (index: number): string => segments.slice(index).join('/');

  // GET /api/v3/ — the API root (no auth needed; app.ts routes here before auth).
  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        200,
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return err(404, 'Not Found');
  }
  if (seg(0) === 'meta' && segments.length === 1) {
    if (method === 'GET') return ok({ installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }
  if (seg(0) === 'user') {
    if (segments.length === 1 && method === 'GET') {
      return ok({ login: store.viewerLogin(), id: 1, type: 'User' });
    }
    if (seg(1) === 'repos' && segments.length === 2) {
      if (method === 'POST') {
        const input = parseBodyObject(body);
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '') return err(422, 'Repository name is required');
        const created = store.createRepo(name, input.private === true, typeof input.description === 'string' ? input.description : '');
        if (created === null) return err(422, 'Repository already exists');
        clearFetchCache();
        return ok(repoJson(created), 201);
      }
      if (method === 'GET') {
        const all = store.listRepos();
        const { page, hasNext, pageNum, perPage } = paginate(all, query);
        const headers: Record<string, string> = {};
        if (hasNext) {
          const nextUrl = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${pageNum + 1}`;
          headers.link = `<${nextUrl}>; rel="next"`;
        }
        return ok(page.map((repo) => repoJson(repo)), 200, headers);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (seg(0) !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = decodeURIComponent(seg(1)!);
  const repoName = decodeURIComponent(seg(2)!);
  const repo = store.findRepo(owner, repoName);
  if (repo === null) return err(404, 'Not Found');

  // /repos/{o}/{r}
  if (segments.length === 3) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const input = parseBodyObject(body);
      if (typeof input.description === 'string') repo.description = input.description;
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      clearFetchCache();
      return { status: 204, json: null };
    }
    return err(404, 'Not Found');
  }

  const sub = seg(3)!;
  if (sub === 'git') {
    return handleGitRefs(method, segments, repo, body);
  }
  if (sub === 'branches') {
    if (method === 'GET' && segments.length === 4) {
      const out: Array<Record<string, unknown>> = [];
      const names = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
      for (const name of names) {
        out.push({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name)! } });
      }
      return ok(out);
    }
    if (method === 'GET' && segments.length > 4) {
      const branch = rest(4);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha: tip } });
    }
    return err(404, 'Not Found');
  }
  if (sub === 'commits') {
    if (method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (tip === null) return err(404, 'Not Found');
      const commits = listCommits(repo, tip).map((oid) => commitJson(repo, oid));
      return ok(commits);
    }
    return err(404, 'Not Found');
  }
  if (sub === 'contents') {
    return handleContents(method, segments, query, repo, body);
  }
  if (sub === 'labels') {
    if (method === 'POST') {
      const input = parseBodyObject(body);
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return err(422, 'Label name is required');
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok({ name, color: existing.color }, 201);
      repo.labels.set(name, { name, color });
      return ok({ name, color }, 201);
    }
    if (method === 'GET') {
      return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    return err(404, 'Not Found');
  }
  if (sub === 'issues') {
    return handleIssues(method, segments, query, repo, body);
  }
  if (sub === 'pulls') {
    return handlePulls(method, segments, query, repo, body);
  }
  return err(404, 'Not Found');
}

function handleGitRefs(method: string, segments: string[], repo: Repo, body: unknown): RestResult {
  // POST /repos/{o}/{r}/git/refs — create a ref.
  if (segments.length === 5 && segments[4] === 'refs' && method === 'POST') {
    const input = parseBodyObject(body);
    const ref = typeof input.ref === 'string' ? input.ref : '';
    const sha = typeof input.sha === 'string' ? input.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Invalid ref or sha');
    if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    clearFetchCache();
    return ok({ ref, object: { sha, type: repo.objects.get(sha)!.type } }, 201);
  }
  // GET /repos/{o}/{r}/git/refs/<ref...> — read one ref.
  if (segments.length > 5 && segments[4] === 'refs' && method === 'GET') {
    const ref = segments.slice(5).join('/');
    const oid = repo.refs.get(ref);
    if (oid === undefined) return err(404, 'Not Found');
    return ok({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
  }
  return err(404, 'Not Found');
}

function handleContents(
  method: string,
  segments: string[],
  query: URLSearchParams,
  repo: Repo,
  body: unknown,
): RestResult {
  const path = segments.slice(4).join('/');
  if (path === '') return err(404, 'Not Found');
  const pathSegments = path.split('/').map((segment) => decodeURIComponent(segment));
  const refParam = query.get('ref');
  const branch = refParam ?? repo.defaultBranch;

  if (method === 'GET') {
    const tip = resolveRef(repo, branch);
    if (tip === null) return err(404, 'Not Found');
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return err(404, 'Not Found');
    const treeOid = parseCommit(commit.data).tree;
    const blobOid = treeLookup(repo, treeOid, pathSegments);
    if (blobOid !== null) {
      const blob = repo.objects.get(blobOid)!;
      return ok({
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: blobOid,
        size: blob.data.length,
        name: pathSegments[pathSegments.length - 1],
        path,
      });
    }
    const dirOid = treeDirLookup(repo, treeOid, pathSegments);
    if (dirOid !== null) {
      const entries = parseTree(repo.objects.get(dirOid)!.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
      }));
      return ok(entries);
    }
    return err(404, 'Not Found');
  }

  if (method === 'PUT') {
    const input = parseBodyObject(body);
    const message = typeof input.message === 'string' ? input.message : 'Update file';
    const contentB64 = typeof input.content === 'string' ? input.content : '';
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const branchName = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const sha = typeof input.sha === 'string' ? input.sha : undefined;
    const branchTip = repo.refs.get(`refs/heads/${branchName}`);
    let currentBlob: string | null = null;
    if (branchTip !== undefined) {
      const treeOid = parseCommit(repo.objects.get(branchTip)!.data).tree;
      currentBlob = treeLookup(repo, treeOid, pathSegments);
    }
    if (currentBlob !== null) {
      if (sha === undefined) return err(422, 'sha is required to update a file');
      if (sha.toLowerCase() !== currentBlob.toLowerCase()) return err(409, 'The file has changed since it was read');
      const commitOid = commitFile(repo, branchName, pathSegments, content, message);
      const blobOid = hashObject('blob', content);
      return ok({ content: { name: pathSegments[pathSegments.length - 1], path, sha: blobOid, size: content.length, encoding: 'base64' }, commit: { sha: commitOid } }, 200);
    }
    if (sha !== undefined) return err(422, 'Invalid sha for a file that does not exist');
    const commitOid = commitFile(repo, branchName, pathSegments, content, message);
    const blobOid = hashObject('blob', content);
    return ok({ content: { name: pathSegments[pathSegments.length - 1], path, sha: blobOid, size: content.length, encoding: 'base64' }, commit: { sha: commitOid } }, 201);
  }

  if (method === 'DELETE') {
    const input = parseBodyObject(body);
    const message = typeof input.message === 'string' ? input.message : 'Delete file';
    const sha = typeof input.sha === 'string' ? input.sha : undefined;
    const branchTip = repo.refs.get(`refs/heads/${branch}`);
    if (branchTip === undefined) return err(404, 'Not Found');
    const treeOid = parseCommit(repo.objects.get(branchTip)!.data).tree;
    const currentBlob = treeLookup(repo, treeOid, pathSegments);
    if (currentBlob === null) return err(404, 'Not Found');
    if (sha !== undefined && sha.toLowerCase() !== currentBlob.toLowerCase()) return err(409, 'The file has changed since it was read');
    const commitOid = commitFile(repo, branch, pathSegments, null, message);
    return ok({ commit: { sha: commitOid } });
  }
  return err(404, 'Not Found');
}

function handleIssues(
  method: string,
  segments: string[],
  query: URLSearchParams,
  repo: Repo,
  body: unknown,
): RestResult {
  if (segments.length === 4) {
    if (method === 'POST') {
      const input = parseBodyObject(body);
      const title = typeof input.title === 'string' ? input.title : '';
      const issueBody = typeof input.body === 'string' ? input.body : '';
      const labels = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
      }
      const issue = store.createIssue(repo, title, issueBody, labels);
      return ok(issueJson(repo, issue), 201);
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page } = paginate(list, query);
      return ok(page.map((issue) => issueJson(repo, issue)));
    }
    return err(404, 'Not Found');
  }
  const number = Number(segments[4]);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
  const issue = repo.issueByNumber.get(number);
  if (segments.length === 5) {
    if (issue === undefined) return err(404, 'Not Found');
    if (method === 'GET') return ok(issueJson(repo, issue));
    if (method === 'PATCH') {
      const input = parseBodyObject(body);
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      issue.updatedAt = nowIso();
      return ok(issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (segments.length === 6 && segments[5] === 'comments') {
    if (issue === undefined) return err(404, 'Not Found');
    if (method === 'POST') {
      const input = parseBodyObject(body);
      const text = typeof input.body === 'string' ? input.body : '';
      const stamp = nowIso();
      const comment = { id: repo.nextComment, body: text, createdAt: stamp, updatedAt: stamp };
      repo.nextComment += 1;
      issue.comments.push(comment);
      return ok(commentJson(repo, issue, comment), 201);
    }
    if (method === 'GET') {
      return ok(issue.comments.map((comment) => commentJson(repo, issue, comment)));
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function handlePulls(
  method: string,
  segments: string[],
  query: URLSearchParams,
  repo: Repo,
  body: unknown,
): RestResult {
  if (segments.length === 4) {
    if (method === 'POST') {
      const input = parseBodyObject(body);
      const title = typeof input.title === 'string' ? input.title : '';
      const pullBody = typeof input.body === 'string' ? input.body : '';
      const head = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'Head or base branch does not exist');
      const open = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (open !== undefined) return err(422, 'A pull request already exists for this head and base');
      const pull = store.createPull(repo, title, pullBody, head, base, headSha, baseSha);
      return ok(pullJson(repo, pull), 201);
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      const { page } = paginate(list, query);
      return ok(page.map((pull) => pullJson(repo, pull)));
    }
    return err(404, 'Not Found');
  }
  const number = Number(segments[4]);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
  const pull = repo.pullByNumber.get(number);
  if (segments.length === 5) {
    if (pull === undefined) return err(404, 'Not Found');
    if (method === 'GET') return ok(pullJson(repo, pull));
    return err(404, 'Not Found');
  }
  if (segments.length === 6 && segments[5] === 'files') {
    if (pull === undefined) return err(404, 'Not Found');
    if (method === 'GET') {
      const baseObject = repo.objects.get(pull.baseSha);
      const headObject = repo.objects.get(pull.headSha);
      if (baseObject === undefined || headObject === undefined) return err(404, 'Not Found');
      if (baseObject.type !== 'commit' || headObject.type !== 'commit') return err(404, 'Not Found');
      const files = diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
      return ok(files);
    }
    return err(404, 'Not Found');
  }
  if (segments.length === 6 && segments[5] === 'merge') {
    if (pull === undefined) return err(404, 'Not Found');
    if (method === 'PUT') {
      if (pull.state !== 'open') return err(405, 'Pull request is already closed');
      const mergeSha = mergePullRequest(repo, pull);
      if (mergeSha === null) return err(405, 'Merge conflict');
      return ok({ merged: true, sha: mergeSha, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// Re-exported for the GraphQL and MCP surfaces.
export { collectReachable };
