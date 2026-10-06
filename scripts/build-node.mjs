// Bundles the Node side (web server CLI + Electron main/preload) into CommonJS.
import { build, context } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  external: ['electron'],
};

const targets = [
  { ...common, entryPoints: ['src/server/cli.ts'], outfile: 'dist/server/cli.cjs', banner: { js: '#!/usr/bin/env node' } },
  { ...common, entryPoints: ['src/electron/main.ts'], outfile: 'dist/electron/main.cjs' },
  { ...common, entryPoints: ['src/electron/preload.ts'], outfile: 'dist/electron/preload.cjs', sourcemap: false },
];

if (watch) {
  for (const t of targets) await (await context(t)).watch();
} else {
  await Promise.all(targets.map((t) => build(t)));
}
