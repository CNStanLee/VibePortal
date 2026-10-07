import fs from 'node:fs';
import path from 'node:path';

/**
 * A stand-in agent CLI written in Node, so it runs on every platform. On
 * Windows it gets a `.cmd` shim, the way npm installs `claude` and `codex`
 * there — the tests then go through the same cmd.exe route as the real CLIs.
 * `body` is CommonJS; `readAll(cb)` hands it all of stdin. Returns the path to run.
 */
export function fakeCli(dir: string, name: string, body: string): string {
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(script, `const fs = require('node:fs');\nconst readAll = (cb) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (s += d)).on('end', () => cb(s)); };\n${body}\n`);
  if (process.platform === 'win32') {
    const shim = path.join(dir, `${name}.cmd`);
    // %~dp0 (the shim's own folder), as npm's shims do: cmd reads a .cmd in the OEM code page, not UTF-8
    fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
    return shim;
  }
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  return bin;
}
