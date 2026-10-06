// Renders the README screenshots from demo mode (made-up data, no server).
// Usage: npm run screenshots   (builds the UI first; writes docs/images/*.png)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ui = 'file://' + path.join(root, 'dist/ui/index.html');
const out = path.join(root, 'docs/images');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
// each shot closes its window: don't let that end the run
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  process.on('unhandledRejection', (e) => {
    console.error(e);
    app.exit(1);
  });
  fs.mkdirSync(out, { recursive: true });
  // language / theme live in localStorage, shared by all windows: set them in a throwaway window
  let prepared = '';
  const prepare = async (lang, theme) => {
    if (prepared === lang + theme) return;
    const p = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await p.loadURL(`${ui}?demo`);
    await p.webContents.executeJavaScript(`localStorage.setItem('vp.lang','${lang}'); localStorage.setItem('vp.theme','${theme}'); localStorage.removeItem('vp.petPos2'); 1`);
    p.destroy();
    prepared = lang + theme;
  };
  const shoot = async ({ name, hash = '', width = 1440, height = 900, lang = 'en', theme, js, wait: after = 1200, clip, bg }) => {
    const w = new BrowserWindow({ width, height, show: false, webPreferences: { offscreen: true } });
    // file:// loads right after another navigation are occasionally aborted: retry
    const load = async (u) => {
      for (let i = 0; ; i++) {
        try {
          return await w.loadURL(u);
        } catch (e) {
          if (i >= 4) throw e;
          await wait(300);
        }
      }
    };
    await prepare(lang, theme ?? 'light');
    await load(`${ui}?demo#${hash}`);
    w.webContents.setZoomFactor(1);
    await wait(1500);
    if (bg) await w.webContents.executeJavaScript(`document.documentElement.style.background=document.body.style.background='${bg}'; 1`);
    // the dashboard shots show the page; the pets get a picture of their own
    if (!hash.startsWith('/pet') && !hash.startsWith('/gallery')) {
      await w.webContents.insertCSS('.pet-floating { display: none !important; }');
      await wait(600); // offscreen capture returns the last painted frame: let it repaint
    }
    if (js) {
      await w.webContents.executeJavaScript(js);
      await wait(after);
    }
    const rect = clip ? await w.webContents.executeJavaScript(clip) : undefined;
    const img = await w.webContents.capturePage(rect);
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    console.log('wrote', name);
    w.destroy();
  };
  const expandFirstTask = `document.querySelector('.task.expandable .task-main')?.click(); 1`;
  // bounding box of an element (+ margin), for cropped shots
  const box = (sel, m = 16) =>
    `(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left - ${m})), y: Math.max(0, Math.floor(r.top - ${m})), width: Math.ceil(r.width + ${2 * m}), height: Math.ceil(r.height + ${2 * m}) }; })()`;

  for (const lang of ['en', 'zh']) {
    const sfx = lang === 'en' ? '' : '-zh';
    await shoot({ name: `tasks${sfx}`, lang, js: expandFirstTask });
    await shoot({ name: `overview${sfx}`, hash: '/overview', lang });
    await shoot({ name: `resources${sfx}`, hash: '/resources', lang, theme: 'dark' });
    // the farm down to the showcase (the farmer profile below is a form)
    await shoot({ name: `farm${sfx}`, hash: '/farm', lang, height: 1500, clip: `(() => { const r = document.querySelectorAll('.farm > section')[2].getBoundingClientRect(); return { x: 0, y: 0, width: 1440, height: Math.ceil(r.bottom + 16) }; })()` });
    // a ten-draw on the reel, just after the last row stopped
    await shoot({ name: `farm-spin${sfx}`, hash: '/farm', lang, width: 760, height: 900, js: `document.querySelector('.farm-ten').click(); 1`, wait: 6300, clip: box('.modal', 0) });
    // the share card, as it goes out on LinkedIn / X / a README
    await shoot({ name: `farm-card${sfx}`, hash: '/farm', lang, js: `document.querySelector('.social-card-preview').scrollIntoView({ block: 'center' }); 1`, wait: 900, clip: box('.social-card-preview svg', 0) });
    // the pet stage on its own, as it floats on the desktop
    await shoot({ name: `pets${sfx}`, hash: '/pet', lang, width: 1100, height: 520, bg: '#e9e4dc', clip: box('.pet-stage', 20) });
    for (const [n, h] of [
      ['m-tasks', ''],
      ['m-overview', '/overview'],
      ['m-settings', '/settings'],
    ]) {
      await shoot({
        name: `${n}${sfx}`,
        hash: h,
        lang,
        width: 390,
        height: 844,
        js: n === 'm-settings' ? `[...document.querySelectorAll('h3')].find(h=>/Access from|公网/.test(h.textContent))?.scrollIntoView(); window.scrollBy(0,-60); 1` : n === 'm-tasks' ? expandFirstTask : undefined,
      });
    }
  }
  // the crab's little scenes, from the gallery
  await shoot({ name: 'scenes', hash: '/gallery', width: 1200, height: 900, clip: `(() => { const g = document.querySelectorAll('.gallery')[1].getBoundingClientRect(); return { x: 0, y: Math.floor(g.top), width: 1200, height: Math.ceil(g.height) }; })()` });
  app.quit();
});
