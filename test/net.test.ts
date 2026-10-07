import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchRetry } from '../src/core/collectors/net';

/** A server whose first `drop` connections are cut before any answer, then answers `status`. */
async function flaky(drop: number, status = 200) {
  let seen = 0;
  const server = http.createServer((req, res) => {
    if (seen++ < drop) return req.socket.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, calls: () => seen, close: () => server.close() };
}

test('plan-limit fetches ride out a dropped connection', async () => {
  const s = await flaky(2);
  try {
    const res = await fetchRetry(s.url, {}, { delays: [10] });
    assert.equal(res.status, 200);
    assert.equal(s.calls(), 3);
  } finally {
    s.close();
  }
});

test('an HTTP error is an answer: not retried', async () => {
  const s = await flaky(0, 401);
  try {
    assert.equal((await fetchRetry(s.url, {}, { delays: [10] })).status, 401);
    assert.equal(s.calls(), 1);
  } finally {
    s.close();
  }
});

test('when every try fails, the error names the cause instead of a bare "fetch failed"', async () => {
  const s = await flaky(99);
  try {
    await assert.rejects(fetchRetry(s.url, {}, { tries: 2, delays: [10] }), (e: Error) => /fetch failed \(\w+/.test(e.message));
    assert.equal(s.calls(), 2);
  } finally {
    s.close();
  }
});
