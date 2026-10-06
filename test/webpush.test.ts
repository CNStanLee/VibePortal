import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebPush, encrypt } from '../src/core/webpush';

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

/** What the browser does with an aes128gcm push message (RFC 8291 / 8188). */
function browserDecrypt(body: Buffer, ua: crypto.ECDH, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, -1);
}

test('a push payload decrypts with the browser keys', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = Buffer.from(JSON.stringify({ title: '✅ Train model', body: 'finished — what next?' }));
  const body = encrypt(msg, ua.getPublicKey(), auth);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.deepEqual(browserDecrypt(body, ua, auth), msg);
});

test('subscriptions are kept, validated and sent with a VAPID signature', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-push-')), 'push.json');
  const push = new WebPush(file);
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };

  assert.match(push.subscribe({ ...sub, endpoint: 'http://192.168.1.5/x' }) ?? '', /https/);
  assert.equal(push.subscribe(sub, 'Chrome · Android'), undefined);
  // the key and the subscription survive a restart
  const again = new WebPush(file);
  assert.equal(again.publicKey, push.publicKey);
  assert.ok(again.find(sub.endpoint));

  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response('', { status: seen.url.endsWith('gone') ? 410 : 201 });
  }) as typeof fetch;
  try {
    await again.send(sub, { title: 'hi', body: 'there' });
    const h = seen!.init.headers as Record<string, string>;
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization)!;
    assert.equal(k, push.publicKey);
    const [head, claims, sig] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).aud, 'https://fcm.googleapis.com');
    const raw = Buffer.from(push.publicKey, 'base64url');
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    assert.deepEqual(JSON.parse(browserDecrypt(Buffer.from(seen!.init.body as Uint8Array), ua, auth).toString()), { title: 'hi', body: 'there' });

    // a subscription the push service has dropped is forgotten
    const gone = { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/gone' };
    again.subscribe(gone);
    await assert.rejects(again.send(gone, { title: 'x', body: 'y' }), /expired/);
    assert.equal(again.find(gone.endpoint), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
