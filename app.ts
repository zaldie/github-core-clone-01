// app.ts — the forge's HTTP server: git smart HTTP (upload-pack v2,
// receive-pack v0), REST v3, GraphQL v4 and MCP, on one in-memory store.
// Deterministic (fixed timestamps), stdlib only, no network, no git binary.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DELIM,
  FLUSH,
  ZERO_OID,
  decodePktLines,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  reachableSet,
  sideband,
  storeObject,
  writePack,
  type GitObject,
} from './git.ts';
import { Store, fixedEpochSeconds, fixedIso, type Issue, type Pull, type Repo } from './store.ts';
import { executeGraphQL, gidComment, gidIssue, gidPull, gidRepo } from './graphql.ts';
import { handleMcpMessage } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS = `multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet agent=${AGENT}`;

// ---------------------------------------------------------------------------
// Per-repo response caches (perf: the clone/read hot paths repeat identical
// requests — 50 concurrent depth-1 clones of one tip, 2000 GETs of one issue).
//
// Correctness notes (why a cached response can never go stale):
//  - Upload-pack fetch responses (v2 and v0) are a pure function of the
//    request args and the objects reachable from the wants/haves. Objects
//    are content-addressed and immutable, the object map is append-only
//    (nothing ever deletes or overwrites an object; deleting a repo drops
//    the whole Repo), so the same args against the same Repo always yield
//    the same bytes. The cache is keyed by the full request args and lives
//    in a WeakMap keyed by the Repo object, so a deleted + recreated repo
//    never reuses an entry.
//  - ls-refs and the v0 advertisement depend on the refs, so their keys
//    carry a fingerprint of the whole ref map. The v2 advertisement is
//    fully static and built once.
//  - A serialized single-issue body is cached per (issue number, rev,
//    owner): every mutation of an issue (REST PATCH/comment, GraphQL
//    closeIssue/addComment) bumps issue.rev, and the owner login is part
//    of the entry. Only the body is cached — sendRaw still sets a fresh
//    x-github-request-id per request, exactly like sendJson.
//  - All cached Buffers are never mutated after creation (res.end does not
//    mutate its argument), so sharing them across requests is safe.
//  - Every cache is bounded (FIFO eviction) so a long trial cannot grow
//    memory without limit.
interface RepoCaches {
  /** v0 advertisement per service, keyed by `service + refs fingerprint`. */
  adV0: Map<string, Buffer>;
  /** v2 ls-refs responses, keyed by `refs fingerprint + request args`. */
  lsRefs: Map<string, Buffer>;
  /** Upload-pack fetch responses, keyed by protocol + full request args. */
  fetch: Map<string, Buffer>;
  /** Serialized single-issue JSON bodies, keyed by issue number. */
  issueJson: Map<number, { rev: number; owner: string; body: Buffer }>;
}

const repoCaches = new WeakMap<Repo, RepoCaches>();

function cachesFor(repo: Repo): RepoCaches {
  let c = repoCaches.get(repo);
  if (!c) {
    c = { adV0: new Map(), lsRefs: new Map(), fetch: new Map(), issueJson: new Map() };
    repoCaches.set(repo, c);
  }
  return c;
}

/** Insert into a bounded cache, evicting the oldest entry when full. */
function cacheSet(map: Map<string, Buffer>, key: string, value: Buffer, maxEntries: number): void {
  if (map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Fingerprint of a repo's whole ref map (same refs => same string). */
function refsFingerprint(repo: Repo): string {
  let fp = '';
  for (const [name, oid] of repo.refs) fp += `${name}=${oid};`;
  return fp;
}

/** The v0 advertisement for a service, cached per ref state. */
function cachedV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const c = cachesFor(repo);
  const key = `${service}\n${refsFingerprint(repo)}`;
  let buf = c.adV0.get(key);
  if (!buf) {
    buf = v0Advertisement(service, repo);
    cacheSet(c.adV0, key, buf, 64);
  }
  return buf;
}

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? m[1] : null;
}

/** Auth gate for the API surfaces: no token -> 401; wrong token -> 401. */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return token === expected;
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => {
    if (!s.includes('%')) return s;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: repo.id,
    node_id: gidRepo(repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    created_at: fixedIso(),
    updated_at: fixedIso(),
    pushed_at: fixedIso(),
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: issue.id,
    node_id: gidIssue(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: owner },
    assignee: null,
    comments: issue.comments.length,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    created_at: fixedIso(),
    updated_at: fixedIso(),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: pull.number,
    node_id: gidPull(repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: owner },
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    created_at: fixedIso(),
    updated_at: fixedIso(),
  };
}

// ---------------------------------------------------------------------------
// Git protocol helpers
// ---------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** All refs of a repo as advertisement lines (HEAD first). */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const heads = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? (heads.length > 0 ? (repo.refs.get(heads[0]) ?? '') : '');
  if (mainTip !== '') {
    out.push({ oid: mainTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  for (const ref of heads) out.push({ oid: repo.refs.get(ref) as string, name: ref });
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const line: RefLine = { oid, name: ref };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') line.peeled = parseTag(obj.data).object;
    out.push(line);
  }
  return out;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const first = lines[0];
    parts.push(pktLine(`${first.oid} ${first.name}\0${caps}\n`));
    for (let i = 1; i < lines.length; i += 1) {
      parts.push(pktLine(`${lines[i].oid} ${lines[i].name}\n`));
    }
    // Peeled lines for annotated tags.
    for (const l of lines) {
      if (l.name.startsWith('refs/tags/') && l.peeled) parts.push(pktLine(`${l.peeled} ${l.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The protocol-v2 capability advertisement: fully static, built once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${AGENT}\n`),
  FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** Objects to send for a fetch: closure(wants, depth) minus closure(haves - shallow). */
function fetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const objects = repo.objects;
  // Peel tag wants to commits for depth counting.
  const peeledWants: string[] = [];
  const tagWants: string[] = [];
  for (const w of wants) {
    const obj = objects.get(w);
    if (obj?.type === 'tag') {
      tagWants.push(w);
      const target = parseTag(obj.data).object;
      if (target !== '' && isOid(target)) peeledWants.push(target);
    } else if (obj?.type === 'commit') {
      peeledWants.push(w);
    }
  }
  // BFS over parents with a depth limit (depth 1 = wants only).
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of peeledWants) {
    if (!dist.has(w)) {
      dist.set(w, 0);
      queue.push(w);
    }
  }
  const maxDist = depth === null ? Number.POSITIVE_INFINITY : depth - 1;
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = dist.get(oid) as number;
    if (d >= maxDist) continue;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  // Exclusion set: closure(haves) minus closure(shallow boundaries).
  const haveClosure = reachableSet(objects, haves);
  const shallowClosure = reachableSet(objects, shallowBoundaries);
  const excluded = new Set<string>();
  for (const oid of haveClosure) {
    if (!shallowClosure.has(oid)) excluded.add(oid);
  }
  // Collect the send set: included commits + their trees/blobs + tag objects.
  const send = new Set<string>();
  for (const oid of dist.keys()) {
    if (excluded.has(oid)) continue;
    send.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const tree = parseCommit(obj.data).tree;
    const stack = [tree];
    while (stack.length > 0) {
      const t = stack.pop() as string;
      if (t === '' || send.has(t) || excluded.has(t)) continue;
      send.add(t);
      const tobj = objects.get(t);
      if (!tobj || tobj.type !== 'tree') continue;
      for (const e of parseTree(tobj.data)) {
        if (e.mode === '40000') stack.push(e.oid);
        else if (!excluded.has(e.oid)) send.add(e.oid);
      }
    }
  }
  for (const t of tagWants) {
    if (!excluded.has(t)) send.add(t);
  }
  const out: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const obj = objects.get(oid);
    if (obj) out.push(obj);
  }
  // Shallow-info: included commits at distance maxDist (when depth is finite).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of dist) {
      if (d === maxDist) shallow.push(oid);
    }
    // Old boundaries that now have their parents included.
    for (const b of shallowBoundaries) {
      if (!dist.has(b)) continue;
      const obj = objects.get(b);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => dist.has(p))) unshallow.push(b);
    }
  }
  return { objects: out, shallow, unshallow };
}

function packResponse(objects: GitObject[]): Buffer {
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    parts.push(sideband(1, pack.subarray(i, Math.min(pack.length, i + CHUNK))));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const store = new Store();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handleRequest(store, req, res);
    } catch (err) {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          res.end();
        }
      } else {
        res.end();
      }
    }
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Parse the URL once; every handler below reuses pathname/searchParams.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const query = url.searchParams;
  const segs = segments(path);

  // Health probe.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP only: /{owner}/{repo}.git/info/refs,
  // /{owner}/{repo}.git/git-upload-pack, /{owner}/{repo}.git/git-receive-pack.
  // (The REST /api/v3/repos/{o}/{r}/git/refs endpoint also ends in "refs"
  // and must NOT be routed here.)
  const isGitPath =
    (segs.length === 3 && (segs[2] === 'git-upload-pack' || segs[2] === 'git-receive-pack')) ||
    (segs.length === 4 && segs[2] === 'info' && segs[3] === 'refs');
  if (isGitPath) {
    await handleGit(store, req, res, method, path, segs, query);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const outcome = handleMcpMessage(store, msg);
    if (outcome === null) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (outcome.empty) {
      res.writeHead(outcome.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    const text = `${JSON.stringify(outcome.body)}\n`;
    res.writeHead(outcome.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId() });
    res.end(text);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = parseJsonBody(raw);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const result = executeGraphQL(body, { store, viewerLogin: store.viewerLogin ?? 'owner' });
    sendJson(res, 200, result);
    return;
  }

  // REST v3.
  if (segs[0] === 'api' && segs[1] === 'v3') {
    await handleRest(store, req, res, method, path, segs, query);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, method: string, path: string, segs: string[], query: URLSearchParams): Promise<void> {
  // /{owner}/{repo}.git/info/refs | /{owner}/{repo}.git/git-upload-pack | git-receive-pack
  const owner = segs[0];
  let repoName = segs[1];
  if (repoName.endsWith('.git')) repoName = repoName.slice(0, -4);
  const tail = segs[segs.length - 1];

  const repo = store.getRepo(repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // Learn the viewer login from the first owner-bearing request for an existing repo.
  if (store.viewerLogin === null) {
    store.learnOwner(owner);
    repo.owner = owner;
  } else if (owner !== store.viewerLogin) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (tail === 'refs' && method === 'GET') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      sendRaw(res, 200, isV2 ? v2Advertisement() : cachedV0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, cachedV0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: 'unknown service' });
    return;
  }

  if (tail === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const out = handleUploadPack(repo, body, isV2);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    } catch {
      sendRaw(res, 400, Buffer.from('bad request\n'), 'application/x-git-upload-pack-result');
    }
    return;
  }

  if (tail === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    try {
      const out = handleReceivePack(repo, body);
      sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    } catch {
      sendRaw(res, 400, Buffer.from('bad request\n'), 'application/x-git-receive-pack-result');
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  const { lines, endOffset } = decodePktLines(body);
  void endOffset;
  if (!isV2) {
    // v0: want lines, optional shallow/deepen, flush, have lines, done, flush.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let deepen: number | null = null;
    let section = 0;
    for (const line of lines) {
      if (line.kind === 'flush') {
        section += 1;
        continue;
      }
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').trim();
      if (section === 0) {
        if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) deepen = Number(text.slice(7).trim());
      } else if (section === 1) {
        if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      }
    }
    const v0Key = `v0\n${wants.join(',')}\n${haves.join(',')}\n${shallow.join(',')}\n${deepen}`;
    const v0Hit = cachesFor(repo).fetch.get(v0Key);
    if (v0Hit) return v0Hit;
    const { objects, shallow: newShallow, unshallow } = fetchObjects(repo, wants, haves, shallow, deepen);
    const common = haves.find((h) => wants.some((w) => isAncestor(repo.objects, h, w) || h === w));
    const parts: Buffer[] = [pktLine(common ? `ACK ${common}\n` : 'NAK\n')];
    for (const s of newShallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(packResponse(objects));
    const out = Buffer.concat(parts);
    // The v0 response is a pure function of (wants, haves, shallow, deepen)
    // and the immutable object graph (see the cache notes above).
    cacheSet(cachesFor(repo).fetch, v0Key, out, 32);
    return out;
  }
  // v2: command line, agent/object-format, delim, args, flush.
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').trim();
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice(8);
    } else {
      args.push(text);
    }
  }
  if (command === 'ls-refs') {
    const lsKey = `ls-refs\n${refsFingerprint(repo)}\n${args.join('\n')}`;
    const lsHit = cachesFor(repo).lsRefs.get(lsKey);
    if (lsHit) return lsHit;
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const unborn = args.includes('unborn');
    const parts: Buffer[] = [];
    const linesOut: RefLine[] = refLines(repo);
    if (linesOut.length === 0) {
      if (unborn) {
        parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    } else {
      for (const l of linesOut) {
        if (prefixes.length > 0 && !prefixes.some((p) => l.name.startsWith(p) || (l.name === 'HEAD' && 'HEAD'.startsWith(p)))) continue;
        let line = `${l.oid} ${l.name}`;
        if (symrefs && l.symrefTarget) line += ` symref-target:${l.symrefTarget}`;
        if (peel && l.name.startsWith('refs/tags/')) {
          const obj = repo.objects.get(l.oid);
          if (obj?.type === 'tag') {
            const target = (obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m) ?? [])[1] ?? '';
            if (target !== '') line += ` peeled:${target}`;
          }
        }
        parts.push(pktLine(`${line}\n`));
      }
    }
    parts.push(FLUSH);
    const lsOut = Buffer.concat(parts);
    cacheSet(cachesFor(repo).lsRefs, lsKey, lsOut, 64);
    return lsOut;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let deepen: number | null = null;
    let done = false;
    for (const a of args) {
      if (a.startsWith('want ')) wants.push(a.slice(5).trim());
      else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
      else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
      else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim());
      else if (a === 'done') done = true;
    }
    // The fetch response is a pure function of the request args and the
    // immutable object graph (see the cache notes above): identical clones
    // of one tip share one cached pack.
    const fetchKey = `v2\n${args.join('\n')}`;
    const fetchHit = cachesFor(repo).fetch.get(fetchKey);
    if (fetchHit) return fetchHit;
    const { objects, shallow: newShallow, unshallow } = fetchObjects(repo, wants, haves, shallow, deepen);
    const shallowSection = (parts: Buffer[]): void => {
      if (newShallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of newShallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
        parts.push(DELIM);
      }
    };
    const packfileSection = (parts: Buffer[]): void => {
      parts.push(pktLine('packfile\n'));
      parts.push(packResponse(objects));
    };
    // protocol-v2: when the client sends "done", the acknowledgments section
    // MUST be omitted; the response goes straight to shallow-info / packfile.
    let out: Buffer;
    if (done) {
      const parts: Buffer[] = [];
      shallowSection(parts);
      packfileSection(parts);
      out = Buffer.concat(parts);
    } else {
      // Negotiation round (no "done"): answer the acknowledgments section.
      // A packfile is sent in this same response only when "ready" is sent.
      const common = haves.find((h) => wants.some((w) => isAncestor(repo.objects, h, w) || h === w));
      if (common) {
        const parts: Buffer[] = [];
        parts.push(pktLine('acknowledgments\n'));
        parts.push(pktLine(`ACK ${common}\n`));
        parts.push(pktLine('ready\n'));
        parts.push(DELIM);
        shallowSection(parts);
        packfileSection(parts);
        out = Buffer.concat(parts);
      } else {
        out = Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH]);
      }
    }
    cacheSet(cachesFor(repo).fetch, fetchKey, out, 32);
    return out;
  }
  throw new Error(`unknown v2 command ${command}`);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, endOffset } = decodePktLines(body, 0, true);
  const commands: { old: string; new: string; ref: string }[] = [];
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const clean = (nul === -1 ? text : text.slice(0, nul)).trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
    if (m) commands.push({ old: m[1], new: m[2], ref: m[3] });
  }
  // Unpack the pack that follows the command list.
  const packBytes = body.subarray(endOffset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes);
      for (const o of objs) {
        if (!repo.objects.has(o.oid)) repo.objects.set(o.oid, { type: o.type, data: o.data });
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}`);
    for (const c of commands) report.push(`ng ${c.ref} unpack failed`);
  } else {
    report.push('unpack ok');
    for (const c of commands) {
      const current = repo.refs.get(c.ref) ?? ZERO_OID;
      if (c.old !== current) {
        report.push(`ng ${c.ref} non-fast-forward`);
        continue;
      }
      if (c.new === ZERO_OID) {
        // Delete.
        repo.refs.delete(c.ref);
        report.push(`ok ${c.ref}`);
        continue;
      }
      const obj = repo.objects.get(c.new);
      if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
        report.push(`ng ${c.ref} invalid object`);
        continue;
      }
      // Fast-forward check for branch updates.
      if (c.old !== ZERO_OID && c.ref.startsWith('refs/heads/')) {
        if (!isAncestor(repo.objects, c.old, c.new)) {
          report.push(`ng ${c.ref} non-fast-forward`);
          continue;
        }
      }
      repo.refs.set(c.ref, c.new);
      report.push(`ok ${c.ref}`);
    }
  }
  const parts: Buffer[] = [];
  // The report-status stream is itself pkt-lined inside band 1 (real git's
  // packet_reader and the kit client both decode pkt-lines from band 1).
  const reportText = Buffer.concat(report.map((line) => pktLine(`${line}\n`)));
  const CHUNK = 32768;
  for (let i = 0; i < reportText.length; i += CHUNK) {
    parts.push(sideband(1, reportText.subarray(i, Math.min(reportText.length, i + CHUNK))));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  segs: string[],
  query: URLSearchParams,
): Promise<void> {
  // API root / meta / user (no repo in path).
  if (segs.length === 2 || (segs.length === 3 && segs[2] === '')) {
    if (method === 'GET' && path === '/api/v3' || path === '/api/v3/') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
      return;
    }
  }
  if (segs.length === 3 && segs[2] === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000', hooks: [], git: [], pages: [] });
      return;
    }
  }
  if (segs.length === 3 && segs[2] === 'rate_limit') {
    if (method === 'GET') {
      sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: fixedEpochSeconds() + 3600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: fixedEpochSeconds() + 3600, used: 1 } });
      return;
    }
  }
  if (segs.length === 3 && segs[2] === 'user') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method === 'GET') {
      const login = store.viewerLogin ?? 'owner';
      sendJson(res, 200, { login, id: 1, node_id: gidRepo(0), type: 'User', html_url: `https://github.com/${login}`, created_at: fixedIso(), updated_at: fixedIso() });
      return;
    }
  }
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = store.listRepos();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        headers['link'] = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      sendJson(res, 200, slice.map((r) => repoJson(store, r)), headers);
      return;
    }
    if (method === 'POST') {
      const body = (await readBodyJson(req, res)) as Record<string, unknown> | null;
      if (body === null) return;
      const name = String(body['name'] ?? '');
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing' }] });
        return;
      }
      const repo = store.createRepo(name, String(body['description'] ?? ''), body['private'] === true);
      if (!repo) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      sendJson(res, 201, repoJson(store, repo));
      return;
    }
  }

  // /repos/{owner}/{repo}/...
  if (segs.length >= 4 && segs[2] === 'repos') {
    await handleRepoRest(store, req, res, method, segs, query);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function readBodyJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  try {
    const parsed = parseJsonBody(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
}

async function handleRepoRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segs: string[],
  query: URLSearchParams,
): Promise<void> {
  const owner = segs[3];
  const repoName = segs[4];
  const rest = segs.slice(5);

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const repo = store.getRepo(repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (store.viewerLogin === null) {
    store.learnOwner(owner);
    repo.owner = owner;
  } else if (owner !== store.viewerLogin) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GET /repos/{o}/{r} | PATCH | DELETE
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(store, repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBodyJson(req, res);
      if (body === null) return;
      if (typeof body['description'] === 'string') repo.description = body['description'];
      sendJson(res, 200, repoJson(store, repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repoName);
      sendNoContent(res);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // git refs: POST /git/refs, GET /git/refs/heads/{branch}
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readBodyJson(req, res);
      if (body === null) return;
      const ref = String(body['ref'] ?? '');
      const sha = String(body['sha'] ?? '');
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Validation Failed' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: gidRepo(repo.id), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace('refs/', '')}`, object: { sha, type: 'commit', url: '' } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, { ref, node_id: gidRepo(repo.id), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace('refs/', '')}`, object: { sha: oid, type: 'commit', url: '' } });
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      sendJson(res, 200, [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit' } })));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((ref) => {
        const name = ref.slice('refs/heads/'.length);
        return { name, commit: { sha: repo.refs.get(ref), url: '' }, protected: false };
      });
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const name = rest[1];
      const oid = repo.refs.get(`refs/heads/${name}`);
      if (!oid) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, { name, commit: { sha: oid, url: '' }, protected: false });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // commits
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = query.get('sha') ?? repo.defaultBranch;
      let tip = '';
      if (isOid(ref)) tip = ref;
      else tip = store.branchTip(repo, ref);
      if (tip === '' || !repo.objects.has(tip)) {
        sendJson(res, 200, []);
        return;
      }
      const list = store.listCommitsFrom(repo, tip).map((oid) => {
        const obj = repo.objects.get(oid);
        const text = obj?.data.toString('utf8') ?? '';
        const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2).trim() : '';
        const parents = text.split('\n').filter((l) => l.startsWith('parent ')).map((l) => ({ sha: l.slice(7).trim() }));
        return {
          sha: oid,
          commit: {
            message,
            author: { name: 'Conformance User', email: 'conformance@example.com', date: fixedIso() },
            committer: { name: 'Conformance User', email: 'conformance@example.com', date: fixedIso() },
          },
          author: { login: store.viewerLogin ?? 'owner' },
          committer: { login: store.viewerLogin ?? 'owner' },
          parents,
          url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}`,
          html_url: `https://github.com/${owner}/${repoName}/commit/${oid}`,
        };
      });
      sendJson(res, 200, list);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // contents
  if (rest[0] === 'contents') {
    await handleContents(store, req, res, method, repo, owner, repoName, rest.slice(1), query);
    return;
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = await readBodyJson(req, res);
      if (body === null) return;
      const name = String(body['name'] ?? '');
      const color = String(body['color'] ?? 'ffffff');
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed' });
        return;
      }
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 201, { id: 1, name: existing.name, color: existing.color, description: existing.description ?? '', default: false });
        return;
      }
      const label = { name, color, description: String(body['description'] ?? '') };
      repo.labels.set(name, label);
      sendJson(res, 201, { id: repo.labels.size, name, color, description: label.description, default: false });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l, i) => ({ id: i + 1, name: l.name, color: l.color, description: l.description ?? '', default: false })));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // issues
  if (rest[0] === 'issues') {
    // /issues/{n}/comments
    if (rest.length === 3 && rest[2] === 'comments') {
      const num = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({
          id: c.id,
          node_id: gidComment(repo.id, issue.number, c.id),
          body: c.body,
          user: { login: store.viewerLogin ?? 'owner' },
          created_at: fixedIso(),
          updated_at: fixedIso(),
          html_url: `https://github.com/${owner}/${repoName}/issues/${issue.number}#issuecomment-${c.id}`,
        })));
        return;
      }
      if (method === 'POST') {
        const body = await readBodyJson(req, res);
        if (body === null) return;
        const comment = { id: repo.nextCommentId, body: String(body['body'] ?? '') };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        issue.rev += 1; // invalidate the cached issue serialization
        sendJson(res, 201, {
          id: comment.id,
          node_id: gidComment(repo.id, issue.number, comment.id),
          body: comment.body,
          user: { login: store.viewerLogin ?? 'owner' },
          created_at: fixedIso(),
          updated_at: fixedIso(),
          html_url: `https://github.com/${owner}/${repoName}/issues/${issue.number}#issuecomment-${comment.id}`,
        });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 2) {
      const num = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        // Hot path (the read workload GETs one issue 2000x): serve the
        // cached serialization when the issue is unchanged. Only the body
        // is cached; sendRaw still sets a fresh x-github-request-id.
        const owner = store.ownerOf(repo);
        const c = cachesFor(repo);
        const hit = c.issueJson.get(issue.number);
        if (hit && hit.rev === issue.rev && hit.owner === owner) {
          sendRaw(res, 200, hit.body, JSON_TYPE);
          return;
        }
        const body = Buffer.from(`${JSON.stringify(issueJson(store, repo, issue))}\n`, 'utf8');
        c.issueJson.set(issue.number, { rev: issue.rev, owner, body });
        sendRaw(res, 200, body, JSON_TYPE);
        return;
      }
      if (method === 'PATCH') {
        const body = await readBodyJson(req, res);
        if (body === null) return;
        if (typeof body['state'] === 'string' && (body['state'] === 'open' || body['state'] === 'closed')) issue.state = body['state'];
        if (typeof body['title'] === 'string') issue.title = body['title'];
        if (typeof body['body'] === 'string') issue.body = body['body'];
        issue.rev += 1; // invalidate the cached serialization above
        sendJson(res, 200, issueJson(store, repo, issue));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (query.get('state') ?? 'open').toLowerCase();
        const sort = query.get('sort') ?? 'created';
        const direction = (query.get('direction') ?? 'desc').toLowerCase();
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        if (sort === 'created') list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const slice = list.slice((page - 1) * perPage, page * perPage);
        sendJson(res, 200, slice.map((i) => issueJson(store, repo, i)));
        return;
      }
      if (method === 'POST') {
        const body = await readBodyJson(req, res);
        if (body === null) return;
        const title = String(body['title'] ?? '');
        if (title === '') {
          sendJson(res, 422, { message: 'Validation Failed' });
          return;
        }
        const labelNames = Array.isArray(body['labels']) ? (body['labels'] as unknown[]).map((l) => (typeof l === 'string' ? l : String((l as Record<string, unknown>)['name'] ?? ''))) : [];
        const issue = store.createIssue(repo, title, String(body['body'] ?? ''), labelNames);
        if (!issue) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
          return;
        }
        sendJson(res, 201, issueJson(store, repo, issue));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // pulls
  if (rest[0] === 'pulls') {
    // /pulls/{n}/files
    if (rest.length === 3 && rest[2] === 'files') {
      const num = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        const baseTree = pull.baseSha === '' ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
        const headTree = pull.headSha === '' ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
        const diffs = store.diffTrees(repo, baseTree, headTree);
        const files = diffs.map((d) => {
          let additions = 0;
          let deletions = 0;
          if (d.status === 'added') {
            const blob = repo.objects.get(d.headOid);
            additions = blob ? blob.data.toString('utf8').split('\n').length : 1;
          } else if (d.status === 'removed') {
            const blob = repo.objects.get(d.baseOid);
            deletions = blob ? blob.data.toString('utf8').split('\n').length : 1;
          } else {
            const dd = Store.lineDiff(repo.objects.get(d.baseOid)?.data ?? Buffer.alloc(0), repo.objects.get(d.headOid)?.data ?? Buffer.alloc(0));
            additions = dd.additions;
            deletions = dd.deletions;
          }
          return { sha: d.headOid || d.baseOid, filename: d.path, status: d.status, additions, deletions, changes: additions + deletions };
        });
        sendJson(res, 200, files);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // /pulls/{n}/merge
    if (rest.length === 3 && rest[2] === 'merge') {
      const num = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'PUT') {
        if (pull.merged) {
          sendJson(res, 405, { message: 'Pull request already merged' });
          return;
        }
        const mergeOid = store.squashMerge(repo, pull);
        if (mergeOid === null) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return;
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.merged_at = fixedIso();
        pull.merge_commit_sha = mergeOid;
        pull.baseSha = mergeOid;
        sendJson(res, 200, { sha: mergeOid, merged: true, message: `Pull request #${pull.number} successfully merged` });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 2) {
      const num = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(store, repo, pull));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (query.get('state') ?? 'open').toLowerCase();
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        const slice = list.slice((page - 1) * perPage, page * perPage);
        sendJson(res, 200, slice.map((p) => pullJson(store, repo, p)));
        return;
      }
      if (method === 'POST') {
        const body = await readBodyJson(req, res);
        if (body === null) return;
        const head = String(body['head'] ?? '');
        const base = String(body['base'] ?? '');
        const title = String(body['title'] ?? '');
        if (head === '' || base === '' || title === '') {
          sendJson(res, 422, { message: 'Validation Failed' });
          return;
        }
        const pull = store.createPull(repo, head, base, title, String(body['body'] ?? ''));
        if (!pull) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'could not create pull request' }] });
          return;
        }
        sendJson(res, 201, pullJson(store, repo, pull));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  owner: string,
  repoName: string,
  pathSegs: string[],
  query: URLSearchParams,
): Promise<void> {
  const path = pathSegs.join('/');
  const ref = query.get('ref') ?? repo.defaultBranch;

  if (method === 'GET') {
    let branch = ref;
    let treeOid = '';
    if (isOid(ref) && repo.objects.has(ref)) {
      const obj = repo.objects.get(ref);
      if (obj?.type === 'commit') treeOid = (obj.data.toString('utf8').match(/^tree ([0-9a-f]{40})$/m) ?? [])[1] ?? '';
    }
    if (treeOid === '') {
      const tip = store.branchTip(repo, branch);
      if (tip === '') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const commit = repo.objects.get(tip);
      treeOid = (commit?.data.toString('utf8').match(/^tree ([0-9a-f]{40})$/m) ?? [])[1] ?? '';
    }
    // Walk to the path inside the tree.
    if (path === '') {
      const root = repo.objects.get(treeOid);
      const entries = root ? (root.data.length === 0 ? [] : parseTreeEntries(root.data)) : [];
      sendJson(res, 200, entries.map((e) => contentEntry(store, repo, owner, repoName, '', e)));
      return;
    }
    const parts = path.split('/').filter((p) => p !== '');
    let curTree = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(curTree);
      if (!obj || obj.type !== 'tree') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const entry = parseTreeEntries(obj.data).find((e) => e.name === parts[i]);
      if (!entry) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const sub = repo.objects.get(entry.oid);
          const children = sub ? parseTreeEntries(sub.data) : [];
          sendJson(res, 200, children.map((e) => contentEntry(store, repo, owner, repoName, path, e)));
          return;
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: entry.name,
          path,
          content: blob.data.toString('base64'),
          sha: entry.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${path}`,
          git_url: '',
          download_url: null,
        });
        return;
      }
      curTree = entry.oid;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (method === 'PUT') {
    const body = await readBodyJson(req, res);
    if (body === null) return;
    const message = String(body['message'] ?? 'Update');
    const contentB64 = String(body['content'] ?? '');
    const branch = typeof body['branch'] === 'string' && body['branch'] !== '' ? body['branch'] : repo.defaultBranch;
    const sha = typeof body['sha'] === 'string' ? body['sha'] : null;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentB64, 'base64');
    } catch {
      sendJson(res, 422, { message: 'Validation Failed' });
      return;
    }
    // Determine whether the file exists on the branch.
    const existing = store.readPath(repo, branch, path);
    const blobOid = store.hashBlob(bytes);
    if (existing && !existing.isDir) {
      if (sha === null) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'sha', code: 'missing' }] });
        return;
      }
      if (sha !== existing.oid) {
        sendJson(res, 409, { message: 'Conflict: sha does not match' });
        return;
      }
    } else if (sha !== null) {
      sendJson(res, 409, { message: 'Conflict: file does not exist' });
      return;
    }
    const isUpdate = existing !== null && !existing.isDir;
    // Create the branch from the default tip when it does not exist yet.
    if (store.branchTip(repo, branch) === '' && branch !== repo.defaultBranch) {
      const defaultTip = store.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== '') repo.refs.set(`refs/heads/${branch}`, defaultTip);
    }
    storeObject(repo.objects, 'blob', bytes);
    const { commitOid } = store.commitOnBranch(repo, branch, message, (entries) => {
      entries.set(path, { mode: '100644', name: path.split('/').pop() as string, oid: blobOid });
    });
    sendJson(res, isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', url: `/api/v3/repos/${owner}/${repoName}/contents/${path}` },
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await readBodyJson(req, res);
    if (body === null) return;
    const message = String(body['message'] ?? 'Delete');
    const branch = typeof body['branch'] === 'string' && body['branch'] !== '' ? body['branch'] : repo.defaultBranch;
    const existing = store.readPath(repo, branch, path);
    if (!existing || existing.isDir) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const { commitOid } = store.commitOnBranch(repo, branch, message, (entries) => {
      entries.delete(path);
    });
    sendJson(res, 200, { commit: { sha: commitOid, message } });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function parseTreeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  const out: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1) break;
    out.push({ mode: data.toString('ascii', i, space), name: data.toString('utf8', space + 1, nul), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

function contentEntry(
  store: Store,
  repo: Repo,
  owner: string,
  repoName: string,
  dir: string,
  e: { mode: string; name: string; oid: string },
): Record<string, unknown> {
  const path = dir === '' ? e.name : `${dir}/${e.name}`;
  const isDir = e.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    size: 0,
    name: e.name,
    path,
    sha: e.oid,
    url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
    html_url: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${path}`,
    git_url: '',
    download_url: null,
  };
}
