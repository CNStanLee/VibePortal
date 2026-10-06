import { api, desktop } from './api';
import { isDemo } from './demo';

/*
 * Web Push for this browser: a service worker shows VibePortal's notices
 * (task finished, needs you…) even with the page closed — on a phone too.
 * Browsers only allow it on https (the public link) or on localhost.
 */

export type PushSupport = 'ok' | 'insecure' | 'ios-install' | 'unsupported';

export function pushSupport(): PushSupport {
  if (desktop() || isDemo()) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Safari on iPhone pushes only to a web app added to the home screen
  if (ios && !('PushManager' in window)) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'ok';
}

let reg: Promise<ServiceWorkerRegistration | undefined> | undefined;
/** Registers the service worker once (it lives next to index.html). */
export function swRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!reg) {
    reg =
      pushSupport() === 'ok'
        ? navigator.serviceWorker.register('./sw.js').catch((e) => {
            console.warn('service worker:', e);
            return undefined;
          })
        : Promise.resolve(undefined);
  }
  return reg;
}

async function current(): Promise<PushSubscription | null> {
  return (await (await swRegistration())?.pushManager.getSubscription()) ?? null;
}

const keyBytes = (b64u: string) => {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

const deviceLabel = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} · ${os}`;
};

/** Is this browser getting pushes from this VibePortal? */
export async function pushEnabled(): Promise<boolean> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return false;
  const sub = await current();
  return !!sub && (await api.push(sub.endpoint)).subscribed;
}

/** Asks for permission and subscribes this browser (call from a click). */
export async function enablePush(): Promise<void> {
  const r = await swRegistration();
  if (!r) throw new Error('service worker unavailable');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  const { publicKey } = await api.push();
  const key = keyBytes(publicKey);
  let sub = await r.pushManager.getSubscription();
  // subscribed to another server key (e.g. a reset ~/.vibeportal): start over
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushSubscribe(sub.toJSON(), deviceLabel());
}

export async function disablePush(): Promise<void> {
  const sub = await current();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

export async function testPush(body: string): Promise<void> {
  const sub = await current();
  if (!sub) throw new Error('not subscribed');
  await api.pushTest(sub.endpoint, body);
}

/**
 * At start-up: a browser that already has permission keeps its subscription
 * registered with this server (it may have been renewed, or the server reset).
 */
export async function syncPush(): Promise<void> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return;
  const sub = await current();
  if (!sub) return;
  const { publicKey, subscribed } = await api.push(sub.endpoint);
  if (!sameKey(sub.options.applicationServerKey, keyBytes(publicKey))) return enablePush();
  if (!subscribed) await api.pushSubscribe(sub.toJSON(), deviceLabel());
}

/** A notice while the page is open but in the background (no push subscription to bring it). */
export async function localNotice(n: { title: string; body: string; taskId?: string }) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  if (await pushEnabled().catch(() => false)) return; // the push brings it
  const r = await swRegistration();
  // phones can only show notifications through a service worker
  if (r) return r.showNotification(n.title, { body: n.body, icon: 'icon.png', tag: n.taskId ?? n.title });
  try {
    new Notification(n.title, { body: n.body, icon: './icon.png' });
  } catch {
    /* no constructor (Android) */
  }
}
