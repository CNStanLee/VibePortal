import crypto from 'node:crypto';
import type http from 'node:http';
import { hasRemoteAuth, type Config } from '../core/config';

/*
 * Who may call the API:
 *  - this machine (loopback, not forwarded): the API token, or a login session
 *  - the internet (anything that came through a tunnel / reverse proxy): a
 *    password login session only — the API token is never accepted there
 *  - the LAN: without a password, the API token (as before); with a password,
 *    a login session, or the token in an Authorization header (machine-to-
 *    machine, e.g. another VibePortal aggregating this one) — never in a link
 */

const SESSION_DAYS = 30;

/** Requests that came in on the tunnel's own port carry this mark. */
export const VIA_TUNNEL = Symbol('viaTunnel');

/**
 * A request that arrived through a proxy or tunnel. Tunnels connect to a port
 * of their own, so their traffic is marked regardless of headers — an SSH
 * relay delivers from 127.0.0.1 and need not add X-Forwarded-For.
 */
export function isForwarded(req: http.IncomingMessage): boolean {
  if ((req as unknown as Record<symbol, boolean>)[VIA_TUNNEL]) return true;
  const h = req.headers;
  return !!(h['cf-connecting-ip'] || h['x-forwarded-for'] || h['forwarded'] || h['x-real-ip']);
}

export function isLocalRequest(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loopback && !isForwarded(req);
}

/** The caller's address, for rate limiting (the tunnel tells us the real one). */
export function clientIp(req: http.IncomingMessage): string {
  const h = req.headers;
  const fwd = (h['cf-connecting-ip'] as string) || (h['x-forwarded-for'] as string)?.split(',')[0];
  return (fwd || req.socket.remoteAddress || '?').trim();
}

/** Which login the UI should offer this caller. */
export function authMode(req: http.IncomingMessage, cfg: Config): 'password' | 'token' {
  if (isLocalRequest(req)) return 'token';
  return hasRemoteAuth(cfg) || isForwarded(req) ? 'password' : 'token';
}

export function issueSession(cfg: Config): { token: string; expiresAt: string } {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const body = `s1.${exp}.${crypto.randomBytes(12).toString('base64url')}`;
  return { token: `${body}.${sign(cfg, body)}`, expiresAt: new Date(exp).toISOString() };
}

export function validSession(cfg: Config, token: string): boolean {
  if (!hasRemoteAuth(cfg) || !token.startsWith('s1.')) return false;
  const i = token.lastIndexOf('.');
  const body = token.slice(0, i);
  const exp = Number(body.split('.')[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return safeEqual(token.slice(i + 1), sign(cfg, body));
}

function sign(cfg: Config, body: string): string {
  return crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function authorized(req: http.IncomingMessage, url: URL, cfg: Config): boolean {
  const header = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  const given = header ?? url.searchParams.get('token') ?? '';
  if (validSession(cfg, given)) return true;
  if (isLocalRequest(req)) return safeEqual(given, cfg.apiToken);
  if (isForwarded(req)) return false;
  if (hasRemoteAuth(cfg)) return !!header && safeEqual(header, cfg.apiToken);
  return safeEqual(given, cfg.apiToken);
}

/**
 * Slows down password guessing: per address, 5 free attempts, then a lockout
 * that doubles (30 s … 15 min); plus a global cap against spread-out attacks.
 */
export class LoginLimiter {
  private byIp = new Map<string, { fails: number; until: number }>();
  private recent: number[] = [];

  /** ms to wait before another attempt is allowed (0 = go ahead). */
  wait(ip: string): number {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= 30) return 60_000;
    return Math.max(0, (this.byIp.get(ip)?.until ?? 0) - now);
  }

  fail(ip: string) {
    const now = Date.now();
    this.recent.push(now);
    const e = this.byIp.get(ip) ?? { fails: 0, until: 0 };
    e.fails++;
    if (e.fails >= 5) e.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (e.fails - 5));
    this.byIp.set(ip, e);
    if (this.byIp.size > 5000) this.byIp.delete(this.byIp.keys().next().value!);
  }

  success(ip: string) {
    this.byIp.delete(ip);
  }
}

// ── Google sign-in ───────────────────────────────────────────────────────────
// The browser gets an ID token from Google Identity Services; we check its RS256
// signature against Google's published keys, the audience (the user's own OAuth
// client id), issuer, expiry and that the e-mail is verified. No client secret.

let jwks: { at: number; maxAge: number; keys: Record<string, unknown>[] } | undefined;

async function googleKeys(force = false): Promise<Record<string, unknown>[]> {
  if (!force && jwks && Date.now() - jwks.at < jwks.maxAge) return jwks.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw Object.assign(new Error(`could not fetch Google's signing keys (HTTP ${res.status})`), { status: 502 });
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600) * 1000;
  jwks = { at: Date.now(), maxAge, keys: ((await res.json()) as { keys: Record<string, unknown>[] }).keys };
  return jwks.keys;
}

export async function verifyGoogleIdToken(credential: string, clientId: string, keys?: Record<string, unknown>[]): Promise<string> {
  const bad = (m: string) => Object.assign(new Error(m), { status: 401 });
  const parts = String(credential).split('.');
  if (parts.length !== 3) throw bad('not a Google ID token');
  const [h, p, sig] = parts;
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw bad('malformed ID token');
  }
  if (header.alg !== 'RS256') throw bad('unexpected token algorithm');
  let set = keys ?? (await googleKeys());
  let jwk = set.find((k) => k.kid === header.kid);
  if (!jwk && !keys) jwk = (set = await googleKeys(true)).find((k) => k.kid === header.kid); // keys rotated
  if (!jwk) throw bad('unknown signing key');
  const key = crypto.createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) throw bad('bad signature');
  const now = Date.now() / 1000;
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') throw bad('wrong issuer');
  if (claims.aud !== clientId) throw bad('token was issued for another app');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw bad('token expired');
  if (typeof claims.iat === 'number' && claims.iat > now + 300) throw bad('token from the future');
  if (claims.email_verified !== true || typeof claims.email !== 'string') throw bad('the Google account has no verified e-mail');
  return claims.email.toLowerCase();
}
