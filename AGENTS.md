# Project agent memory

- Start with `README.md` for supported commands, API references, authentication, and safety limits. Do not infer REST routes from MCP tool names.
- Run `npm test` and `npm run check`. Tests use synthetic data and local HTTP servers. Never test writes against live Telebugs data.
- `src/api.js` owns transport and redaction. `src/cli.js` owns command validation and documented endpoint mappings.
- Generate the on-demand skill with `npm run skill` after changing `src/guidance.js`. CI checks for drift.
- Hook setup is opt-in. Its Codex integration also changes user-level config. Tests must pass a sandbox `homeDir`; do not install hooks in a developer's home during tests.
- Keep credentials, report output, and local settings out of git. Package publication is disabled; no license has been selected.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
