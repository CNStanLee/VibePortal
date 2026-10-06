// Dev loop: rebuilds the server on change and restarts it, while Vite serves the UI
// with hot reload and proxies /api to the server.
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let child;
const restart = () => {
  child?.kill();
  child = spawn(process.execPath, ['dist/server/cli.cjs', '--port', '8787'], { stdio: 'inherit' });
};

const ctx = await context({
  entryPoints: ['src/server/cli.ts'],
  outfile: 'dist/server/cli.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  define: { __APP_VERSION__: JSON.stringify(pkg.version + '-dev') },
  plugins: [{ name: 'restart', setup: (b) => b.onEnd((r) => r.errors.length || restart()) }],
});
await ctx.watch();
spawn('npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' });
process.on('SIGINT', () => {
  child?.kill();
  process.exit(0);
});
