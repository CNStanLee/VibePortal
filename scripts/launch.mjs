// Starts Electron with ELECTRON_RUN_AS_NODE cleared — terminals inside VS Code (itself an
// Electron app) export it, which would make Electron run as plain Node.
// Usage: node scripts/launch.mjs [entry] [...args]   (entry defaults to "." = the app)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
cleanSnapEnv(env);
const args = process.argv.slice(2);
const child = spawn(electron, args.length ? args : ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));

/**
 * Terminals of the snap build of VS Code export the snap's own GTK / GIO / locale
 * paths; Electron then loads snap libraries against the system libstdc++ and logs
 * "Failed to load module …gio-modules…" and similar. VS Code keeps the originals
 * in *_VSCODE_SNAP_ORIG: put those back and drop the snap-only paths.
 */
function cleanSnapEnv(e) {
  if (!e.SNAP) return;
  for (const [k, v] of Object.entries(e)) {
    if (k.endsWith('_VSCODE_SNAP_ORIG')) {
      const name = k.slice(0, -'_VSCODE_SNAP_ORIG'.length);
      if (v) e[name] = v;
      else delete e[name];
      delete e[k];
    }
  }
  const snapOnly = ['GIO_MODULE_DIR', 'GTK_PATH', 'GTK_EXE_PREFIX', 'GTK_IM_MODULE_FILE', 'GDK_PIXBUF_MODULE_FILE', 'GDK_PIXBUF_MODULEDIR', 'LOCPATH', 'GSETTINGS_SCHEMA_DIR'];
  for (const k of snapOnly) if (e[k] && /\/snap\//.test(e[k])) delete e[k];
  for (const k of Object.keys(e)) if (k.startsWith('SNAP')) delete e[k];
}
