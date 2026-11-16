// git.ts — a pure-Node git object model: SHA-1 ids, pkt-line codec, packfile
// read/write, tree/commit/tag build + parse, and reachability. No git binary,
// no network, stdlib only (node:crypto, node:zlib).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

/** Parse a commit object: tree, parents, message. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; raw: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: text };
}

/** Parse a tag object: object, type, tag name, message. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('ascii', i, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

/** Build a tree object from entries (git sorts dirs as if named with a trailing '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? a.name + '/' : a.name;
    const kb = b.mode === '40000' ? b.name + '/' : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Walk the commit graph from `tips` (commits/tags), calling `visit` for each object. */
export function walkReachable(
  objects: Map<string, GitObject>,
  tips: string[],
  visit: (oid: string, obj: GitObject) => void,
): void {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    visit(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
}

/** All oids reachable from `tips`, in walk order. */
export function reachableSet(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const out = new Set<string>();
  walkReachable(objects, tips, (oid) => {
    out.add(oid);
  });
  return out;
}

/** True when `ancestor` is an ancestor of (or equal to) `commitOid`. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, commitOid: string): boolean {
  if (ancestor === commitOid) return true;
  const seen = new Set<string>();
  const stack = [commitOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** Find a merge-base of two commits: nearest common ancestor (BFS from both sides). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  {
    const stack = [b];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (ancestorsOfB.has(oid)) continue;
      ancestorsOfB.add(oid);
      const obj = objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** List commits reachable from `tip`, newest-first (BFS by parent order). */
export function listCommits(objects: Map<string, GitObject>, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// pkt-line codec (git protocol framing)
// ---------------------------------------------------------------------------

/** Encode one packet line (4-hex length incl. header + payload). */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/**
 * Decode a buffer of pkt-lines. Returns lines (payloads as Buffers, excluding
 * the 4-byte length header) plus the offset where the pkt-line stream ended
 * (start of the trailing raw pack, or buffer end). Throws on bad lengths.
 * Special packets are returned as the strings '0000'/'0001'/'0002' via kind.
 */
export interface DecodedLine {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

export function decodePktLines(buf: Buffer, start = 0, stopAtFlush = false): { lines: DecodedLine[]; endOffset: number } {
  const lines: DecodedLine[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('ascii', i, i + 4);
    if (hex === '0000') {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (hex === '0001') {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (hex === '0002') {
      lines.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    lines.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { lines, endOffset: i };
}

/** Encode a side-band packet: band byte (1=pack, 2=progress, 3=error) + chunk. */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

// ---------------------------------------------------------------------------
// packfile read/write (plain objects; version 2)
// ---------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Serialize a list of objects as a version-2 packfile (no deltas). */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const code = PACK_TYPE_CODE[obj.type];
    const size = obj.data.length;
    const bytes: number[] = [];
    let remaining = size;
    let first = (code << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Parse a packfile; returns the objects it holds (oid, type, data). */
export function readPack(buf: Buffer): { oid: string; type: ObjType; data: Buffer }[] {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  // Verify the trailer checksum.
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');
  const out: { oid: string; type: ObjType; data: Buffer }[] = [];
  let i = 12;
  for (let n = 0; n < count; n += 1) {
    const first = buf[i];
    const code = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    i += 1;
    let cont = first & 0x80;
    while (cont !== 0) {
      size |= (buf[i] & 0x7f) << shift;
      shift += 7;
      cont = buf[i] & 0x80;
      i += 1;
    }
    const type = PACK_CODE_TYPE[code];
    if (!type) throw new Error(`unsupported pack object type ${code}`);
    const { data, consumed } = inflateAt(buf, i);
    if (data.length !== size) throw new Error('pack object size mismatch');
    i += consumed;
    const oid = hashObject(type, data);
    out.push({ oid, type, data });
  }
  return out;
}

/**
 * Inflate a deflated stream starting at `offset`; returns the data and how
 * many compressed bytes were consumed. Fast path: one inflate, with the
 * engine reporting the exact consumed length. Guarded: any unexpected shape
 * or value falls back to a binary search over the length, which is correct
 * on every Node version.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  try {
    const out = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer?: unknown;
      engine?: { bytesRead?: unknown };
    };
    if (Buffer.isBuffer(out.buffer) && typeof out.engine?.bytesRead === 'number') {
      const consumed = out.engine.bytesRead;
      if (consumed > 0 && consumed <= buf.length - offset) {
        return { data: out.buffer, consumed };
      }
    }
  } catch {
    // Fall through to the binary search below.
  }
  let lo = 1;
  let hi = buf.length - offset;
  let bestData: Buffer | null = null;
  let bestLen = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buf.subarray(offset, offset + mid));
      bestData = data;
      bestLen = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (bestData === null || bestLen === -1) throw new Error('inflate failed');
  return { data: bestData, consumed: bestLen };
}
