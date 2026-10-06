// The permission-prompt tool of VibePortal's background Claude runs: a tiny MCP
// server (stdio, JSON-RPC) with one tool. Claude calls it whenever something
// would need approval; it asks VibePortal (which shows Allow / Deny in the UI,
// also on the phone) and returns the answer. Started by `claude` itself through
// --mcp-config; settings come from the environment:
//   VP_URL (http://127.0.0.1:<port>), VP_TOKEN (the API token), VP_JOB (job id)
import http from 'node:http';

const url = process.env.VP_URL ?? 'http://127.0.0.1:8787';
const token = process.env.VP_TOKEN ?? '';
const job = process.env.VP_JOB ?? '';

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any };

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

type Answer = { behavior: 'allow' | 'deny'; message?: string };

/** Asks; when VibePortal is restarting (connection refused / dropped), asks again once it is back. */
async function ask(tool: string, input: unknown): Promise<Answer> {
  const until = Date.now() + 3 * 60_000;
  for (;;) {
    const a = await askOnce(tool, input);
    if (a !== 'unreachable') return a;
    if (Date.now() > until) return { behavior: 'deny', message: 'VibePortal is not reachable, so nobody could approve this.' };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** POST /api/permissions/request and wait (long poll) for the decision. */
function askOnce(tool: string, input: unknown): Promise<Answer | 'unreachable'> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ job, tool_name: tool, input });
    const req = http.request(
      new URL('api/permissions/request', url.endsWith('/') ? url : url + '/'),
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) }, timeout: 20 * 60_000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const d = JSON.parse(data);
            resolve(d.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: d.message ?? d.error ?? 'Denied in VibePortal.' });
          } catch {
            resolve({ behavior: 'deny', message: 'VibePortal did not answer.' });
          }
        });
      },
    );
    let timedOut = false;
    req.on('error', () => resolve(timedOut ? { behavior: 'deny', message: 'Nobody answered in time.' } : 'unreachable'));
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
    });
    req.end(body);
  });
}

async function handle(m: Rpc) {
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vibeportal', version: '1' } } });
    case 'tools/list':
      return send({
        id: m.id,
        result: {
          tools: [
            {
              name: 'approve',
              description: 'Asks the VibePortal user to allow or deny a tool call.',
              inputSchema: {
                type: 'object',
                properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
                required: ['tool_name', 'input'],
              },
            },
          ],
        },
      });
    case 'tools/call': {
      const args = m.params?.arguments ?? {};
      const d = await ask(String(args.tool_name ?? ''), args.input ?? {});
      const result = d.behavior === 'allow' ? { behavior: 'allow', updatedInput: args.input ?? {} } : { behavior: 'deny', message: d.message };
      return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    }
    case 'ping':
      return send({ id: m.id, result: {} });
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => {
  buf += d;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* not JSON */
    }
  }
});
process.stdin.on('end', () => process.exit(0));
