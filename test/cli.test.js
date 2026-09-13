import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AxiError, sessionStartHookStatus } from 'axi-sdk-js';
import { decode, encode } from '@toon-format/toon';
import { dispatch, commandHelp } from '../src/cli.js';
import { GUIDE, NEXT } from '../src/guidance.js';
import { configuration, request, redact, preview } from '../src/api.js';

const bin = resolve('bin/telebugs-axi.js');
mkdirSync('.cache/tests', { recursive: true });
function workspace(t) {
  const path = mkdtempSync(resolve('.cache/tests/run-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function cli(args, cwd, env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd, env: { ...process.env, TELEBUGS_URL: '', TELEBUGS_API_KEY: '', ...env }, timeout: 10000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
}
async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise(resolveReady => instance.listen(0, '127.0.0.1', resolveReady));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return { TELEBUGS_URL: `http://127.0.0.1:${instance.address().port}`, TELEBUGS_API_KEY: 'tlbgs_fixture_only' };
}
const page = (key, rows = [], more = false) => ({ [key]: rows, has_more: more, next_cursor: more ? 9 : null });

// All server data is synthetic. No test reads local credentials or calls a live instance.
test('strict validation happens before transport, including with help', async () => {
  let calls = 0;
  const api = async () => { calls++; };
  for (const [command, args] of [
    ['projects', ['--project', '1']], ['projects', ['--limt', '1', '--help']],
    ['groups', ['--project', '1', '--limit', '101']], ['groups', ['--project', '1', '--cursor', '-1']],
    ['groups', ['--project', '1', '--query', '']], ['groups', ['--project', '1', '--project', '2']],
    ['groups', ['--project', '1', '--since', 'yesterday']], ['groups', ['--project', '1', '--since', '2026-06-02', '--until', '2026-06-01']],
    ['groups', ['--project', '1', '--since', '2026-02-30']], ['groups', ['--project', '1', '--since', '2026-01-01T12:00:00']],
    ['report', ['2', '--project', '1']], ['report', ['2', '--group', '3', '--project', '1', '--fields', '__proto__']],
    ['resolve', ['4', '--project', '1']], ['mute', ['../4', '--project', '1', '--confirm']],
    ['unmute', ['4', '--project', '9007199254740992', '--confirm']],
    ['projects', ['extra']], ['setup', ['hooks']], ['setup', ['remove', '--project', '1']],
    ['setup', ['remove', '--project', '1', '--help']], ['setup', ['unknown', '--help']],
    ['groups', ['extra', '--help']], ['report', ['1', '2', '--help']],
    ['update', ['--wat']], ['update', ['extra']],
  ]) {
    await assert.rejects(dispatch(command, args, { api }), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(calls, 0);
});

test('projects, groups, reports and report map to published REST routes', async () => {
  const calls = [];
  const api = async (path, options) => {
    calls.push([path, options]);
    if (path.endsWith('/reports/3')) return { id: 3, error_message: 'synthetic' };
    const key = path.split('/').at(-1);
    return page(key, [{ id: 2, error_type: 'TypeError', resolved: false, muted: true, reports_count: 8 }]);
  };
  const groups = await dispatch('groups', ['--project', '1', '--query', 'is:unresolved server_name:"example"', '--since', '2026-01-01'], { api });
  assert.deepEqual(groups.groups[0], { id: 2, error_type: 'TypeError', state: 'unresolved,muted', reports_count: 8 });
  assert.equal(groups.total, 1);
  await dispatch('projects', ['--name', 'Example', '--cursor', '3'], { api });
  const reports = await dispatch('reports', ['2', '--project', '1'], { api });
  assert.ok(reports.help[0].includes('--group 2 --project 1'));
  await dispatch('report', ['3', '--project', '1', '--group', '2'], { api });
  assert.deepEqual(calls.map(([path]) => path), ['projects/1/groups', 'projects', 'projects/1/groups/2/reports', 'projects/1/groups/2/reports/3']);
  assert.deepEqual(calls[0][1].query, { limit: 50, query: 'is:unresolved server_name:"example"', since: '2026-01-01' });
  assert.deepEqual(calls[1][1].query, { limit: 50, cursor: 3, name: 'Example' });
});

test('pagination, empty states, field selection and previews stay explicit', async () => {
  const rows = Array.from({ length: 50 }, (_, id) => ({ id: id + 1, error_message: 'x'.repeat(1200) }));
  const args = ['--project', '1', '--query', 'is:unresolved', '--fields', 'id,error_message'];
  const result = await dispatch('groups', args, { api: async () => page('groups', rows, true) });
  assert.equal(result.count, 50);
  assert.equal(result.groups.length, 50);
  assert.equal(result.total, null);
  assert.equal(result.next_cursor, 9);
  assert.match(result.groups[0].error_message, /1200 UTF-16 units total; use --full/);
  assert.ok(result.help.some(hint => hint.includes('--query \'is:unresolved\'') && hint.endsWith('--cursor <next_cursor>')));
  const full = await dispatch('groups', [...args, '--full'], { api: async () => page('groups', rows) });
  assert.equal(full.groups[0].error_message.length, 1200);
  const empty = await dispatch('groups', ['--project', '1'], { api: async () => page('groups') });
  assert.equal(empty.total, 0);
  assert.match(empty.message, /^0 groups/);
  const last = await dispatch('groups', ['--project', '1', '--cursor', '9'], { api: async () => page('groups') });
  assert.equal(last.total, null);
  await assert.rejects(dispatch('projects', [], { api: async () => ({ projects: [] }) }), { code: 'RESPONSE' });
  await assert.rejects(dispatch('projects', [], { api: async () => ({ projects: [], has_more: true, next_cursor: null }) }), { code: 'RESPONSE' });
});

test('full report preserves data but not known credentials; TOON round-trips', async () => {
  const report = { id: 3, error_message: 'quote, "newline"\nsecond line', request: { headers: { Authorization: 'fixture-secret' }, cookies: { session: 'fixture-secret' } }, token: 'fixture-secret', tags: [{ key: 'api_key', value: 'fixture-secret' }], extras: [{ name: 'password', data: 'fixture-secret' }], contexts: Array.from({ length: 25 }, (_, id) => ({ id })), other: 'tlbgs_fixture_only', text: 'x'.repeat(1500) };
  const args = ['3', '--project', '1', '--group', '2'];
  const compact = await dispatch('report', args, { api: async () => report });
  assert.ok(compact.help.some(hint => hint.endsWith('--full')));
  const full = await dispatch('report', [...args, '--full'], { api: async () => report });
  assert.equal(full.report.contexts.length, 25);
  assert.equal(full.report.text.length, 1500);
  assert.equal(full.untrusted, true);
  const output = encode(full);
  assert.doesNotMatch(output, /fixture-secret|tlbgs_fixture_only/);
  assert.deepEqual(decode(output), full);
  assert.equal(redact('my key is abc', 'abc'), 'my key is [REDACTED]');
  assert.equal(preview('abcdef', false, 3).truncated, true);
});

test('all mutations use documented idempotent bulk actions for a single group', async () => {
  for (const [command, method, action] of [['resolve', 'POST', 'bulk_resolve'], ['unresolve', 'DELETE', 'bulk_resolve'], ['mute', 'POST', 'bulk_mute'], ['unmute', 'DELETE', 'bulk_mute']]) {
    let count = 0;
    const api = async (path, options) => {
      assert.equal(path, `projects/1/groups/2/${action}`);
      assert.deepEqual(options, { method, body: { group_ids: [2] } });
      return { processed: count++ === 0 ? 1 : 0 };
    };
    assert.equal((await dispatch(command, ['2', '--project', '1', '--confirm'], { api })).changed, true);
    assert.equal((await dispatch(command, ['2', '--project', '1', '--confirm'], { api })).changed, false);
  }
  await assert.rejects(dispatch('resolve', ['2', '--project', '1', '--confirm'], { api: async () => null }), { code: 'RESPONSE' });
});

test('transport encodes queries, authenticates, sends flat bodies, and accepts 204', async t => {
  const seen = [];
  const env = await server(t, (req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      if (req.method === 'GET') res.end(JSON.stringify(page('projects')));
      else { res.writeHead(204); res.end(); }
    });
  });
  await request('projects', { env, query: { name: 'A & B/"example"' } });
  assert.equal(new URL(seen[0].url, env.TELEBUGS_URL).searchParams.get('name'), 'A & B/"example"');
  assert.equal(seen[0].auth, `Bearer ${env.TELEBUGS_API_KEY}`);
  assert.equal(await request('projects/1/groups/2/bulk_resolve', { env, method: 'POST', body: { group_ids: [2] } }), null);
  assert.equal(seen[1].body, '{"group_ids":[2]}');
});

test('transport rejects insecure config, redirects, errors and invalid responses without raw payloads', async t => {
  for (const url of ['', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/mcp', 'https://example.com/?key=secret']) {
    assert.throws(() => configuration({ TELEBUGS_URL: url, TELEBUGS_API_KEY: 'fixture' }), { code: 'CONFIG' });
  }
  assert.throws(() => configuration({ TELEBUGS_URL: 'https://example.com', TELEBUGS_API_KEY: 'bad\nvalue' }), { code: 'AUTH' });
  let hits = 0;
  const env = await server(t, (req, res) => {
    hits++;
    const status = Number(req.url.split('/').at(-1));
    res.writeHead(status, { Location: '/must-not-follow' });
    res.end('fixture-private-error-payload');
  });
  for (const status of [302, 401, 403, 404, 422, 429, 500]) {
    await assert.rejects(request(String(status), { env }), error => error.code === `HTTP_${status}` && !error.message.includes('fixture-private'));
  }
  assert.equal(hits, 7);
  const fetchImpl = async () => { throw new Error('fixture-private-error-payload'); };
  await assert.rejects(request('projects', { env, fetchImpl }), { code: 'TRANSPORT' });
  await assert.rejects(request('projects', { env, fetchImpl: async () => new Response('not json') }), { code: 'TRANSPORT' });
  await assert.rejects(request('projects', { env, fetchImpl: async () => new Response('[]') }), { code: 'TRANSPORT' });
  const hanging = await server(t, () => {});
  await assert.rejects(request('projects', { env: hanging, timeout: 20 }), { code: 'TRANSPORT' });
});

test('CLI home, exit codes, help and safe errors work end to end', async t => {
  const cwd = workspace(t);
  let calls = 0;
  const env = await server(t, (req, res) => {
    calls++;
    const resource = req.url.includes('/groups') ? 'groups' : 'projects';
    res.end(JSON.stringify(page(resource)));
  });
  const home = await cli([], cwd, env);
  assert.equal(home.code, 0);
  assert.equal(home.stderr, '');
  assert.equal(decode(home.stdout).bin, bin.replace(process.env.HOME, '~'));
  assert.deepEqual(decode(home.stdout).projects, []);
  assert.equal(decode(home.stdout).guidance, GUIDE);
  assert.deepEqual(decode(home.stdout).examples, NEXT);
  const skill = readFileSync('skills/telebugs-axi/SKILL.md', 'utf8');
  const executable = 'node /absolute/path/to/telebugs-axi/bin/telebugs-axi.js';
  assert.ok(skill.includes(GUIDE.replaceAll('telebugs-axi ', `${executable} `)));
  for (const example of NEXT) assert.ok(skill.includes(example.replace(/^telebugs-axi\b/, executable)));
  assert.doesNotMatch(skill, /^telebugs-axi /m);
  writeFileSync(join(cwd, '.telebugs-axi.json'), '{"project":1}');
  assert.equal(decode((await cli([], cwd, env)).stdout).project, 1);
  for (const args of [['unknown'], ['constructor'], ['__proto__'], ['groups', '--wat'], ['resolve', '2', '--project', '1']]) {
    const result = await cli(args, cwd, env);
    assert.equal(result.code, 2);
    assert.equal(decode(result.stdout).code, 'VALIDATION_ERROR');
    assert.equal(result.stderr, '');
  }
  for (const command of ['projects', 'groups', 'reports', 'report', 'resolve', 'unresolve', 'mute', 'unmute', 'setup', 'setup hooks', 'setup remove', 'update']) {
    const result = await cli([...command.split(' '), '--help'], cwd);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  }
  assert.equal(calls, 2);
  const noAuth = await cli(['projects'], cwd);
  assert.equal(noAuth.code, 1);
  assert.equal(noAuth.stderr, '');
  const failure = await server(t, (req, res) => { res.writeHead(500); res.end('fixture-private-error-payload'); });
  const error = await cli(['resolve', '2', '--project', '1', '--confirm'], cwd, failure);
  assert.equal(error.code, 1);
  assert.doesNotMatch(error.stdout + error.stderr, /fixture-private-error-payload|tlbgs_fixture_only/);
  assert.match(error.stdout, /outcome may be unknown/);
  assert.ok(decode(error.stdout).help.includes('telebugs-axi groups --project 1'));
});

test('project hook setup is opt-in, repeatable, removable and stays in the test sandbox', async t => {
  const cwd = workspace(t), homeDir = join(cwd, 'home');
  const hookStatus = () => sessionStartHookStatus({ marker: 'telebugs-axi', scope: 'project', projectDir: cwd, homeDir });
  mkdirSync(homeDir);
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } }));
  await dispatch('setup', ['hooks', '--project', '1'], { cwd, homeDir });
  const installed = hookStatus();
  assert.equal(installed.scope, 'project');
  assert.equal(installed.claude.installed, true);
  assert.equal(installed.codex.installed, true);
  assert.equal(installed.codex.userFeatureEnabled, true);
  assert.equal(installed.opencode.installed, true);
  await dispatch('setup', ['hooks', '--project', '1'], { cwd, homeDir });
  assert.deepEqual(hookStatus(), installed);
  await dispatch('setup', ['remove'], { cwd, homeDir });
  const removed = hookStatus();
  assert.equal(removed.claude.installed, false);
  assert.equal(removed.codex.installed, false);
  assert.equal(removed.codex.userFeatureEnabled, true);
  assert.equal(removed.opencode.installed, false);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf8')).hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }]);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.telebugs-axi.json'), 'utf8')), { project: 1 });
  const empty = workspace(t);
  const session = spawnSync(process.execPath, [resolve('bin/telebugs-axi-session.js')], { cwd: empty, encoding: 'utf8', env: { ...process.env, TELEBUGS_URL: '', TELEBUGS_API_KEY: '' } });
  assert.equal(session.status, 0);
  assert.equal(session.stdout, '');
});

test('version aliases work without loading the dependency graph', t => {
  const cwd = workspace(t);
  const floor = [];
  const timings = [];
  for (const flag of ['-v', '-V', '--version']) {
    let start = performance.now();
    assert.equal(spawnSync(process.execPath, ['-e', 'console.log(1)'], { encoding: 'utf8' }).status, 0);
    floor.push(performance.now() - start);
    start = performance.now();
    const result = spawnSync(process.execPath, [bin, flag], { cwd, encoding: 'utf8', timeout: 5000 });
    timings.push(performance.now() - start);
    assert.equal(result.stdout, '0.1.0\n');
    assert.equal(result.status, 0);
  }
  assert.ok(Math.min(...timings) < Math.max(...floor) * 5, 'version should stay near Node startup cost');
});

test('TOON 4.1 and Unicode previews stay valid through the SDK output boundary', async t => {
  assert.equal(encode({ rows: [{ text: '#data' }] }), 'rows[1]{text}:\n  "#data"');
  assert.equal(encode({ rows: [{ id: 1, nested: { a: 'x' } }, { id: 2, nested: { a: 'y' } }] }), 'rows[2]{id,nested{a}}:\n  1,x\n  2,y');
  assert.equal(encode({ a: { x: 1 }, b: { x: 2 } }), '[2:]{x}:\n  a: 1\n  b: 2');
  assert.throws(() => encode({ text: '\ud800' }), /unpaired surrogate/);
  const text = 'a'.repeat(999) + '\u{1F600}';
  const compact = preview(text);
  assert.equal(compact.value.isWellFormed(), true);
  assert.ok(compact.value.startsWith('a'.repeat(999) + '...'));
  assert.equal(preview(text, true).value, text);
  assert.equal(preview('\u{1F600}x', false, 1).value.isWellFormed(), true);

  let body = { id: 3, text, rows: [{ text: '#data' }], nested: { a: { x: 1 }, b: { x: 2 } }, tlbgs_fixture_key_name: 'safe' };
  const env = await server(t, (req, res) => res.end(JSON.stringify(body)));
  const cwd = workspace(t), args = ['report', '3', '--group', '2', '--project', '1'];
  const result = await cli(args, cwd, env);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const data = decode(result.stdout);
  assert.equal(data.report.text, compact.value);
  assert.deepEqual(data.report.rows, [{ text: '#data' }]);
  assert.deepEqual(data.report.nested, { a: { x: 1 }, b: { x: 2 } });
  assert.doesNotMatch(result.stdout, /tlbgs_fixture_key_name|\uFFFD/);
  const full = decode((await cli([...args, '--full'], cwd, env)).stdout);
  assert.equal(full.report.text, text);
  assert.equal(full.help, undefined);
  body = { id: 3, text: '\ud800' };
  const invalid = await cli(args, cwd, env);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stderr, '');
  assert.equal(decode(invalid.stdout).code, 'LOCAL_ERROR');
});

test('help and corrections use the command flags and preserve known targets', async t => {
  const report = commandHelp('report');
  assert.deepEqual(report.required, ['--group']);
  assert.match(report.usage, /<report-id>/);
  assert.match(report.fields, /All available/);
  assert.equal(Object.hasOwn(report.flags, '--limit <value>'), false);
  assert.deepEqual(commandHelp('resolve').required, ['--confirm']);
  assert.equal(Object.hasOwn(commandHelp('resolve').flags, '--max-chars <value>'), false);
  assert.deepEqual(Object.keys(commandHelp('setup remove').flags), ['--help']);
  assert.deepEqual(commandHelp('setup hooks').required, ['--project']);
  assert.equal(commandHelp('groups').examples.length, 2);
  let calls = 0;
  const api = async () => { calls++; };
  await assert.rejects(dispatch('groups', ['--wat'], { api }), error => {
    assert.match(error.message, /Unknown flag --wat for groups/);
    assert.ok(error.suggestions[0].includes('--query'));
    return true;
  });
  await assert.rejects(dispatch('resolve', ['999', '--project', '7'], { api }), error => {
    assert.deepEqual(error.suggestions, ["telebugs-axi resolve '999' --project '7' --confirm"]);
    return true;
  });
  await assert.rejects(dispatch('report', ['999', '--project', '7'], { api }), error => {
    assert.deepEqual(error.suggestions, ["telebugs-axi report '999' --project '7' --group '<group-id>'"]);
    return true;
  });
  assert.equal(calls, 0);
  const cwd = workspace(t);
  const invalidLimit = await cli(['groups', '--project', '7', '--limit', '101'], cwd);
  assert.equal(invalidLimit.code, 2);
  const help = decode(decode(invalidLimit.stdout).help[0]);
  assert.equal(help.usage, 'telebugs-axi groups [flags]');
  assert.ok(Object.hasOwn(help.flags, '--limit <value>'));
  const unavailable = await cli(['update'], cwd);
  assert.equal(unavailable.code, 1);
  assert.equal(decode(unavailable.stdout).code, 'UNAVAILABLE');
  await assert.rejects(dispatch('resolve', ['999', '--project', '7', '--confirm'], { api: async () => { throw new AxiError('Read the group before retrying.', 'TRANSPORT'); } }), error => {
    assert.deepEqual(error.suggestions, ['telebugs-axi groups --project 7']);
    return true;
  });
});

test('next steps follow the result without losing read scope', async () => {
  const args = ['--project', '7', '--query', 'is:resolved'];
  const result = await dispatch('groups', args, { api: async () => page('groups', [{ id: 99, resolved: true, muted: false }]) });
  assert.ok(result.help.includes('telebugs-axi unresolve <group-id> --project 7 --confirm'));
  assert.ok(!result.help.some(hint => hint.startsWith('telebugs-axi resolve ')));
  const empty = await dispatch('groups', args, { api: async () => page('groups') });
  assert.deepEqual(empty.help, ["telebugs-axi groups --project '7'"]);
  const none = await dispatch('groups', ['--project', '7'], { api: async () => page('groups') });
  assert.equal(none.help, undefined);
  const paged = await dispatch('reports', ['999', '--project', '7', '--since', '2026-01-01'], { api: async () => page('reports', [], true) });
  assert.equal(paged.total, null);
  assert.ok(paged.help.includes("telebugs-axi reports '999' --project '7' --since '2026-01-01' --cursor <next_cursor>"));
  const mutation = await dispatch('resolve', ['999', '--project', '7', '--confirm'], { api: async () => ({ processed: 0 }) });
  assert.equal(mutation.changed, false);
  assert.equal(mutation.help, undefined);
});

test('hook setup uses only the first executable PATH match and repairs stale commands', async t => {
  const cwd = workspace(t), homeDir = join(cwd, 'home'), bins = join(cwd, 'bin'), shadow = join(cwd, 'shadow');
  mkdirSync(homeDir); mkdirSync(bins); mkdirSync(shadow);
  const session = resolve('bin/telebugs-axi-session.js');
  symlinkSync(session, join(bins, 'telebugs-axi-session'));
  const other = join(shadow, 'telebugs-axi-session');
  writeFileSync(other, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  for (const [path, expected] of [[bins, 'telebugs-axi-session'], [`${shadow}:${bins}`, session], [`.:${bins}`, session]]) {
    process.env.PATH = path;
    await dispatch('setup', ['hooks', '--project', '1'], { cwd, homeDir });
    const settings = JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks), ['SessionStart']);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, expected);
  }
  chmodSync(other, 0o644);
  process.env.PATH = `${shadow}:${bins}`;
  await dispatch('setup', ['hooks', '--project', '1'], { cwd, homeDir });
  assert.equal(JSON.parse(readFileSync(join(cwd, '.codex/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command, 'telebugs-axi-session');
});

test('generated skill check fails on stale content in an isolated copy', t => {
  const cwd = workspace(t);
  for (const dir of ['src', 'scripts', 'skills/telebugs-axi']) mkdirSync(join(cwd, dir), { recursive: true });
  for (const path of ['src/guidance.js', 'scripts/skill.js']) copyFileSync(path, join(cwd, path));
  writeFileSync(join(cwd, 'skills/telebugs-axi/SKILL.md'), 'stale fixture');
  const stale = spawnSync(process.execPath, [join(cwd, 'scripts/skill.js'), '--check'], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Skill is stale/);
});
