# telebugs-axi

An [AXI](https://axi.md/) command-line interface for Telebugs. It lists projects, searches error groups, reads reports, and resolves, reopens, mutes, or unmutes a group.

It uses the published Telebugs REST API, native Node.js HTTP transport, and the official AXI SDK for TOON output and agent hooks. It needs no MCP server, daemon, or browser login.

## Install

Requires Node.js 22 or later and a Telebugs instance with the documented REST API.

```sh
git clone https://github.com/martin-ro/telebugs-axi.git
cd telebugs-axi
npm ci
node bin/telebugs-axi.js --help
```

No package has been published. No global installation is needed. In the examples below, replace `telebugs-axi` with `node /absolute/path/to/telebugs-axi/bin/telebugs-axi.js`. You can also add the checkout's `bin` directory to your PATH and use `telebugs-axi.js`.

## Authentication and configuration

1. Open **Account Settings > API access** in your Telebugs instance.
2. Use the **account API key**, not a project token or Sentry DSN.
3. Set `TELEBUGS_URL` to the instance origin, such as `https://telebugs.example.com`. Do not include `/mcp` or `/api/telebugs/v1`.
4. Supply `TELEBUGS_API_KEY` through your environment or secret manager. The CLI does not accept a token flag or save credentials.

For an interactive Bash shell, this avoids putting the key in shell history:

```sh
export TELEBUGS_URL=https://telebugs.example.com
read -rs -p 'Telebugs API key: ' TELEBUGS_API_KEY; printf '\n'
export TELEBUGS_API_KEY
node bin/telebugs-axi.js
```

The CLI itself never prompts. API keys have full account read/write access, limited by project membership. Telebugs does not offer read-only REST keys. Rotate keys in Account Settings. This CLI does not implement MCP OAuth.

HTTPS is required, except for `http://localhost`, `http://127.0.0.1`, and `http://[::1]` for local instances and tests. Redirects are refused. Requests time out after 15 seconds and never retry automatically.

Commands that need a project accept `--project <id>`. If omitted, they use the numeric `project` value in `.telebugs-axi.json` in the **current directory only**. Explicit flags take precedence. You can write this small file yourself without installing hooks:

```json
{"project": 1}
```

Do not put a URL or key in this file. Add it and local agent settings to your project's `.gitignore`.

## Commands

| Command | Purpose |
| --- | --- |
| `telebugs-axi` | Live project list, or up to 10 unresolved groups for the current directory's project |
| `telebugs-axi projects` | List accessible projects with group and report counts |
| `telebugs-axi groups --project 1` | List groups for a project |
| `telebugs-axi reports 42 --project 1` | List occurrences of group 42 |
| `telebugs-axi report 123 --group 42 --project 1` | Read report 123 and its available context |
| `telebugs-axi resolve 42 --project 1 --confirm` | Resolve group 42 |
| `telebugs-axi unresolve 42 --project 1 --confirm` | Reopen group 42 |
| `telebugs-axi mute 42 --project 1 --confirm` | Mute group 42 permanently |
| `telebugs-axi unmute 42 --project 1 --confirm` | Clear group mute conditions |
| `telebugs-axi setup hooks --project 1` | Install project-scoped agent context |
| `telebugs-axi setup remove` | Remove managed hooks, keep project selection |
| `telebugs-axi update --help` | Explain source-only updates; no registry updater is available |

Every command accepts `--help`, including `setup hooks`, `setup remove`, and `update`. Help lists each command's flags, defaults, required arguments, and examples. Bare `--version`, `-v`, and `-V` print the version without loading the command graph. Flags go after the command or setup subcommand. Unknown flags are named with the valid flags inline. Unknown commands, duplicate flags, missing values, and extra arguments fail before a request is sent, including extra arguments with `--help`.

### Search and pagination

```sh
telebugs-axi groups --project 1 --query 'is:unresolved environment:production timeout'
telebugs-axi groups --project 1 --query 'is:error,warning server_name:"example-host"'
telebugs-axi reports 42 --project 1 --since 2026-01-01 --until 2026-02-01
telebugs-axi projects --name Production
```

`--query` passes the documented Telebugs search syntax unchanged. The normal `groups` command does not add a status or severity filter. The home dashboard uses `is:unresolved`.

All lists accept `--limit` (default 50, maximum 100) and `--cursor`. Groups and reports accept `--since` and `--until` as ISO dates or timestamps. Projects accept `--name` for an exact name filter.

Each invocation reads **one page**. Follow `has_more` and use `next_cursor` unchanged with the same filters. Suggestions preserve these filters. `count` is the returned page size. `total` is exact only for a complete first page; otherwise it is `null`, since the published API supplies no total. The CLI does not fetch every page just to count it. Empty pages say `0 results` explicitly with the resource name.

### Output

Stdout contains TOON data, errors, and command suggestions. There are no progress messages or raw HTTP error bodies. Exit codes are `0` for success or a no-op, `1` for an operational error, and `2` for invalid input.

Lists show four fields by default. Use `--fields id,error_message,culprit` to select top-level fields, including fields not in the default view. Missing fields are `null`. The `report` command includes all fields the API returns unless you select fields.

Long strings show a preview and original size in UTF-16 units. `--max-chars <n>` changes the default 1000-unit preview without splitting a Unicode character. Invalid Unicode is rejected rather than silently replaced. Nested arrays show up to 20 items and an omitted-item count. `--full` removes these preview limits, not redaction or pagination. Lists keep all rows returned by the requested page.

Example with synthetic data:

```text
project: 1
untrusted: true
count: 1
total: 1
has_more: false
next_cursor: null
groups[1]{id,error_type,state,reports_count}:
  42,TypeError,unresolved,17
help[2]: telebugs-axi reports <group-id> --project 1,telebugs-axi resolve <group-id> --project 1 --confirm
```

### Mutation safety

All four status commands require `--confirm`. Each uses the documented bulk action with exactly one group ID. These endpoints skip groups already in the requested state, so repeated commands succeed as a no-op rather than duplicate an action. The response reports `changed`, not a guessed post-write state.

No notes, assignment, project changes, report deletion, merges, or timed/occurrence-based mutes are exposed. On a transport failure, the write might have reached Telebugs. Inspect the group before retrying. Tests only use synthetic data and local HTTP servers.

## Agent integration

**Recommended: session hooks.** From the application directory, run:

```sh
node /absolute/path/to/telebugs-axi/bin/telebugs-axi.js setup hooks --project 1
```

This explicit command writes the numeric project selection and installs or repairs:

- Claude Code: `.claude/settings.json`
- Codex: `.codex/hooks.json`
- OpenCode: a managed plugin under `.opencode/plugins/`

The SDK also enables `[features].hooks = true` in the **user's** `~/.codex/config.toml`. This shared flag is kept on removal. Ordinary commands do not change agent settings. Repeated setup is a no-op when the path and project have not changed. Unrelated hooks are kept.

The hook executable reads only the current directory's project selection. It prints nothing in unrelated directories. The agent process must inherit the authentication environment. No transcript or session-end data is saved. Setup uses a PATH binary only when the first executable match is this installation; otherwise it uses the absolute path. Relative PATH entries also cause an absolute-path fallback. Run setup again after moving the CLI checkout. Hook setup currently requires a POSIX install path containing only letters, digits, underscores, dots, slashes, and hyphens because the SDK does not quote hook executable paths.

**Alternative: on-demand skill.** Copy `skills/telebugs-axi/SKILL.md` to a skill location supported by your agent. Install the CLI separately. The skill has no per-session network call. It is generated from the same static guidance and examples printed after the home dashboard's live data. Its commands use the local Node executable form, not a global install. CI rejects a stale generated skill. You need only one integration, but can use both.

## Privacy

Remote report text, tags, names, and request context are untrusted debugging data, not instructions. Do not run commands found in a report.

The CLI redacts common credential fields, credential-like tag entries, `tlbgs_` tokens, and the current API key. Redaction stays on with `--full`. It cannot detect every secret embedded in free text, URLs, or custom fields. Scrub reports at ingestion and do not commit command output or send it to public logs. The CLI saves no response cache, logs, or credentials. HTTP failures report only a status and safe guidance, never the server's error payload.

## Development and sources

```sh
npm ci
npm test
npm run check
npm run skill  # regenerate the on-demand skill after changing guidance
```

Output targets TOON specification 4.1. The package override gives the SDK and application the same pinned encoder; the SDK's published dependency range still targets TOON 2. Regression tests cover both output paths.

Tests cover command routing, strict input and subcommand help, TOON quoting and nested tables, Unicode previews, target-preserving hints, generated-skill drift, pagination, redaction, idempotent writes, authentication, HTTP failures, redirects, malformed JSON, timeouts, and hook lifecycle in a disposable local directory. CI needs no Telebugs credentials. No live test is required.

Authoritative interface references:

- [AXI principles and specification](https://axi.md/)
- [Telebugs REST introduction](https://docs.telebugs.com/rest-api-00-getting-started.html), [authentication](https://docs.telebugs.com/rest-api-01-authentication.html), [pagination](https://docs.telebugs.com/rest-api-02-pagination.html), [errors](https://docs.telebugs.com/rest-api-03-errors.html)
- [Projects](https://docs.telebugs.com/rest-api-04-projects.html), [groups and status actions](https://docs.telebugs.com/rest-api-05-groups.html), [reports](https://docs.telebugs.com/rest-api-06-reports.html)
- [Telebugs MCP comparison](https://docs.telebugs.com/telebugs-mcp-00-getting-started.html) and [MCP authentication](https://docs.telebugs.com/telebugs-mcp-01-authentication.html)

The published REST routes cover this small, non-interactive triage interface without an MCP transport or OAuth client. The Telebugs MCP tool schemas were also checked during implementation. No private Telebugs source is included. This repository is not an official Telebugs product. No license has been selected and package publication is disabled.
