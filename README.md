# github-core-clone-01 — a GitHub-compatible git forge in one Node 22 process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zaldie/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zaldie/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge, built for [the make.fun bounty](https://make.fun/bounty/github-core-clone-01):
git smart HTTP, REST v3, GraphQL v4 and MCP, in a single process with no dependencies, no git binary
and no network. Stdlib only (`node:http`, `node:crypto`, `node:zlib`).

## Grade-local score

Practice trial (grade-local, `--driver process`, Node 22.20.0):

| Column | Score |
| --- | --- |
| feature | **600 / 600** (120/120 conformance checks) |
| agent (MCP) | **200 / 200** (15/15 checks) |
| perf | **168 / 200** (push 45, clone 34, read 49, write 40) |
| **total** | **968 / 1000** (perf_p50_us 314256) |

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install: the program imports `node:http` and its own modules only, and the
trial has no package manager and no internet.

## Layout

- `main.ts`: the entry <-> env lifecycle (bind, register, poll `/done`, exit 0). Keep it as it is.
- `app.ts`: the HTTP server and routing — git smart HTTP, REST v3, GraphQL v4, MCP dispatch.
- `git.ts`: the pure-Node git object model — SHA-1 ids, pkt-line codec, packfile read/write
  (plain objects, version 2), tree/commit/tag build + parse, reachability, fast-forward checks.
- `store.ts`: the in-memory data model (repos, refs, issues, pulls, labels, comments) and the
  forge operations — commits, trees, diffs, squash merges, conflict detection.
- `graphql.ts`: a minimal GraphQL parser + executor for the documents the suite sends
  (viewer, repository, node, `__type` introspection, issues/pulls connections, the five mutations).
- `mcp.ts`: MCP over streamable HTTP — `server/discover` (2026-07-28), legacy `initialize`,
  `tools/list` and `tools/call` for the six forge tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, node, introspection, mutations |
| `POST /mcp` | Model Context Protocol: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

Notes on the wire contract, learned from the suite's own clients:

- **Protocol v2 fetch**: when the client sends `done`, the `acknowledgments` section MUST be
  omitted — the response goes straight to `shallow-info` / `packfile`.
- **Receive-pack report**: the report-status stream is itself pkt-lined inside sideband band 1.
- **Viewer login**: the token is opaque (`shpat_` + derived hex), so the viewer login is learned
  from the first owner-bearing request for an existing repo.
- **Determinism**: no `Date.now` / `Math.random` / UUIDs in responses or state; commit and
  response timestamps come from `MAKEFUN_TRIAL_NOW` (falling back to 2025-01-01T00:00:00Z).
- **Auth**: every `/api/v3`, `/api/graphql` and `/mcp` request needs `Authorization: Bearer
  $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is 401. Git endpoints take no auth.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only.

MIT licensed.
