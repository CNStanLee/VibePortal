// Google sign-in (Google Identity Services) and the device list kept in the
// user's own Google Drive app-data folder — private to this app, invisible in
// Drive, and the only "registry" there is: VibePortal has no server of its own.

declare global {
  interface Window {
    google?: any;
  }
}

let gis: Promise<void> | undefined;

/** Loads https://accounts.google.com/gsi/client once. */
export function loadGis(): Promise<void> {
  gis ??= new Promise((resolve, reject) => {
    if (window.google?.accounts) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gis = undefined;
      reject(new Error('could not load Google sign-in (offline, or blocked by the network)'));
    };
    document.head.appendChild(s);
  });
  return gis;
}

/** Renders the "Sign in with Google" button; `onCredential` gets the ID token. */
export async function renderGoogleButton(el: HTMLElement, clientId: string, onCredential: (credential: string) => void, opts: { autoSelect?: boolean; lang?: string } = {}) {
  await loadGis();
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (r: { credential: string }) => onCredential(r.credential),
    // signed in on one device → the next one signs in by itself
    auto_select: opts.autoSelect ?? true,
    cancel_on_tap_outside: false,
    use_fedcm_for_prompt: true,
  });
  window.google.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: opts.lang === 'zh' ? 'zh_CN' : 'en' });
  if (opts.autoSelect !== false) window.google.accounts.id.prompt();
}

// ── device registry in Drive appDataFolder ─────────────────────────────────

export interface Device {
  id: string;
  name: string;
  url: string;
  updatedAt: string;
}

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE = 'vibeportal-devices.json';
let token: { value: string; until: number } | undefined;

/** An access token for the app-data folder (a Google pop-up the first time). Needs a user gesture. */
function driveToken(clientId: string, hint?: string): Promise<string> {
  if (token && token.until > Date.now() + 60_000) return Promise.resolve(token.value);
  return loadGis().then(
    () =>
      new Promise<string>((resolve, reject) => {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          hint,
          callback: (r: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => {
            if (!r.access_token) return reject(new Error(r.error_description || r.error || 'Google did not grant access'));
            token = { value: r.access_token, until: Date.now() + (r.expires_in ?? 3600) * 1000 };
            resolve(r.access_token);
          },
          error_callback: (e: { message?: string; type?: string }) => reject(new Error(e.message || e.type || 'Google sign-in was closed')),
        });
        client.requestAccessToken({ prompt: '' });
      }),
  );
}

async function drive(path: string, init: RequestInit, tk: string) {
  const res = await fetch(`https://www.googleapis.com${path}`, { ...init, headers: { Authorization: `Bearer ${tk}`, ...(init.headers ?? {}) } });
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message ?? 'forbidden';
    throw new Error(/has not been used|disabled/i.test(msg) ? 'Turn on the Google Drive API for your Google Cloud project (see the setup steps)' : msg);
  }
  if (!res.ok) throw new Error(`Google Drive: HTTP ${res.status}`);
  return res;
}

/**
 * Adds / refreshes `me` in the account's device list and returns the whole list.
 * Read–merge–write, so devices registering at the same time don't drop each other.
 */
export async function syncDevices(clientId: string, me: Device, hint?: string): Promise<Device[]> {
  const tk = await driveToken(clientId, hint);
  const q = encodeURIComponent(`name='${FILE}'`);
  const list = await (await drive(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`, {}, tk)).json();
  const id: string | undefined = list.files?.[0]?.id;
  let devices: Device[] = [];
  if (id) {
    try {
      devices = (await (await drive(`/drive/v3/files/${id}?alt=media`, {}, tk)).json()).devices ?? [];
    } catch {
      devices = [];
    }
  }
  const merged = [me, ...devices.filter((d) => d.id !== me.id)].slice(0, 50);
  const body = JSON.stringify({ devices: merged }, null, 1);
  if (id) {
    await drive(`/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }, tk);
  } else {
    const boundary = 'vp' + Math.random().toString(36).slice(2);
    const multipart = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name: FILE, parents: ['appDataFolder'] }),
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      body,
      `--${boundary}--`,
    ].join('\r\n');
    await drive('/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart }, tk);
  }
  return merged;
}

/** Removes a device from the list (e.g. one you no longer use). */
export async function forgetDevice(clientId: string, deviceId: string, me: Device): Promise<Device[]> {
  const all = await syncDevices(clientId, me);
  const kept = all.filter((d) => d.id !== deviceId);
  const tk = await driveToken(clientId);
  const q = encodeURIComponent(`name='${FILE}'`);
  const id = (await (await drive(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`, {}, tk)).json()).files?.[0]?.id;
  if (id) await drive(`/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devices: kept }, null, 1) }, tk);
  return kept;
}

/** Is that VibePortal reachable right now? (its /api/health answers cross-origin) */
export async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(new URL('api/health', url.endsWith('/') ? url : url + '/'), { signal: AbortSignal.timeout(5000), headers: { 'ngrok-skip-browser-warning': '1' } });
    return r.ok && (await r.json()).app === 'vibeportal';
  } catch {
    return false;
  }
}
