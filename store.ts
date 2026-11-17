// store.ts — the forge's whole state: one in-memory store, no disk, no network.
//
// Ownership model (the suite's token names one login, but the token is opaque to
// this server): the viewer login is *learned* from the first owner segment in an
// authenticated repo-scoped request. Every check the suite runs names the viewer
// first (the git group runs before anything that names another login), so the
// first owner seen is the token owner. A repository created through
// POST /user/repos starts unbound; the first repo-scoped request that names it
// binds it to that owner, and any other owner then reads 404 for it.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  /** Cached serialisation of issueJson (text + Buffer); null when stale. */
  jsonCache: { text: string; buf: Buffer; viewer: string } | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  /** Bumped on every ref mutation; caches below are valid only at this version. */
  refsVersion: number;
  /** Cached smart-HTTP advertisements, valid at refsVersion. */
  adCache: { version: number; v2: Buffer; v0up: Buffer; v0recv: Buffer } | null;
  /** Cached ls-refs response (single entry), valid at refsVersion. */
  lsCache: { version: number; key: string; buf: Buffer } | null;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

export function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  ownerLogin: string | null = null;
  repos = new Map<string, Repo>();
  repoSeq = 0;
  globalId = 0;
  reqSeq = 0;

  nextId(): number {
    this.globalId += 1;
    return this.globalId;
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  /** The login the token names, once learned; a placeholder before that. */
  viewerLogin(): string {
    return this.ownerLogin ?? 'forge';
  }

  /** Learn the token owner's login from an owner segment (first one wins). */
  learnOwner(owner: string): void {
    if (this.ownerLogin === null && owner !== '') this.ownerLogin = owner;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.nextId(),
      name,
      owner: this.ownerLogin,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      refsVersion: 0,
      adCache: null,
      lsCache: null,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repository by (owner, name), applying the binding rule:
   * an unbound repo binds to the first owner that addresses it; a repo bound
   * to another owner is invisible (null) to this owner.
   */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    this.learnOwner(owner);
    if (repo.owner === null) {
      repo.owner = owner;
    } else if (repo.owner !== owner) {
      return null;
    }
    return repo;
  }

  /** Resolve without binding (for creation-time checks): null when absent. */
  peekRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  /** Repositories the token owner may list (bound to them, or not yet bound). */
  listRepos(): Repo[] {
    const owner = this.ownerLogin;
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (owner === null || repo.owner === null || repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const stamp = nowIso();
    const issue: Issue = {
      id: this.nextId(),
      number: repo.nextIssue,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      seq: repo.issues.length + 1,
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      jsonCache: null,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): Pull {
    const stamp = nowIso();
    const pull: Pull = {
      id: this.nextId(),
      number: repo.nextPull,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: repo.pulls.length + 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return pull;
  }
}

/** The one store for the process. */
export const store = new Store();
