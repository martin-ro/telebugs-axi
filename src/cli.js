import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, accessSync, constants, realpathSync, statSync } from 'node:fs';
import { resolve, delimiter, isAbsolute } from 'node:path';
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
  projects: { options: { ...paging, ...display, name: string }, args: 0, examples: ['projects', 'projects --name "<name>"'], fields: ['id', 'name', 'groups_count', 'reports_count'] },
  groups: { options: { ...scoped, ...paging, ...display, ...time, query: string }, args: 0, examples: ['groups --project <project-id>', 'groups --project <project-id> --query "is:unresolved"'], fields: ['id', 'error_type', 'state', 'reports_count'] },
  reports: { options: { ...scoped, ...paging, ...display, ...time }, args: 1, examples: ['reports <group-id> --project <project-id>', 'reports <group-id> --project <project-id> --fields id,error_message'], fields: ['id', 'error_type', 'occurred_at', 'severity'] },
  report: { options: { ...scoped, ...display, group: string }, args: 1, required: ['group'], examples: ['report <report-id> --group <group-id> --project <project-id>', 'report <report-id> --group <group-id> --project <project-id> --full'] },
  ...Object.fromEntries(['resolve', 'unresolve', 'mute', 'unmute'].map(command => [command, {
    options: { ...scoped, confirm: boolean }, args: 1, required: ['confirm'],
    examples: [`${command} <group-id> --project <project-id> --confirm`, `${command} <group-id> --confirm`],
  }])),
  setup: { options: {}, args: 0, examples: ['setup hooks --project <project-id>', 'setup remove'] },
  'setup hooks': { options: { ...scoped }, args: 0, required: ['project'], examples: ['setup hooks --project <project-id>', 'setup hooks --help'] },
  'setup remove': { options: {}, args: 0, examples: ['setup remove', 'setup remove --help'] },
  update: { options: {}, args: 0, examples: ['update', 'update --help'] },
};
const commandNames = Object.keys(definitions).filter(command => !command.includes(' '));
const flagHelp = {
  project: 'Project ID; required unless set in the current directory configuration.',
  group: 'Required group ID containing this report.',
  confirm: 'Required to apply a status change; absent by default.',
  limit: 'Rows per page; default 50, maximum 100.',
  cursor: 'Use next_cursor from the previous page; absent on the first page.',
  fields: 'Comma-separated top-level field names; default fields listed below.',
  full: 'Remove text and nested-array preview limits, not redaction or pagination; default false.',
  'max-chars': 'Text preview size in UTF-16 units; default 1000, without splitting Unicode characters. Nested arrays keep 20 items unless --full.',
  name: 'Exact project name filter; absent by default.',
  query: 'Telebugs search, for example is:unresolved environment:production; absent by default.',
  since: 'Inclusive start ISO date or timestamp with timezone; absent by default.',
  until: 'Inclusive end ISO date or timestamp with timezone; absent by default.',
};

export function commandHelp(command) {
  const def = definitions[command];
  return {
    usage: `telebugs-axi ${command}${command === 'setup' ? ' <hooks|remove>' : def.args ? ` <${command === 'report' ? 'report' : 'group'}-id>` : ''} [flags]`,
    ...(def.required ? { required: def.required.map(name => `--${name}`) } : {}),
    flags: { '--help': 'Show this command reference.', ...Object.fromEntries(Object.entries(def.options).map(([name, option]) =>
      [`--${name}${option.type === 'string' ? ' <value>' : ''}`, command === 'setup hooks' && name === 'project' ? 'Required project ID to save for this directory.' : flagHelp[name]])) },
    ...(def.options.fields ? { fields: def.fields?.join(',') ?? 'All available report fields.' } : {}),
    ...(command.startsWith('setup') ? { scope: 'Project hooks for Claude Code, Codex and OpenCode; setup hooks also enables the shared user Codex feature. Removal keeps project selection and that feature. No session history.' } : {}),
    ...(command === 'update' ? { message: 'No registry release exists. Update your source checkout, then run npm ci there.' } : {}),
    examples: def.examples.map(example => `telebugs-axi ${example}`),
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

function hookBinaryNames(execPath) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    // Relative PATH entries can resolve to another program in a hook's directory.
    if (!isAbsolute(directory)) return [];
    const candidate = resolve(directory, 'telebugs-axi-session');
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return realpathSync(candidate) === realpathSync(execPath) ? ['telebugs-axi-session'] : [];
    } catch { /* Try the next PATH entry. */ }
  }
  return [];
}

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function template(command, positionals, values, omit = []) {
  return `telebugs-axi ${command}${positionals.map(value => ` ${quote(value)}`).join('')}` + Object.entries(values)
    .filter(([key]) => key !== 'help' && !omit.includes(key))
    .map(([key, value]) => ` --${key}${value === true ? '' : ` ${quote(value)}`}`).join('');
}

export async function dispatch(command, args, { cwd = process.cwd(), api = request, homeDir = homedir() } = {}) {
  if (command === 'setup' && args[0] && !args[0].startsWith('-')) {
    command += ` ${args[0]}`;
    args = args.slice(1);
  }
  if (!Object.hasOwn(definitions, command)) usage('Unknown command or subcommand.', ['telebugs-axi setup hooks --project <project-id>', 'telebugs-axi setup remove']);
  const def = definitions[command];
  const help = commandHelp(command);
  let parsed;
  try {
    parsed = parseArgs({ args, options: { ...def.options, help: boolean }, strict: true, allowPositionals: true, tokens: true });
  } catch (error) {
    const flag = error.message.match(/'(--?[^'=\s]+)/)?.[1] ?? 'flag';
    usage(error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `Unknown flag ${flag} for ${command}.` : `Invalid or missing value for ${flag}.`, [encode(help)]);
  }
  const { values, positionals, tokens } = parsed;
  const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(names).size !== names.length) usage('Duplicate flags are not allowed.', [encode(help)]);
  if (positionals.length > def.args || (!values.help && positionals.length !== def.args)) usage('Wrong number of arguments.', [encode(help)]);
  if (values.help) return help;
  if (command === 'setup') usage('Choose setup hooks or setup remove.', help.examples);
  if (command === 'update') throw new AxiError(help.message, 'UNAVAILABLE', ['npm ci --prefix "<source-checkout>"']);
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
  if (command.startsWith('setup ')) {
    if (command === 'setup hooks' && !values.project) usage('setup hooks requires --project <project-id>.', help.examples);
    const execPath = fileURLToPath(new URL('../bin/telebugs-axi-session.js', import.meta.url));
    // ponytail: SDK hook commands are unquoted; reject shell syntax until the SDK quotes paths.
    if (command === 'setup hooks' && !/^[A-Za-z0-9_./-]+$/.test(execPath)) {
      usage('Hook setup needs an install path with only letters, digits, underscores, dots, slashes, and hyphens.');
    }
    const options = {
      marker: 'telebugs-axi', execPath,
      binaryNames: hookBinaryNames(execPath), distEntrypoints: ['bin/telebugs-axi-session.js'], scope: 'project', projectDir: cwd, homeDir,
      timeoutSeconds: 20, onError: () => { throw new AxiError('Hook setup failed. Some files may have changed. Check agent config permissions and retry.', 'SETUP'); },
    };
    if (command === 'setup remove') uninstallSessionStartHooks(options);
    else {
      const content = `${JSON.stringify({ project: values.project })}\n`;
      const path = resolve(cwd, CONFIG);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) writeFileSync(path, content, { mode: 0o600 });
      installSessionStartHooks(options);
    }
    return { setup: command === 'setup remove' ? 'Hooks removed. Local project selection and shared Codex feature flag kept.' : 'Project hooks installed or already current for Claude Code, Codex, and OpenCode.' };
  }
  const id = positionals.length ? positive(positionals[0], 'id') : undefined;
  const project = command === 'projects' ? undefined : (values.project ?? readProject(cwd));
  if (command !== 'projects' && !project) usage('Supply --project <project-id>.', [template(command, positionals, { ...values, project: '<project-id>' })]);
  if (command === 'report' && !values.group) usage('report requires --group <group-id>.', [template(command, positionals, { ...values, project, group: '<group-id>' })]);
  const inspect = command === 'projects' ? 'telebugs-axi projects' : `telebugs-axi groups --project ${project}`;
  const call = async (path, options) => {
    try { return await api(path, options); }
    catch (error) {
      if (error instanceof AxiError) error.suggestions.push(inspect);
      throw error;
    }
  };
  const prefix = `projects/${project}/groups`;
  const mutations = { resolve: ['POST', 'bulk_resolve'], unresolve: ['DELETE', 'bulk_resolve'], mute: ['POST', 'bulk_mute'], unmute: ['DELETE', 'bulk_mute'] };
  if (Object.hasOwn(mutations, command)) {
    if (!values.confirm) usage('This changes Telebugs data. Add --confirm to apply it.', [template(command, positionals, { ...values, project, confirm: true })]);
    const [method, action] = mutations[command];
    const result = await call(`${prefix}/${id}/${action}`, { method, body: { group_ids: [id] } });
    if (!result || ![0, 1].includes(result.processed)) throw new AxiError('Invalid mutation response. Inspect the group before retrying.', 'RESPONSE', [inspect]);
    return { action: command, project, group: id, changed: result.processed === 1, result: result.processed ? 'applied' : 'already in requested state (no-op)' };
  }
  const path = command === 'projects' ? 'projects' : command === 'groups' ? prefix :
    command === 'reports' ? `${prefix}/${id}/reports` : `${prefix}/${values.group}/reports/${id}`;
  const query = {};
  if (command !== 'report') query.limit = values.limit ?? 50;
  for (const key of ['cursor', 'name', 'query', 'since', 'until']) if (values[key] !== undefined) query[key] = values[key];
  const data = await call(path, { query });
  const pick = (item, defaults) => {
    if (!item || !Number.isSafeInteger(item.id) || item.id <= 0) throw new AxiError('Invalid resource response.', 'RESPONSE', [inspect]);
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
    throw new AxiError('Invalid list or pagination response from Telebugs.', 'RESPONSE', [inspect]);
  }
  const rows = data[command].map(item => trimmed(pick(item, def.fields)));
  const filtered = ['name', 'query', 'since', 'until', 'cursor'].some(key => values[key] !== undefined);
  const next = rows.length === 0 ? (filtered ? [template(command, positionals, project ? { project } : {})] : [])
    : command === 'projects' ? [NEXT[1]] : command === 'groups'
      ? [`telebugs-axi reports <group-id> --project ${project}`]
      : [`telebugs-axi report <report-id> --group ${id} --project ${project}`];
  if (command === 'groups' && rows.length) {
    if (data.groups.every(group => group.resolved === false)) next.push(`telebugs-axi resolve <group-id> --project ${project} --confirm`);
    else if (data.groups.every(group => group.resolved === true)) next.push(`telebugs-axi unresolve <group-id> --project ${project} --confirm`);
  }
  if (data.has_more) next.push(`${template(command, positionals, { ...values, ...(project ? { project } : {}) }, ['cursor'])} --cursor <next_cursor>`);
  if (rows.some(row => row.truncated) && !values.full) next.push(`${template(command, positionals, { ...values, ...(project ? { project } : {}) })} --full`);
  return {
    ...(project ? { project } : {}), untrusted: true, count: rows.length,
    total: !data.has_more && !values.cursor ? rows.length : null,
    has_more: data.has_more, next_cursor: data.has_more ? data.next_cursor : null,
    ...(rows.length ? {} : { message: `0 ${command} found for this request.` }),
    [command]: rows.map(row => row.value), ...(next.length ? { help: next } : {}),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const helpCommand = argv[0] === 'setup' && ['hooks', 'remove'].includes(argv[1])
    ? `setup ${argv[1]}` : Object.hasOwn(definitions, argv[0]) ? argv[0] : 'projects';
  await runAxiCli({
    argv, description: DESCRIPTION,
    stdout: { write: text => process.stdout.write(redact(text)) },
    topLevelHelp: `${encode({ usage: 'telebugs-axi <command> [arguments] [flags]', commands: commandNames, guidance: GUIDE, examples: NEXT })}\n`,
    commands: Object.assign(Object.create(null), Object.fromEntries(commandNames.map(command => [command, args => dispatch(command, args)]))),
    home: async () => {
      const project = readProject(process.cwd());
      const result = await dispatch(project ? 'groups' : 'projects', project ? ['--project', String(project), '--query', 'is:unresolved', '--limit', '10'] : []);
      if (!project) result.help = [...(result.help ?? []), 'telebugs-axi setup hooks --project <id>'];
      return { ...result, guidance: GUIDE, examples: NEXT };
    },
    renderUnknownCommand: () => `${encode({ error: 'Unknown command.', code: 'VALIDATION_ERROR', help: commandNames.map(command => `telebugs-axi ${command} --help`) })}\n`,
    formatError: error => ({
      output: `${encode(redact(error instanceof AxiError ? { error: error.message, code: error.code, help: error.suggestions.length ? error.suggestions : [encode(commandHelp(helpCommand))] } : { error: 'Local operation or output failed. Check configuration, permissions, and response text for invalid Unicode.', code: 'LOCAL_ERROR' }))}\n`,
      exitCode: error instanceof AxiError && error.code === 'VALIDATION_ERROR' ? 2 : 1,
    }),
  });
}
