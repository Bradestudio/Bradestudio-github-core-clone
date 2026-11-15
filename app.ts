// app.ts — the HTTP server: one process, its own store, four surfaces.
//
//   GET  /healthz                         the boot probe (no auth)
//   /api/v3/*                             the REST v3 API
//   POST /api/graphql                     GraphQL
//   POST /mcp                             MCP (Streamable HTTP, JSON-RPC 2.0)
//   /{owner}/{repo}/info/refs            git smart-HTTP advertisements
//   /{owner}/{repo}/git-upload-pack      git fetch / ls-refs (v2 and v0)
//   /{owner}/{repo}/git-receive-pack     git push (v0)
//
// Authentication: one bearer token, from MAKEFUN_SHOP_TOKEN. Every route
// except /healthz, GET /api/v3/ and GET /api/v3/meta requires it; a missing
// or wrong token is 401. When the variable is unset (local development), any
// non-empty bearer token is accepted, but a missing one is still refused.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleRest } from './api.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseUploadPackV2,
  advertiseV0,
  handleFetchV0,
  handleFetchV2Async,
  handleLsRefs,
  handleReceivePack,
} from './git.ts';

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** The bearer token a request presents, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1]!;
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN !== '' && token !== EXPECTED_TOKEN) return false;
  return true;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const body = value === null ? '' : JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
  };
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders);
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

export function createApp(): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal server error' });
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const segments = splitPath(pathname);

  // The boot probe.
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // MCP.
  if (pathname === '/mcp' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(raw.toString('utf8'));
    if (result.json === null) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json, result.headers);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
      return;
    }
    const result = handleGraphql(parsed.value);
    sendJson(res, result.status, result.json);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname === '/api/v3/' || pathname.startsWith('/api/v3/')) {
    const restSegments = segments.slice(2);
    const isRoot = restSegments.length === 0;
    const isMeta = restSegments.length === 1 && restSegments[0] === 'meta';
    if (!(isRoot && method === 'GET') && !(isMeta && method === 'GET') && !authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Request body is not valid JSON' });
        return;
      }
      body = parsed.value;
    }
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const result = handleRest(method, restSegments, url.searchParams, body, origin);
    sendJson(res, result.status, result.json, result.headers);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}/info/refs, git-upload-pack, git-receive-pack.
  // The git client addresses repositories as <name>.git; the suffix is not part of the name.
  const gitRepoName = (raw: string): string => (raw.endsWith('.git') ? raw.slice(0, -4) : raw);
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeURIComponent(segments[0]!);
    const repoName = gitRepoName(decodeURIComponent(segments[1]!));
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      // Protocol v2 only when the client asks for it; a v0 client gets the
      // v0 ref advertisement instead.
      const protocol = (req.headers['git-protocol'] ?? '').toString();
      if (protocol.includes('version=2')) {
        sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseUploadPackV2(repo));
      } else {
        sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV0(repo, 'git-upload-pack'));
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'git-receive-pack'));
      return;
    }
    sendJson(res, 400, { message: 'Unknown service' });
    return;
  }
  if (segments.length === 3 && segments[2] === 'git-upload-pack' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeURIComponent(segments[0]!);
    const repoName = gitRepoName(decodeURIComponent(segments[1]!));
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const protocol = (req.headers['git-protocol'] ?? '').toString();
    try {
      if (protocol.includes('version=2')) {
        const text = raw.toString('utf8');
        if (text.includes('command=ls-refs')) {
          sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, raw));
        } else {
          const response = await handleFetchV2Async(repo, raw);
          sendBuffer(res, 200, 'application/x-git-upload-pack-result', response);
        }
      } else {
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, raw));
      }
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad git request' });
    }
    return;
  }
  if (segments.length === 3 && segments[2] === 'git-receive-pack' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeURIComponent(segments[0]!);
    const repoName = gitRepoName(decodeURIComponent(segments[1]!));
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    try {
      sendBuffer(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, raw));
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad git request' });
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
