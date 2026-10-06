import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config';

/*
 * Web Push to the browsers that asked for it (phone Chrome, desktop Chrome…),
 * so a finished task reaches them even with VibePortal's page closed. The
 * browser vendor's push service delivers; we sign with our own VAPID key
 * (RFC 8292) and encrypt the payload for the browser (RFC 8291, aes128gcm).
 */

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface StoredSub extends PushSubscriptionJSON {
  /** the device, as the browser described itself */
  label?: string;
  createdAt: string;
}

interface PushFile {
  vapid: { publicKey: string; privateJwk: crypto.webcrypto.JsonWebKey };
  subs: StoredSub[];
}

export interface PushMessage {
  title: string;
  body: string;
  /** notifications with the same tag replace each other */
  tag?: string;
  taskId?: string;
  level?: string;
}

const MAX_SUBS = 20;
// a push service may hold a message this long for a phone that is offline
const TTL_SECONDS = 6 * 3600;
// Apple's push service wants a real contact here
const SUBJECT = 'https://github.com/CNStanLee/VibePortal';

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');
const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

export class WebPush {
  private data: PushFile;
  private privateKey: crypto.KeyObject;

  constructor(private file = path.join(dataDir(), 'push.json')) {
    this.data = this.load();
    this.privateKey = crypto.createPrivateKey({ key: this.data.vapid.privateJwk, format: 'jwk' });
  }

  /** The application server key browsers subscribe with (base64url, uncompressed P-256 point). */
  get publicKey() {
    return this.data.vapid.publicKey;
  }

  find(endpoint: string): PushSubscriptionJSON | undefined {
    return this.data.subs.find((s) => s.endpoint === endpoint);
  }

  get count() {
    return this.data.subs.length;
  }

  subscribe(sub: PushSubscriptionJSON, label?: string): string | undefined {
    const err = invalid(sub);
    if (err) return err;
    const rest = this.data.subs.filter((s) => s.endpoint !== sub.endpoint);
    const entry: StoredSub = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: label?.slice(0, 80), createdAt: new Date().toISOString() };
    this.data.subs = [...rest, entry].slice(-MAX_SUBS);
    this.save();
  }

  unsubscribe(endpoint: string) {
    const before = this.data.subs.length;
    this.data.subs = this.data.subs.filter((s) => s.endpoint !== endpoint);
    if (this.data.subs.length !== before) this.save();
  }

  /** Sends to every subscribed browser; the ones their push service has dropped are forgotten. */
  async broadcast(msg: PushMessage) {
    await Promise.all(this.data.subs.map((s) => this.send(s, msg).catch((e) => console.warn(`[push] ${host(s.endpoint)}: ${(e as Error).message}`))));
  }

  /** Sends to one subscribed browser (the "send a test" button); throws with the push service's reason. */
  async send(sub: PushSubscriptionJSON, msg: PushMessage) {
    const body = encrypt(Buffer.from(JSON.stringify(msg)), unb64u(sub.keys.p256dh), unb64u(sub.keys.auth));
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${this.jwt(new URL(sub.endpoint).origin)}, k=${this.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        Urgency: 'high',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 410) {
      this.unsubscribe(sub.endpoint);
      throw new Error('subscription expired — removed');
    }
    if (!res.ok) throw new Error(`push service answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  private jwt(audience: string) {
    const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${head}.${claims}.${b64u(sig)}`;
  }

  private load(): PushFile {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PushFile;
      if (d?.vapid?.publicKey && d.vapid.privateJwk) return { vapid: d.vapid, subs: Array.isArray(d.subs) ? d.subs.filter((s) => !invalid(s)) : [] };
    } catch {
      /* first run */
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)]);
    const d: PushFile = { vapid: { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) }, subs: [] };
    this.data = d;
    this.save();
    return d;
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}

function invalid(s: PushSubscriptionJSON | undefined): string | undefined {
  if (typeof s?.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return 'subscription needs endpoint and keys';
  let u: URL;
  try {
    u = new URL(s.endpoint);
  } catch {
    return 'bad endpoint';
  }
  // only a browser's push service, never something on this network
  if (u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(u.hostname)) return 'endpoint must be a public https push service';
  if (unb64u(s.keys.p256dh).length !== 65 || unb64u(s.keys.auth).length !== 16) return 'bad subscription keys';
}

const host = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.slice(0, 40);
  }
};

/** RFC 8291 message encryption: one aes128gcm record for the browser's key. */
export function encrypt(plain: Buffer, uaPublic: Buffer, authSecret: Buffer, salt = crypto.randomBytes(16)): Buffer {
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the last (and only) record, no padding
  const ct = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}
