// store.ts — the forge's in-memory data model and resource operations.
// One store holds every repo; everything is a Map lookup (O(1)) and all
// timestamps are deterministic (fixed epoch, or MAKEFUN_TRIAL_NOW when set).
import {
  EMPTY_TREE_OID,
  ZERO_OID,
  buildTree,
  hashObject,
  isAncestor,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  reachableSet,
  storeObject,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export const FIXED_IDENTITY = 'Conformance User <conformance@example.com>';

export function fixedEpochSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z
}

export function fixedIso(): string {
  return new Date(fixedEpochSeconds() * 1000).toISOString();
}

export interface Label {
  name: string;
  color: string;
  description?: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null; // learned from the first owner-bearing request
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>; // 'refs/heads/main' -> commit oid
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number; // shared issue + PR numbering
  nextCommentId: number;
}

export class Store {
  reposByName = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoId = 1;
  nextRepoSeq = 1;
  nextIssueId = 1;
  viewerLogin: string | null = null;

  /** Learn the token owner's login from an owner-bearing path. */
  learnOwner(owner: string): void {
    if (this.viewerLogin === null) this.viewerLogin = owner;
  }

  ownerOf(repo: Repo): string {
    return repo.owner ?? this.viewerLogin ?? 'owner';
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.reposByName.has(name)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewerLogin,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextRepoSeq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    this.reposByName.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.reposByName.get(name);
  }

  deleteRepo(name: string): boolean {
    const repo = this.reposByName.get(name);
    if (!repo) return false;
    this.reposByName.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** The tip commit oid of a branch ('' when the branch does not exist). */
  branchTip(repo: Repo, branch: string): string {
    return repo.refs.get(`refs/heads/${branch}`) ?? '';
  }

  /** Create a commit on `branch` (creating the branch from the default tip when needed). */
  commitOnBranch(
    repo: Repo,
    branch: string,
    message: string,
    mutate: (entries: Map<string, TreeEntry>) => void,
  ): { commitOid: string; treeOid: string } {
    const parentTip = this.branchTip(repo, branch);
    const parentTree = parentTip === '' ? EMPTY_TREE_OID : parseCommit(repo.objects.get(parentTip)?.data ?? Buffer.alloc(0)).tree;
    const entries = new Map<string, TreeEntry>();
    if (parentTree !== EMPTY_TREE_OID) this.flattenTree(repo, parentTree, '', entries);
    mutate(entries);
    const treeOid = this.storeTree(repo, entries);
    const ts = fixedEpochSeconds();
    const author = `${FIXED_IDENTITY} ${ts} +0000`;
    const header =
      `tree ${treeOid}\n` +
      (parentTip === '' ? '' : `parent ${parentTip}\n`) +
      `author ${author}\ncommitter ${author}\n\n${message}\n`;
    const commitOid = storeObject(repo.objects, 'commit', Buffer.from(header, 'utf8'));
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, treeOid };
  }

  /** Flatten a tree into path -> leaf entry. */
  flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, TreeEntry>): void {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { mode: e.mode, name: e.name, oid: e.oid });
    }
  }

  /** Store a full nested tree from a flat path map; returns the root tree oid. */
  storeTree(repo: Repo, flat: Map<string, TreeEntry>): string {
    const byDir = new Map<string, TreeEntry[]>();
    for (const [path, e] of flat) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const name = slash === -1 ? path : path.slice(slash + 1);
      const list = byDir.get(dir) ?? [];
      list.push({ mode: e.mode, name, oid: e.oid });
      byDir.set(dir, list);
    }
    const buildDir = (dir: string): string => {
      const entries = [...(byDir.get(dir) ?? [])];
      // Add subdirectories that contain entries.
      const subdirs = new Set<string>();
      for (const [p] of flat) {
        if (dir === '') {
          const slash = p.indexOf('/');
          if (slash !== -1) subdirs.add(p.slice(0, slash));
        } else if (p.startsWith(`${dir}/`)) {
          const rest = p.slice(dir.length + 1);
          const slash = rest.indexOf('/');
          if (slash !== -1) subdirs.add(rest.slice(0, slash));
        }
      }
      for (const sub of subdirs) {
        entries.push({ mode: '40000', name: sub, oid: buildDir(dir === '' ? sub : `${dir}/${sub}`) });
      }
      return storeObject(repo.objects, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Read a blob at `path` on the tip of `branch`; null when absent. */
  readPath(repo: Repo, branch: string, path: string): { blob: Buffer; oid: string; isDir: boolean; entries?: TreeEntry[] } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === '') return null;
    const commit = repo.objects.get(tip);
    if (!commit) return null;
    const rootTree = parseCommit(commit.data).tree;
    const parts = path.split('/').filter((p) => p !== '');
    let treeOid = rootTree;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const sub = repo.objects.get(entry.oid);
          return { blob: Buffer.alloc(0), oid: entry.oid, isDir: true, entries: sub ? parseTree(sub.data) : [] };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob) return null;
        return { blob: blob.data, oid: entry.oid, isDir: false };
      }
      treeOid = entry.oid;
    }
    // path === '' (root): list the root tree.
    const root = repo.objects.get(rootTree);
    return { blob: Buffer.alloc(0), oid: rootTree, isDir: true, entries: root ? parseTree(root.data) : [] };
  }

  /** All file paths that differ between two trees (base -> head). */
  diffTrees(
    repo: Repo,
    baseTree: string,
    headTree: string,
  ): { path: string; status: 'added' | 'modified' | 'removed'; baseOid: string; headOid: string }[] {
    const base = new Map<string, TreeEntry>();
    const head = new Map<string, TreeEntry>();
    if (baseTree !== EMPTY_TREE_OID) this.flattenTree(repo, baseTree, '', base);
    if (headTree !== EMPTY_TREE_OID) this.flattenTree(repo, headTree, '', head);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { path: string; status: 'added' | 'modified' | 'removed'; baseOid: string; headOid: string }[] = [];
    for (const p of [...paths].sort()) {
      const b = base.get(p);
      const h = head.get(p);
      if (b && !h) out.push({ path: p, status: 'removed', baseOid: b.oid, headOid: '' });
      else if (!b && h) out.push({ path: p, status: 'added', baseOid: '', headOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path: p, status: 'modified', baseOid: b.oid, headOid: h.oid });
    }
    return out;
  }

  /** Line counts for a small diff (additions/deletions). */
  static lineDiff(base: Buffer, head: Buffer): { additions: number; deletions: number } {
    const baseLines = base.length === 0 ? [] : base.toString('utf8').split('\n');
    const headLines = head.length === 0 ? [] : head.toString('utf8').split('\n');
    if (baseLines.length > 2000 || headLines.length > 2000) {
      return { additions: headLines.length, deletions: baseLines.length };
    }
    // LCS dynamic programming on small files.
    const n = baseLines.length;
    const m = headLines.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = baseLines[i] === headLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const common = dp[0][0];
    return { additions: m - common, deletions: n - common };
  }

  /** Conflict check for a squash merge: paths changed on both sides with different results. */
  mergeConflict(repo: Repo, baseTip: string, headTip: string): boolean {
    const base = mergeBase(repo.objects, baseTip, headTip);
    if (base === null) return false;
    const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const headTipTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const baseSide = this.diffTrees(repo, baseTree, baseTipTree);
    const headSide = this.diffTrees(repo, baseTree, headTipTree);
    const baseChanged = new Map(baseSide.map((d) => [d.path, d.headOid]));
    for (const d of headSide) {
      if (baseChanged.has(d.path) && baseChanged.get(d.path) !== d.headOid) return true;
    }
    return false;
  }

  /** Perform a squash merge of a PR; returns the merge commit oid or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === '' || headTip === '') return null;
    if (this.mergeConflict(repo, baseTip, headTip)) return null;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const ts = fixedEpochSeconds();
    const author = `${FIXED_IDENTITY} ${ts} +0000`;
    const header =
      `tree ${headTree}\nparent ${baseTip}\nauthor ${author}\ncommitter ${author}\n\nMerge pull request #${pull.number} from ${pull.headRef}\n`;
    const mergeOid = storeObject(repo.objects, 'commit', Buffer.from(header, 'utf8'));
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
    return mergeOid;
  }

  /** Create an issue; returns null when a named label does not exist. */
  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | null {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return null;
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      seq: repo.nextNumber,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  /** Create a pull request; returns null when a branch is missing or a duplicate is open. */
  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === '' || baseSha === '') return null;
    const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (dup) return null;
    const pull: Pull = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Objects in `repo` reachable from all refs — for pack generation. */
  allReachable(repo: Repo): Set<string> {
    return reachableSet(repo.objects, [...repo.refs.values()]);
  }

  /** Verify every object in a tip's closure is present (after a push unpack). */
  closureComplete(repo: Repo, tip: string): boolean {
    const want = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (want.has(oid)) continue;
      want.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) return false;
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
    return true;
  }

  isAncestorOf(repo: Repo, ancestor: string, commitOid: string): boolean {
    return isAncestor(repo.objects, ancestor, commitOid);
  }

  listCommitsFrom(repo: Repo, tip: string): string[] {
    return listCommits(repo.objects, tip);
  }

  hashBlob(data: Buffer): string {
    return hashObject('blob', data);
  }
}
