import path from 'node:path';
import { loadConfig } from '../core/config';
import { Monitor } from '../core/monitor';
import { startServer } from './server';
import { lanAddresses } from '../core/remote';

declare const __APP_VERSION__: string;

const HELP = `VibePortal web server

Usage: vibeportal-server [--host 127.0.0.1] [--port 8787] [--ui <dir>]

  --host   Interface to bind. Default follows the "remote access" setting
           (127.0.0.1, or 0.0.0.0 when enabled). Every request needs the API token.
  --port   Port (default from ~/.vibeportal/config.json, 8787).
  --ui     Directory with the built web UI (default: ../ui next to this file).
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig();
  const host = arg('host') ?? process.env.VIBEPORTAL_HOST;
  const port = Number(arg('port') ?? process.env.VIBEPORTAL_PORT ?? cfg.port);
  const uiDir = path.resolve(arg('ui') ?? path.join(__dirname, '..', 'ui'));

  const monitor = new Monitor(cfg);
  const srv = await startServer({ monitor, uiDir, host, port, mode: 'web', version: __APP_VERSION__ });
  const url = srv.url;
  monitor.start();
  monitor.on('notice', (n) => console.log(`[notice] ${n.title} — ${n.body}`));

  console.log(`VibePortal ${__APP_VERSION__} (web mode)`);
  console.log(`  Dashboard: ${url}/?token=${cfg.apiToken}`);
  if (host === '0.0.0.0' || (!host && cfg.remoteAccess)) {
    for (const ip of lanAddresses()) console.log(`  LAN:       http://${ip}:${srv.port}/?token=${cfg.apiToken}`);
    console.log('  Listening on all interfaces — share the token only with devices you trust.');
  }
  const stop = () => {
    monitor.stop();
    srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
