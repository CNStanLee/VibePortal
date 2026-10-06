// Bundles test/*.test.ts with esbuild (the sources use extensionless imports) and runs node:test.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const entries = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
await build({
  entryPoints: entries,
  outdir: 'dist/test',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: { __APP_VERSION__: '"test"' },
  logLevel: 'warning',
});
const files = fs.readdirSync('dist/test').filter((f) => f.endsWith('.cjs')).map((f) => `dist/test/${f}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
