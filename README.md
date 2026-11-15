# Bradestudio-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Bradestudio/Bradestudio-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Bradestudio/Bradestudio-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process (smart HTTP + REST v3 + GraphQL + MCP), scored 942 in the kit's sealed suite (120/120 checks, above the ~900 baseline).

## Run it

```sh
node main.ts
```

---


A standalone forge that serves, from a single process and its own in-memory
store, with **Node 22 stdlib only** (no dependencies, no git binary, no UI,
no outside service):

- **Git smart HTTP** — `git-upload-pack` protocol v2 (ls-refs, fetch with
  thin-pack / ofs-delta / shallow / deepen / deepen-relative) and v0, plus
  `git-receive-pack` (push, branch create/delete, non-fast-forward per-ref
  refusal, sideband report-status). Packs are plain (delta-free) objects with
  a correct SHA-1 trailer; verified object-for-object against real git 2.43.0
  (push, full clone, `--depth 1/2`, `--deepen`, `--unshallow`, pull, fetch).
- **REST v3** (`/api/v3`) — repos (create/get/patch/delete, pagination via
  `Link`), git refs, contents (create/update/delete with sha conflict 409),
  labels, issues (numbers, state, sort, comments), pull requests (diff files,
  squash merge, merge-conflict 405). Every reply is `application/json` with a
  non-empty `X-GitHub-Request-Id`.
- **GraphQL** (`/api/graphql`) — `viewer`, `repository`, `node`, issue/pull
  connections with cursor pagination, introspection (`__type`), mutations
  (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment),
  batched operations, and `noSuchFieldOnViewer` errors for unknown fields.
- **MCP** (`/mcp`, Streamable HTTP) — modern `server/discover` (2026-07-28)
  and legacy `initialize` (2025-11-25 and earlier), 6 required tools
  (create_repo, get_repo, create_issue, list_issues, create_pull_request,
  merge_pull_request) with aliases, byte-stable `tools/list`, JSON-RPC error
  codes, concurrent-call isolation.

## Ownership model

Bearer tokens are opaque: the viewer's login is learned from the owner
segment of the first authenticated repo-scoped request. Repos created via
`POST /user/repos` start unbound; the first repo-scoped request binds them
to that owner, and other owners then read 404 (not 403) for them.

## Run

```sh
node --experimental-strip-types main.ts   # binds port 0, registers with
                                          # $MAKEFUN_ENV_URL, polls /done
```

For local development, `main.ts` is the same lifecycle the sealed suite
uses; the server itself is `app.ts` (HTTP + routing + auth).

## Conformance (kit's sealed suite, run locally)

- **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15.
- **Score 942** = feature 600 + agent 200 + perf 142
  (house reference baseline ≈ 900: feature 600 + agent 200 + perf ~100).
  Perf p50 vs reference: push 691 ms (ref 1641 ms), clone 195 ms (267 ms),
  read 1578 ms (2760 ms), write 204 ms (349 ms).

## Layout

| file | what |
| --- | --- |
| `main.ts` | process lifecycle (bind → register → poll `/done`) |
| `app.ts` | HTTP server, routing, auth, request ids |
| `store.ts` | in-memory store, owner learning, repo/issue/pull state |
| `git.ts` | SHA-1 object model, pack read/write, v2/v0 smart HTTP |
| `api.ts` | REST v3 handlers |
| `graphql.ts` | GraphQL lexer/parser/executor |
| `mcp.ts` | MCP server/discover, initialize, tools |

---

<sub>Entered on [make.fun](https://make.fun/?ref=qjs4e9sj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
