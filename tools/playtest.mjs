/**
 * Headless playtest harness for UFO Invasion II. Drives the real game in Chrome through the
 * `window.__ufo` hook that main.js installs when the URL has ?debug.
 *
 *   node tools/playtest.mjs smoke [--seconds 25] [--level 0] [--gpu] [--headed]
 *       load, start a run, simulate N seconds with a bot that shoots the nearest enemy,
 *       save tools/shots/smoke-*.png, report JS errors and counts.
 *   node tools/playtest.mjs shot <name> [--gpu]          title screen screenshot
 *   node tools/playtest.mjs enemies [--gpu]               spawn one of every enemy type in a ring and screenshot
 *   node tools/playtest.mjs probe --js "return __ufo.counts()" [--gpu]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      // Without an 'error' listener a failed read throws out of the server. Windows hits
      // EMFILE/EBUSY when the page pulls several large GLBs at once, which is what produced the
      // random "[requestfailed] <some enemy>.glb" lines in bot runs.
      const stream = fs.createReadStream(file);
      stream.on('error', () => { res.destroy(); });
      stream.pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function findBrowser() {
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']) if (fs.existsSync(p)) return p;
  throw new Error('No Chrome/Edge found');
}
const args = process.argv.slice(2);
const mode = args[0] || 'smoke';
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);

async function open() {
  const { srv, port } = await serve();
  const browser = await puppeteer.launch({
    executablePath: findBrowser(), headless: !flag('headed'), protocolTimeout: 600000,
    args: [...(flag('gpu') ? ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--headless=new'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']),
      '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', '--mute-audio'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning') { if (!/404|favicon|Autoplay|AudioContext/.test(t)) errors.push('[console.' + m.type() + '] ' + t); } else logs.push(t); });
  page.on('requestfailed', r => { if (!/favicon/.test(r.url())) errors.push('[requestfailed] ' + r.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, '')); });
  await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  await page.waitForFunction(() => window.__ufo && document.getElementById('loading').style.display === 'none', { timeout: 300000 });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { browser, page, srv, errors, logs };
}
async function shot(page, name) { const p = path.join(SHOTS, name + '.png'); await page.screenshot({ path: p }); console.log('saved', path.relative(ROOT, p)); }

// Simple bot: look at nearest live enemy, fire, strafe a little.
const BOT = `async (seconds) => {
  const u = window.__ufo; const dt = 1/60; let n = Math.round(seconds/dt); let t = 0; let i = 0;
  const log = [];
  let lastWave = -1;
  while (n-- > 0) {
    t += dt; i++;
    if (u.state() !== 'playing') break;
    if (document.getElementById('perk-select') && document.getElementById('perk-select').style.display === 'flex') u.pickPerk();
    const sc = u.three.scene; const cam = u.three.camera;
    let best = null, bd = 1e9;
    sc.traverse(o => { const e = o.userData && o.userData.enemy; if (e && !e.dead && e.ready) { const d = o.position.distanceTo(cam.position); if (d < bd) { bd = d; best = e; } } });
    if (best) {
      u.lookAt(best.mesh.position.x, best.mesh.position.y + best.data.height * 0.6, best.mesh.position.z);
      // weapon choice: rockets for tanks/boss, plasma for shielded, rifle otherwise; sword when close
      const want = (best.type === 'juggernaut' || best.isBoss) ? 3 : (best.shield > 0 ? 1 : (bd < 6 ? 2 : 0));
      if (u.weapons.current !== ['rifle','plasmaRifle','energySword','rocketLauncher'][want]) u.selectWeapon(want);
      u.fire();
      if (u.weapons.st.mag === 0) u.weapons.reload();
      // strafe a bit so shots do not all land
      const c = u.controls; c.moveLeft = Math.floor(t) % 4 < 2; c.moveRight = !c.moveLeft; c.moveForward = bd > 14; c.moveBackward = bd < 4;
    }
    u.step(dt);
    const cnt = u.counts();
    if (cnt.wave !== lastWave) { lastWave = cnt.wave; log.push('t=' + t.toFixed(0) + 's wave ' + cnt.wave + ' hp ' + Math.round(cnt.hp) + ' score ' + cnt.score); }
    if (cnt.hp <= 0) { log.push('DIED at t=' + t.toFixed(0) + 's wave ' + cnt.wave); break; }
    // Yield every 0.5 s of sim so asset loads and other promises can resolve.
    if (i % 30 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const c = u.counts(); c.log = log; return c;
}`;

const { browser, page, srv, errors, logs } = await open();
try {
  if (mode === 'shot') { await page.waitForTimeout ? await page.waitForTimeout(800) : await new Promise(r => setTimeout(r, 800)); await shot(page, args[1] || 'title'); }
  else if (mode === 'probe') { const js = opt('js', 'return __ufo.counts()'); const r = await page.evaluate(new Function(js)); console.log(JSON.stringify(r, null, 1)); if (opt('shot', null)) { await page.evaluate(() => window.__ufo.render()); await shot(page, opt('shot')); } }
  else if (mode === 'tour') {
    // node tools/playtest.mjs tour --level N --tag name --at "x,z,lx,lz;x,z,lx,lz" [--eye 1.7] [--gpu]
    const level = parseInt(opt('level', '0')); const tag = opt('tag', 'tour'); const eye = parseFloat(opt('eye', '1.7'));
    const spots = opt('at', '0,8,0,-30').split(';').map(s => s.split(',').map(Number));
    await page.evaluate(async (lv) => { await window.__ufo.startRun(lv); }, level);
    await new Promise(r => setTimeout(r, 5000));
    await page.evaluate(() => { const u = window.__ufo; u.setInvulnerable(true); u.waves.cleanup(); u.waves.state = 'active'; u.waves.activeTime = -1e9; document.getElementById('wave-announce').style.display = 'none'; });
    for (let i = 0; i < spots.length; i++) {
      const [x, z, lx, lz] = spots[i];
      await page.evaluate((x, z, lx, lz, eye) => { const u = window.__ufo; u.teleport(x, z); u.three.camera.position.y = eye; u.lookAt(lx, eye - 0.3, lz); u.step(0.05); document.getElementById('wave-announce').style.display = 'none'; u.render(); }, x, z, lx, lz, eye);
      await new Promise(r => setTimeout(r, 300));
      await shot(page, `${tag}-${i + 1}`);
    }
  }
  else if (mode === 'enemies') {
    await page.evaluate(async () => { await window.__ufo.startRun(0); });
    await new Promise(r => setTimeout(r, 4000));
    await page.evaluate(() => { const u = window.__ufo; u.setInvulnerable(true); const types = ['gnat', 'skirmisher', 'warlord', 'juggernaut', 'wasp', 'overseer']; types.forEach((t, i) => { const a = (i / types.length) * Math.PI * 2; u.spawn(t, Math.cos(a) * 9, 8 + Math.sin(a) * 9); }); u.teleport(0, 24); u.lookAt(0, 2, 8); });
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(() => { window.__ufo.step(0.5); window.__ufo.render(); });
    await shot(page, 'enemies');
    console.log(JSON.stringify(await page.evaluate(() => window.__ufo.counts())));
  } else {
    const seconds = parseFloat(opt('seconds', '25')); const level = parseInt(opt('level', '0'));
    const t1 = Date.now();
    const started = await page.evaluate(async (lv) => await window.__ufo.startRun(lv), level);
    console.log('run started', JSON.stringify(started), 'in', ((Date.now() - t1) / 1000).toFixed(1) + 's');
    await new Promise(r => setTimeout(r, 2500));
    await page.evaluate(() => window.__ufo.render());
    await shot(page, 'smoke-start');
    const r = await page.evaluate(async (src, s) => await eval('(' + src + ')')(s), BOT, seconds);
    await page.evaluate(() => window.__ufo.render());
    await shot(page, 'smoke-end');
    console.log('after', seconds, 's:', JSON.stringify(r));
    console.log('render stats:', JSON.stringify(await page.evaluate(() => window.__ufo.stats())));
  }
} finally {
  if (errors.length) { console.log('\nERRORS (' + errors.length + '):'); for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ' + e); } else console.log('\nno JS errors');
  await browser.close(); srv.close();
}
