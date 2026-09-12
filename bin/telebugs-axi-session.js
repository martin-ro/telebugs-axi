#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// No account-wide dashboard in unrelated directories. No transcript capture.
if (existsSync(resolve('.telebugs-axi.json'))) {
  const { main } = await import('../src/cli.js');
  await main([]);
}
