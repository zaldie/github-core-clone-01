// mcp.ts — MCP (Model Context Protocol) over Streamable HTTP: the modern
// server/discover handshake (revision 2026-07-28), the legacy initialize
// handshake (2025-11-25), tools/list and tools/call for the six forge tools,
// plus the JSON-RPC error contract (-32601/-32602/-32700).
import { fixedIso, type Repo, type Store } from './store.ts';
import { gidIssue, gidPull, gidRepo } from './graphql.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

export function toolDefinitions(): ToolDef[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a new repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Repository name' },
          description: { type: 'string', description: 'Repository description' },
          private: { type: 'boolean', description: 'Whether the repository is private' },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
          state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Pull request title' },
          head: { type: 'string', description: 'Head branch name' },
          base: { type: 'string', description: 'Base branch name' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
          pull_number: { type: 'integer', description: 'Pull request number' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  ];
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: repo.id,
    node_id: gidRepo(repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${owner}/${repo.name}`,
    created_at: fixedIso(),
    updated_at: fixedIso(),
  };
}

function issueJson(store: Store, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: { name: string; color: string }[] }): Record<string, unknown> {
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
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    created_at: fixedIso(),
    updated_at: fixedIso(),
  };
}

function pullJson(store: Store, repo: Repo, pull: { number: number; title: string; body: string; state: string; merged: boolean; headRef: string; baseRef: string; headSha: string; baseSha: string }): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: pull.number,
    node_id: gidPull(repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    created_at: fixedIso(),
    updated_at: fixedIso(),
  };
}

/** Run one tool by name; returns {result} or {isError, message}. */
export function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { ok: boolean; value: unknown; message?: string } {
  const tools = toolDefinitions();
  const def = tools.find((t) => t.name === name);
  if (!def) return { ok: false, value: null, message: `unknown tool ${name}` };
  for (const req of def.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { ok: false, value: null, message: `Missing required argument: ${req}` };
    }
  }
  const owner = String(args['owner'] ?? store.viewerLogin ?? 'owner');
  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo(String(args['name']), String(args['description'] ?? ''), args['private'] === true);
      if (!repo) return { ok: false, value: null, message: 'repository already exists' };
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args['repo']));
      if (!repo) return { ok: false, value: null, message: 'repository not found' };
      if (owner !== '' && repo.owner !== null && owner !== repo.owner && owner !== store.viewerLogin) {
        return { ok: false, value: null, message: 'repository not found' };
      }
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args['repo']));
      if (!repo) return { ok: false, value: null, message: 'repository not found' };
      const issue = store.createIssue(repo, String(args['title']), String(args['body'] ?? ''), []);
      if (!issue) return { ok: false, value: null, message: 'could not create issue' };
      return { ok: true, value: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args['repo']));
      if (!repo) return { ok: false, value: null, message: 'repository not found' };
      const state = String(args['state'] ?? 'open').toLowerCase();
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return { ok: true, value: list.map((i) => issueJson(store, repo, i)) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args['repo']));
      if (!repo) return { ok: false, value: null, message: 'repository not found' };
      const pull = store.createPull(repo, String(args['head']), String(args['base']), String(args['title']), String(args['body'] ?? ''));
      if (!pull) return { ok: false, value: null, message: 'could not create pull request' };
      return { ok: true, value: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args['repo']));
      if (!repo) return { ok: false, value: null, message: 'repository not found' };
      const num = Number(args['pull_number']);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return { ok: false, value: null, message: 'pull request not found' };
      const mergeOid = store.squashMerge(repo, pull);
      if (mergeOid === null) return { ok: false, value: null, message: 'merge conflict' };
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = fixedIso();
      pull.merge_commit_sha = mergeOid;
      return { ok: true, value: { sha: mergeOid, merged: true, message: `Pull request #${pull.number} merged` } };
    }
    default:
      return { ok: false, value: null, message: `unknown tool ${name}` };
  }
}

export interface McpOutcome {
  status: number;
  body: unknown;
  empty?: boolean;
}

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';

function toolsListResult(): unknown {
  return {
    tools: toolDefinitions().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

/** Handle one decoded JSON-RPC message; returns the response (or null for notifications). */
export function handleMcpMessage(store: Store, msg: unknown): McpOutcome | null {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const m = msg as Record<string, unknown>;
  const id = (m['id'] ?? null) as string | number | null;
  const method = String(m['method'] ?? '');
  const params = (m['params'] ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        },
      },
    };
  }
  if (method === 'initialize') {
    const offered = String((params['protocolVersion'] as string | undefined) ?? '2025-11-25');
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const version = supported.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null, empty: true };
  }
  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: toolsListResult() } };
  }
  if (method === 'tools/call') {
    const toolName = String(params['name'] ?? '');
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    const known = toolDefinitions().some((t) => t.name === toolName);
    if (!known) {
      return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } } };
    }
    const outcome = callTool(store, toolName, args);
    if (!outcome.ok) {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: outcome.message ?? 'tool error' }], isError: true },
        },
      };
    }
    const text = JSON.stringify(outcome.value);
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], structuredContent: outcome.value },
      },
    };
  }
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
}
