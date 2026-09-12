import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DESCRIPTION, NEXT, GUIDE } from '../src/guidance.js';

const path = new URL('../skills/telebugs-axi/SKILL.md', import.meta.url);
const content = `---
name: telebugs-axi
description: Use when asked to inspect Telebugs errors, search groups, read reports, or resolve, reopen, mute, or unmute an error group.
---

# Telebugs AXI

${DESCRIPTION}

Install this unpublished CLI from https://github.com/martin-ro/telebugs-axi into a local checkout with npm ci.
Run node /absolute/path/to/telebugs-axi/bin/telebugs-axi.js in place of telebugs-axi below. No global install is needed.

${GUIDE}
\`\`\`sh
${NEXT.join('\n')}
telebugs-axi resolve <group-id> --project <id> --confirm
telebugs-axi --help
\`\`\`
`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== content) {
    console.error('Skill is stale. Run npm run skill.');
    process.exitCode = 1;
  }
} else {
  mkdirSync(new URL('.', path), { recursive: true });
  writeFileSync(path, content);
}
