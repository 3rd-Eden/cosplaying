import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import createServer from 'create-server';
import { buildSchema, graphql } from 'graphql';
import { fetchVersion } from 'gh-release-fetch';
import { generate } from 'selfsigned';
import which from 'which';
import { Server as ProxyServer, RequestError } from 'proxy-chain';

const bin = fileURLToPath(new URL('../bin/cosplaying.js', import.meta.url));
const block = '<!-- cosplaying:attribution -->\n> 🤖 Authored by Example via [cosplaying](https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.\n<!-- /cosplaying:attribution -->\n';
const trailer = 'AI-Assisted-By: Example via cosplaying (https://github.com/3rd-eden/cosplaying). AI Assisted text may contain mistakes, please verify.';
let runtime;
let tools;
before(async () => {
  tools = mkdtempSync(path.join(tmpdir(), 'cosplaying-gh-tools-'));
  const platform = { darwin: 'macOS', win32: 'windows', linux: 'linux' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const stem = `gh_2.105.0_${platform}_${arch}`;
  await fetchVersion({ repository: 'cli/cli', version: 'v2.105.0', package: `${stem}.${platform === 'linux' ? 'tar.gz' : 'zip'}`, destination: tools, extract: true });
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256', keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 2, value: 'api.github.com' }, { type: 7, ip: '127.0.0.1' }] },
    ],
  });
  const ca = path.join(tools, 'ca.pem');
  writeFileSync(ca, pems.cert);
  const certDir = path.join(tools, 'empty-certs'); mkdirSync(certDir);
  const releaseRoot = process.platform === 'win32' ? tools : path.join(tools, stem);
  runtime = { binary: path.join(releaseRoot, 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh'), key: pems.private, cert: pems.cert, ca, certDir, gitPath: path.dirname(which.sync('git')) };
});
after(() => { if (tools) rmSync(tools, { recursive: true, force: true }); });

const schema = buildSchema(`
  scalar URI
  type Query { repository(owner: String!, name: String!): Repository, viewer: User }
  type User { id: ID!, login: String!, name: String, copilotEndpoints: CopilotEndpoints }
  type CopilotEndpoints { api: URI! }
  type Branch { name: String! }
  type Repository {
    id: ID!, databaseId: Int!, name: String!, nameWithOwner: String!, owner: User!,
    url: URI!, sshUrl: URI!, description: String, hasIssuesEnabled: Boolean!,
    hasWikiEnabled: Boolean!, viewerPermission: String!, defaultBranchRef: Branch!,
    parent: Repository, isPrivate: Boolean!, mergeCommitAllowed: Boolean!,
    rebaseMergeAllowed: Boolean!, squashMergeAllowed: Boolean!,
    pullRequest(number: Int!): PullRequest,
    pullRequests(headRefName: String, baseRefName: String, states: [PullRequestState!], first: Int, last: Int, orderBy: PullRequestOrder): PullRequestConnection!,
    issue(number: Int!): Issue, issueOrPullRequest(number: Int!): IssueOrPullRequest
  }
  union IssueOrPullRequest = Issue | PullRequest
  enum OrderDirection { ASC DESC }
  enum PullRequestOrderField { CREATED_AT UPDATED_AT }
  input PullRequestOrder { field: PullRequestOrderField!, direction: OrderDirection! }
  enum PullRequestState { OPEN CLOSED MERGED }
  type PullRequestConnection { nodes: [PullRequest!]!, totalCount: Int! }
  type PullRequest { id: ID!, number: Int!, url: URI!, title: String!, body: String!, state: PullRequestState!, headRefName: String!, baseRefName: String!, isCrossRepository: Boolean!, headRepositoryOwner: User! }
  type Issue { id: ID!, number: Int!, url: URI!, title: String!, body: String! }
  input CreatePullRequestInput { repositoryId: ID!, title: String!, body: String!, draft: Boolean, baseRefName: String!, headRefName: String!, maintainerCanModify: Boolean }
  input UpdateIssueInput { id: ID!, title: String, body: String }
  type CreatePullRequestPayload { pullRequest: PullRequest! }
  type UpdateIssuePayload { issue: Issue! }
  type Mutation { createPullRequest(input: CreatePullRequestInput!): CreatePullRequestPayload!, updateIssue(input: UpdateIssueInput!): UpdateIssuePayload! }
`);

async function fixture(t, agentTask = false) {
  const home = mkdtempSync(path.join(tmpdir(), 'cosplaying-gh-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cosplaying-gh-cwd-'));
  const requests = [];
  const failures = [];
  const pulls = [];
  const issue = { id: 'ISSUE_1', number: 1, title: 'Existing issue', body: 'Existing issue body' };
  const gists = new Map([['123', { id: '123', files: { 'old.js': { content: 'Old content' } } }]]);
  const reruns = [];
  const comments = [];
  const merges = [];
  const jobs = [];
  let origin;
  let proxy;
  const repository = {
    id: 'REPO_1', databaseId: 1, name: 'repo', nameWithOwner: 'owner/repo',
    owner: { id: 'USER_1', login: 'owner' }, description: 'A local test repository',
    hasIssuesEnabled: true, hasWikiEnabled: true, viewerPermission: 'WRITE',
    defaultBranchRef: { name: 'main' }, isPrivate: true,
    mergeCommitAllowed: true, rebaseMergeAllowed: true, squashMergeAllowed: true,
    get url() { return `${origin}/owner/repo`; },
    get sshUrl() { return `${origin}/owner/repo.git`; },
    pullRequest({ number }) { return pulls.find((pull) => pull.number === number); },
    pullRequests({ headRefName, baseRefName }) {
      const nodes = pulls.filter((pull) => (!headRefName || pull.headRefName === headRefName) && (!baseRefName || pull.baseRefName === baseRefName));
      return { nodes, totalCount: nodes.length };
    },
    issue() { return { ...issue, __typename: 'Issue', url: `${origin}/owner/repo/issues/1` }; },
    issueOrPullRequest() { return repository.issue(); },
  };
  const rootValue = {
    repository() { return repository; },
    viewer() { return { id: 'USER_1', login: 'owner', copilotEndpoints: { api: origin } }; },
    createPullRequest({ input }) {
      const number = pulls.length + 1;
      const pull = { ...input, id: `PR_${number}`, number, url: `${origin}/owner/repo/pull/${number}`, state: 'OPEN', isCrossRepository: false, headRepositoryOwner: repository.owner };
      pulls.push(pull);
      return { pullRequest: pull };
    },
    updateIssue({ input }) { Object.assign(issue, input); return { issue: repository.issue() }; },
  };
  const server = createServer({ listen: false, key: runtime.key, cert: runtime.cert }, {
    request: async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const payload = text ? JSON.parse(text) : undefined;
      const route = new URL(request.url, origin).pathname.replace(/^\/api\/v3/, '');
      requests.push({ method: request.method, route, payload });
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('X-GitHub-Enterprise-Version', '3.20.0');
      let data;
      if (route === '/api/graphql' || route === '/graphql') {
        data = await graphql({ schema, source: payload.query, variableValues: payload.variables, operationName: payload.operationName, rootValue });
        if (data.errors) failures.push(...data.errors.map((error) => error.message));
      } else if (request.method === 'GET' && route === '/meta') {
        data = { installed_version: '3.20.0' };
      } else if (request.method === 'GET' && route === '/user') {
        data = { login: 'owner', id: 1 };
      } else if (request.method === 'GET' && route === '/repos/owner/repo/actions/runs/42') {
        data = { id: 42, workflow_id: 7, status: 'completed', conclusion: 'failure', html_url: `${origin}/owner/repo/actions/runs/42` };
      } else if (request.method === 'GET' && route === '/repos/owner/repo/actions/workflows/7') {
        data = { id: 7, name: 'Local workflow', path: '.github/workflows/test.yml' };
      } else if (request.method === 'POST' && /^\/repos\/owner\/repo\/actions\/(runs\/42\/(rerun|rerun-failed-jobs)|jobs\/7\/rerun)$/.test(route)) {
        reruns.push({ route, payload }); response.statusCode = 201; data = {};
      } else if (request.method === 'POST' && route === '/repos/owner/repo/issues/1/comments') {
        const comment = { ...payload, id: comments.length + 1 };
        comments.push(comment); response.statusCode = 201; data = comment;
      } else if (request.method === 'PUT' && route === '/repos/owner/repo/pulls/23/merge') {
        merges.push(payload); data = {};
      } else if (request.method === 'POST' && route === '/gists') {
        const gist = { ...payload, id: String(gists.size + 1) };
        gists.set(gist.id, gist); response.statusCode = 201; data = gist;
      } else if (request.method === 'PATCH' && route === '/gists/123') {
        const gist = gists.get('123');
        if (Object.hasOwn(payload, 'description')) gist.description = payload.description;
        for (const [name, file] of Object.entries(payload.files)) {
          if (file === null) delete gist.files[name];
          else gist.files[name] = file;
        }
        data = gist;
      } else if (request.method === 'POST' && route === '/agents/swe/v1/jobs/owner/repo') {
        const job = { ...payload, id: `job-${jobs.length + 1}` };
        jobs.push(job);
        const { pullRequest } = rootValue.createPullRequest({ input: {
          repositoryId: repository.id, title: 'Agent task', body: job.problem_statement,
          baseRefName: 'main', headRefName: job.id,
        } });
        response.statusCode = 201;
        data = { job_id: job.id, pull_request: { number: pullRequest.number } };
      } else {
        const message = `Unexpected local GitHub request: ${request.method} ${route}`;
        failures.push(message); response.statusCode = 404; data = { message };
      }
      response.end(JSON.stringify(data));
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `https://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (proxy) await proxy.close(true);
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  writeFileSync(path.join(cwd, '.cosplaying.json'), JSON.stringify({ plugins: ['gh'] }));
  const context = {
    home, cwd, origin, requests, pulls, issue, gists, reruns, comments, merges, jobs,
    env: {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'), GH_CONFIG_DIR: path.join(home, 'gh'),
      GH_HOST: new URL(origin).host, GH_REPO: `${new URL(origin).host}/owner/repo`, GH_ENTERPRISE_TOKEN: 'local-test-token',
      GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_TELEMETRY: '0', DO_NOT_TRACK: '1',
      SSL_CERT_FILE: runtime.ca, SSL_CERT_DIR: runtime.certDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GODEBUG: 'x509sslcertoverrideplatform=1', COSPLAYING_GH_BIN: runtime.binary,
      PATH: runtime.gitPath ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  };
  proxy = new ProxyServer({
    host: '127.0.0.1', port: 0,
    prepareRequestFunction: ({ isHttp }) => {
      if (isHttp) throw new RequestError('Only local HTTPS CONNECT requests are supported.', 403);
      return { customConnectServer: server };
    },
  });
  await proxy.listen();
  Object.assign(context.env, {
    NO_PROXY: '', HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
  });
  if (agentTask) {
    mkdirSync(context.env.GH_CONFIG_DIR, { recursive: true });
    writeFileSync(path.join(context.env.GH_CONFIG_DIR, 'hosts.yml'), 'github.com:\n  user: local-fixture\n  oauth_token: gho_local_fixture_not_a_real_token\n');
    delete context.env.GH_ENTERPRISE_TOKEN;
    Object.assign(context.env, {
      GH_HOST: 'github.com', GH_REPO: 'owner/repo',
    });
  }
  const control = await run(['hook', '--', 'gh', 'api', 'user'], context);
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(JSON.parse(control.stdout), { login: 'owner', id: 1 });
  assert.equal(requests.length, 1);
  requests.length = 0;
  return context;
}

async function run(args, context) {
  const child = spawn(process.execPath, [bin, ...args], { cwd: context.cwd, env: context.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

function createPull(context, bodyArgs) {
  return run(['hook', '--model', 'Example', '--', 'gh', 'pr', 'create', '--repo', `${new URL(context.origin).host}/owner/repo`, '--base', 'main', '--head', `owner:feature-${context.pulls.length}`, '--title', 'Example', ...bodyArgs], context);
}

test('gh delivers attributed inline and file bodies without changing source files', async (t) => {
  const context = await fixture(t);
  const created = await createPull(context, ['--body', 'The change is ready.']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(context.pulls[0].body, `The change is ready.\n\n${block}`);
  const source = path.join(context.cwd, 'body.md');
  const original = 'Hello from the file.\n'; writeFileSync(source, original);
  const filed = await createPull(context, ['--body-file', source]);
  assert.equal(filed.status, 0, filed.stderr);
  assert.equal(context.pulls[1].body, `Hello from the file.\n\n${block}`);
  assert.equal(readFileSync(source, 'utf8'), original);
});

test('missing-model writes are refused before delivery and reads remain available', async (t) => {
  const context = await fixture(t);
  const blocked = await run(['hook', '--', 'gh', 'pr', 'create', '--title', 'Example', '--body', 'Hello'], context);
  assert.equal(blocked.status, 2); assert.match(blocked.stderr, /BLOCKED \(command not run\)/);
  assert.deepEqual(context.requests, []);
  context.pulls.push({ id: 'PR_1', number: 1, body: 'An existing pull request', title: 'Existing', url: `${context.origin}/owner/repo/pull/1`, state: 'OPEN' });
  const viewed = await run(['hook', '--', 'gh', 'pr', 'view', '1', '--json', 'number,body'], context);
  assert.equal(viewed.status, 0, viewed.stderr);
  assert.deepEqual(JSON.parse(viewed.stdout), { number: 1, body: 'An existing pull request' });
  assert.ok(context.requests.length > 0);
});

test('textless workflow and job reruns reach the API without disclosure text', async (t) => {
  const context = await fixture(t);
  const cli = await run(['hook', '--', 'gh', 'run', 'rerun', '42'], context);
  assert.equal(cli.status, 0, cli.stderr);
  for (const endpoint of ['repos/owner/repo/actions/runs/42/rerun', 'repos/owner/repo/actions/runs/42/rerun-failed-jobs', 'repos/owner/repo/actions/jobs/7/rerun']) {
    const result = await run(['hook', '--', 'gh', 'api', '--method', 'POST', endpoint], context);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(context.reruns.map(({ route }) => route), ['/repos/owner/repo/actions/runs/42/rerun', '/repos/owner/repo/actions/runs/42/rerun', '/repos/owner/repo/actions/runs/42/rerun-failed-jobs', '/repos/owner/repo/actions/jobs/7/rerun']);
  for (const value of context.reruns) assert.doesNotMatch(JSON.stringify(value.payload ?? null), /cosplaying|AI-Assisted-By/);
  const before = context.requests.length;
  const comment = await run(['hook', '--', 'gh', 'api', '--method', 'POST', 'repos/owner/repo/actions/runs/42/pending_deployments', '-fcomment=Deploy'], context);
  assert.equal(comment.status, 2); assert.match(comment.stderr, /COSPLAYING_MODEL|--model/);
  assert.equal(context.requests.length, before);
});

test('gh serializes attached flags and flag-shaped body values with attribution', async (t) => {
  const context = await fixture(t);
  const apiComment = await run(['hook', '--model', 'Example', '--', 'gh', 'api', 'repos/owner/repo/issues/1/comments', '-XPOST', '-fbody=hello'], context);
  assert.equal(apiComment.status, 0, apiComment.stderr);
  assert.equal(context.comments[0].body, `hello\n\n${block}`);
  const edited = await run(['hook', '--model', 'Example', '--', 'gh', 'issue', 'edit', '1', '-bhello'], context);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(context.issue.body, `hello\n\n${block}`);
  const created = await createPull(context, ['--body', '-b begins with a flag']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(context.pulls[0].body, `-b begins with a flag\n\n${block}`);
});

test('REST merge requests preserve source files and attribute explicit and default messages', async (t) => {
  const context = await fixture(t);
  for (const body of [{ commit_title: 'Merge change', commit_message: 'Merge details.' }, { commit_title: 'Merge change' }]) {
    const source = path.join(context.cwd, 'merge.json');
    const original = `${JSON.stringify(body, null, 2)}\n`; writeFileSync(source, original);
    const result = await run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'PUT', 'repos/owner/repo/pulls/23/merge', '--input', source], context);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(context.merges.at(-1), { commit_title: 'Merge change', commit_message: `${body.commit_message ? `${body.commit_message}\n\n` : ''}${trailer}\n` });
    assert.equal(readFileSync(source, 'utf8'), original);
  }
});

test('an unsupported API mutation is refused before HTTP delivery', async (t) => {
  const context = await fixture(t);
  const result = await run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'POST', 'repos/owner/name/dispatches'], context);
  assert.equal(result.status, 2); assert.match(result.stderr, /blocked unsupported mutating gh api request/);
  assert.match(result.stderr, /For more information visit: https:\/\/github\.com\/3rd-Eden\/cosplay\/tree\/main\/packages\/cli\/README\.md#error-[0-9a-f]{6}/);
  assert.deepEqual(context.requests, []);
});

test('gist content without a description is refused and the input stays unchanged', async (t) => {
  const context = await fixture(t);
  const source = path.join(context.cwd, 'gist.json');
  const original = JSON.stringify({ files: { 'example.js': { content: 'console.log("hello");' } } }); writeFileSync(source, original);
  const result = await run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'POST', 'gists', '--input', source], context);
  assert.equal(result.status, 2); assert.match(result.stderr, /description/);
  assert.deepEqual(context.requests, []); assert.equal(readFileSync(source, 'utf8'), original);
});

test('gist requests attribute descriptions and preserve file content and source bytes', async (t) => {
  const context = await fixture(t);
  const source = path.join(context.cwd, 'gist.json');
  const files = { 'example.js': { content: 'console.log("hello");' } };
  const original = JSON.stringify({ description: 'A small example.', files }); writeFileSync(source, original);
  const result = await run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'POST', 'gists', '--input', source], context);
  assert.equal(result.status, 0, result.stderr);
  const gist = [...context.gists.values()].at(-1);
  assert.deepEqual(gist.files, files); assert.equal(gist.description, `A small example.\n\n${block}`);
  assert.equal(readFileSync(source, 'utf8'), original);
});

test('gist file removal requires no description and preserves the input', async (t) => {
  const context = await fixture(t);
  const source = path.join(context.cwd, 'gist.json');
  const original = JSON.stringify({ files: { 'old.js': null } }); writeFileSync(source, original);
  const result = await run(['hook', '--model', 'Example', '--', 'gh', 'api', '--method', 'PATCH', 'gists/123', '--input', source], context);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(context.requests.at(-1), { method: 'PATCH', route: '/gists/123', payload: { files: { 'old.js': null } } });
  assert.deepEqual(context.gists.get('123').files, {});
  assert.equal(Object.hasOwn(context.gists.get('123'), 'description'), false);
  assert.equal(readFileSync(source, 'utf8'), original);
});

test('gist CLI content commands without description are refused before delivery', async (t) => {
  const context = await fixture(t);
  const source = path.join(context.cwd, 'example.js'); writeFileSync(source, 'console.log("hello");');
  for (const args of [['gist', 'create', source], ['gist', 'edit', 'abc123', '--add', source]]) {
    const result = await run(['hook', '--model', 'Example', '--', 'gh', ...args], context);
    assert.equal(result.status, 2); assert.match(result.stderr, /needs explicit text/);
    assert.deepEqual(context.requests, []); assert.equal(readFileSync(source, 'utf8'), 'console.log("hello");');
  }
});

test('agent-task sends the attributed positional description to the discovered API', async (t) => {
  const context = await fixture(t, true);
  const result = await run(['hook', '--model', 'Example', '--', 'gh', 'agent-task', 'create', 'Write a short summary.'], context);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(context.jobs.length, 1);
  assert.equal(context.jobs[0].problem_statement, `Write a short summary.\n\n${block}`);
  assert.match(result.stdout, /owner\/repo\/pull\/1/);
  const viewed = await run(['hook', '--', 'gh', 'pr', 'view', '1', '--json', 'number,body'], context);
  assert.equal(viewed.status, 0, viewed.stderr);
  assert.deepEqual(JSON.parse(viewed.stdout), { number: 1, body: `Write a short summary.\n\n${block}` });
});
