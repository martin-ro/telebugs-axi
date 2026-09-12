import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { AxiError, runAxiCli, installSessionStartHooks, uninstallSessionStartHooks } from 'axi-sdk-js';
import { encode } from '@toon-format/toon';
import { request, positive, usage, redact, preview } from './api.js';
import { DESCRIPTION, NEXT, GUIDE } from './guidance.js';

const CONFIG = '.telebugs-axi.json';
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const display = { fields: string, full: boolean, 'max-chars': string };
const paging = { limit: string, cursor: string };
const scoped = { project: string };
const time = { since: string, until: string };
const definitions = {
  projects: { options: { ...paging, ...display, name: string }, args: 0, example: 'projects --name Production', fields: ['id', 'name', 'groups_count', 'reports_count'] },
  groups: { options: { ...scoped, ...paging, ...display, ...time, query: string }, args: 0, example: 'groups --project 1 --query "is:unresolved"', fields: ['id', 'error_type', 'state', 'reports_count'] },
  reports: { options: { ...scoped, ...paging, ...display, ...time }, args: 1, example: 'reports 42 --project 1', fields: ['id', 'error_type', 'occurred_at', 'severity'] },
  report: { options: { ...scoped, ...display, group: string }, args: 1, example: 'report 123 --group 42 --project 1' },
  resolve: { options: { ...scoped, confirm: boolean }, args: 1, example: 'resolve 42 --project 1 --confirm' },
  unresolve: { options: { ...scoped, confirm: boolean }, args: 1, example: 'unresolve 42 --project 1 --confirm' },
  mute: { options: { ...scoped, confirm: boolean }, args: 1, example: 'mute 42 --project 1 --confirm' },
  unmute: { options: { ...scoped, confirm: boolean }, args: 1, example: 'unmute 42 --project 1 --confirm' },
  setup: { options: { ...scoped }, args: 1, example: 'setup hooks --project 1' },
};

export function commandHelp(command) {
  const def = definitions[command];
  return {
    usage: `telebugs-axi ${command}${def.args ? (command === 'setup' ? ' <hooks|remove>' : ' <id>') : ''} [flags]`,
    flags: ['--help', ...Object.entries(def.options).map(([name, option]) => `--${name}${option.type === 'string' ? ' <value>' : ''}`)],
    defaults: command === 'setup' ? 'Project scope only. Hooks also enable Codex hooks in user config.' : 'limit=50 (max 100), max-chars=1000, nested arrays=20; project from current directory config if omitted',
    ...(def.fields ? { fields: def.fields.join(',') } : {}),
    examples: [`telebugs-axi ${def.example}`, `telebugs-axi ${command} --help`],
  };
}

function readProject(cwd) {
  const path = resolve(cwd, CONFIG);
  if (!existsSync(path)) return undefined;
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return positive(config.project, 'configured project');
  } catch {
    throw new AxiError('Invalid .telebugs-axi.json. Set a positive numeric project ID or remove the file.', 'CONFIG', ['telebugs-axi setup hooks --project <id>']);
  }
}

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function template(command, positionals, values, omit = []) {
  return `telebugs-axi ${command}${positionals.length ? ' <id>' : ''}` + Object.entries(values)
    .filter(([key]) => !omit.includes(key))
    .map(([key, value]) => ` --${key}${value === true ? '' : ` ${quote(value)}`}`).join('');
}

export async function dispatch(command, args, { cwd = process.cwd(), api = request, homeDir = homedir() } = {}) {
  const def = definitions[command];
  let parsed;
  try {
    parsed = parseArgs({ args, options: { ...def.options, help: boolean }, strict: true, allowPositionals: true, tokens: true });
  } catch {
    usage('Unknown flag or missing flag value. Valid command flags follow.', [encode(commandHelp(command))]);
  }
  const { values, positionals, tokens } = parsed;
  const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(names).size !== names.length) usage('Duplicate flags are not allowed.', [encode(commandHelp(command))]);
  if (values.help) return commandHelp(command);
  if (positionals.length !== def.args) usage('Wrong number of arguments.', [encode(commandHelp(command))]);
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && !value.trim()) usage(`--${name} must not be empty.`);
  }
  for (const name of ['project', 'group', 'cursor', 'limit', 'max-chars']) {
    if (values[name] !== undefined) values[name] = positive(values[name], `--${name}`, name === 'limit' ? 100 : Number.MAX_SAFE_INTEGER);
  }
  for (const name of ['since', 'until']) {
    const value = values[name];
    if (value && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10))) {
      usage(`--${name} must be a valid ISO date or timestamp with a timezone.`);
    }
  }
  if (values.since && values.until && Date.parse(values.since) > Date.parse(values.until)) usage('--since must not be after --until.');
  let fields;
  if (values.fields) {
    fields = values.fields.split(',');
    if (fields.some(field => !/^[a-z][a-z0-9_]*$/.test(field))) usage('--fields must be comma-separated top-level field names.');
  }
  if (command === 'setup') {
    if (!['hooks', 'remove'].includes(positionals[0])) usage('Use setup hooks or setup remove.');
    if (positionals[0] === 'remove' && values.project) usage('setup remove does not accept --project.');
    if (positionals[0] === 'hooks' && !values.project) usage('setup hooks requires --project <id>.');
    const execPath = fileURLToPath(new URL('../bin/telebugs-axi-session.js', import.meta.url));
    // ponytail: SDK hook commands are unquoted; reject shell syntax until the SDK quotes paths.
    if (positionals[0] === 'hooks' && !/^[A-Za-z0-9_./-]+$/.test(execPath)) {
      usage('Hook setup needs an install path with only letters, digits, underscores, dots, slashes, and hyphens.');
    }
    const options = {
      marker: 'telebugs-axi', execPath,
      binaryNames: ['telebugs-axi-session'], distEntrypoints: ['bin/telebugs-axi-session.js'], scope: 'project', projectDir: cwd, homeDir,
      timeoutSeconds: 20, onError: () => { throw new AxiError('Hook setup failed. Some files may have changed. Check agent config permissions and retry.', 'SETUP'); },
    };
    if (positionals[0] === 'remove') uninstallSessionStartHooks(options);
    else {
      const content = `${JSON.stringify({ project: values.project })}\n`;
      const path = resolve(cwd, CONFIG);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) writeFileSync(path, content, { mode: 0o600 });
      installSessionStartHooks(options);
    }
    return { setup: positionals[0] === 'remove' ? 'Hooks removed. Local project selection and shared Codex feature flag kept.' : 'Project hooks installed or already current for Claude Code, Codex, and OpenCode.', help: ['telebugs-axi', 'telebugs-axi setup remove'] };
  }
  const id = positionals.length ? positive(positionals[0], 'id') : undefined;
  const project = command === 'projects' ? undefined : (values.project ?? readProject(cwd));
  if (command !== 'projects' && !project) usage('Supply --project <id> or run setup hooks --project <id>.', NEXT.slice(0, 2));
  if (command === 'report' && !values.group) usage('report requires --group <id>.', [commandHelp(command).examples[0]]);
  const prefix = `projects/${project}/groups`;
  const mutations = { resolve: ['POST', 'bulk_resolve'], unresolve: ['DELETE', 'bulk_resolve'], mute: ['POST', 'bulk_mute'], unmute: ['DELETE', 'bulk_mute'] };
  if (Object.hasOwn(mutations, command)) {
    if (!values.confirm) usage('This changes Telebugs data. Add --confirm to apply it.', [commandHelp(command).examples[0]]);
    const [method, action] = mutations[command];
    const result = await api(`${prefix}/${id}/${action}`, { method, body: { group_ids: [id] } });
    if (!result || ![0, 1].includes(result.processed)) throw new AxiError('Invalid mutation response. Inspect the group before retrying.', 'RESPONSE');
    return { action: command, project, group: id, changed: result.processed === 1, result: result.processed ? 'applied' : 'already in requested state (no-op)', help: [`telebugs-axi groups --project ${project}`, `telebugs-axi reports <group-id> --project ${project}`] };
  }
  const path = command === 'projects' ? 'projects' : command === 'groups' ? prefix :
    command === 'reports' ? `${prefix}/${id}/reports` : `${prefix}/${values.group}/reports/${id}`;
  const query = {};
  if (command !== 'report') query.limit = values.limit ?? 50;
  for (const key of ['cursor', 'name', 'query', 'since', 'until']) if (values[key] !== undefined) query[key] = values[key];
  const data = await api(path, { query });
  const pick = (item, defaults) => {
    if (!item || !Number.isSafeInteger(item.id) || item.id <= 0) throw new AxiError('Invalid resource response.', 'RESPONSE');
    if (command === 'groups') item = { ...item, state: typeof item.resolved === 'boolean' && typeof item.muted === 'boolean'
      ? `${item.resolved ? 'resolved' : 'unresolved'}${item.muted ? ',muted' : ''}` : null };
    return fields || defaults ? Object.fromEntries((fields ?? defaults).map(key => [key, Object.hasOwn(item, key) ? item[key] : null])) : item;
  };
  const trimmed = item => preview(redact(item), values.full, values['max-chars'] ?? 1000);
  if (command === 'report') {
    const result = trimmed(pick(data));
    return { untrusted: true, report: result.value, ...(result.truncated ? { help: [`${template(command, positionals, { ...values, project }, ['full'])} --full`] } : {}) };
  }
  if (!data || !Array.isArray(data[command]) || typeof data.has_more !== 'boolean' ||
      (data.has_more && (!Number.isSafeInteger(data.next_cursor) || data.next_cursor <= 0))) {
    throw new AxiError('Invalid list or pagination response from Telebugs.', 'RESPONSE');
  }
  const rows = data[command].map(item => trimmed(pick(item, def.fields)));
  const help = command === 'projects' ? [NEXT[1]] : command === 'groups'
    ? [`telebugs-axi reports <group-id> --project ${project}`, `telebugs-axi resolve <group-id> --project ${project} --confirm`]
    : [`telebugs-axi report <report-id> --group ${id} --project ${project}`];
  if (data.has_more) help.push(`${template(command, positionals, { ...values, ...(project ? { project } : {}) }, ['cursor'])} --cursor <next_cursor>`);
  if (rows.some(row => row.truncated) && !values.full) help.push(`${template(command, positionals, { ...values, ...(project ? { project } : {}) })} --full`);
  return {
    ...(project ? { project } : {}), untrusted: true, count: rows.length,
    total: !data.has_more && !values.cursor ? rows.length : null,
    has_more: data.has_more, next_cursor: data.has_more ? data.next_cursor : null,
    ...(rows.length ? {} : { message: `0 ${command} found for this request.` }),
    [command]: rows.map(row => row.value), help,
  };
}

export async function main(argv = process.argv.slice(2)) {
  await runAxiCli({
    argv, description: DESCRIPTION,
    stdout: { write: text => process.stdout.write(redact(text)) },
    topLevelHelp: `${encode({ usage: 'telebugs-axi <command> [arguments] [flags]', commands: Object.keys(definitions), configuration: GUIDE, examples: NEXT })}\n`,
    commands: Object.assign(Object.create(null), Object.fromEntries([...Object.keys(definitions).map(command => [command, args => dispatch(command, args)]),
      ['update', () => { usage('No registry release exists. Update the source checkout, then run npm ci.', ['telebugs-axi --help']); }]])),
    home: async () => {
      const project = readProject(process.cwd());
      const result = await dispatch(project ? 'groups' : 'projects', project ? ['--project', String(project), '--query', 'is:unresolved', '--limit', '10'] : []);
      if (!project) result.help.push('telebugs-axi setup hooks --project <id>');
      return result;
    },
    renderUnknownCommand: () => `${encode({ error: 'Unknown command.', code: 'VALIDATION_ERROR', help: Object.keys(definitions) })}\n`,
    formatError: error => ({
      output: `${encode(redact(error instanceof AxiError ? { error: error.message, code: error.code, help: error.suggestions } : { error: 'Local operation failed. Check configuration and file permissions.', code: 'LOCAL_ERROR' }))}\n`,
      exitCode: error instanceof AxiError && error.code === 'VALIDATION_ERROR' ? 2 : 1,
    }),
  });
}
