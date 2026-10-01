/**
 * Render every animation clip in a GLB as a contact sheet so a rig can be judged
 * without opening Blender: one row per clip, N evenly spaced frames per row, 3/4 view.
 *
 *   node tools/view-anim.mjs <file.glb> [out.png] [--frames 6] [--clips Idle,Run] [--gpu]
 *
 * Also prints the clip list, the bone list and the model bounds.
 */
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const target = positional[0];
if (!target) { console.error('usage: node tools/view-anim.mjs <file.glb> [out.png] [--frames 6] [--clips a,b] [--gpu]'); process.exit(1); }
const outPng = positional[1] || path.join('tools', 'shots', path.basename(target, '.glb') + '-anim.png');
const FRAMES = parseInt(opt('--frames', '6'), 10);
const CLIPS = opt('--clips', null);
const GPU = args.includes('--gpu');

const MIME = { '.html': 'text/html', '.glb': 'model/gltf-binary', '.js': 'text/javascript', '.json': 'application/json' };
const CELL = parseInt(opt('--cell', '260'), 10);

const VIEWER = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#20242c;overflow:hidden}canvas{display:block}
</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/"}}</script>
</head><body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const CELL = ${CELL}, FRAMES = ${FRAMES};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242c);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x40381f, 1.1));
const key = new THREE.DirectionalLight(0xfff0dd, 2.2); key.position.set(4, 7, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0x9fc0ff, 0.8); fill.position.set(-5, 3, -4); scene.add(fill);
const grid = new THREE.GridHelper(2, 8, 0x556677, 0x334455); scene.add(grid);

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
draco.setDecoderConfig({ type: 'js' });
loader.setDRACOLoader(draco);

window.__ready = false; window.__info = {};
loader.load(window.__MODEL__, (gltf) => {
  const root = gltf.scene;
  root.traverse(c => { if (c.isMesh) { c.frustumCulled = false; const ms = Array.isArray(c.material) ? c.material : [c.material]; for (const m of ms) if (m.metalness != null) m.metalness = Math.min(m.metalness, 0.3); } });
  scene.add(root);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
  const bones = []; root.traverse(c => { if (c.isBone) bones.push(c.name); });
  const clips = gltf.animations.map(a => ({ name: a.name, duration: a.duration, tracks: a.tracks.length }));
  window.__info = { bounds: { min: box.min.toArray(), max: box.max.toArray() }, size: size.toArray(), bones, clips };
  const wanted = ${CLIPS ? JSON.stringify(CLIPS.split(',')) : 'null'};
  const use = gltf.animations.filter(a => !wanted || wanted.includes(a.name));
  const rows = Math.max(1, use.length);
  renderer.setSize(CELL * FRAMES, CELL * rows);
  renderer.setScissorTest(true);
  const mixer = new THREE.AnimationMixer(root);
  const radius = Math.max(size.x, size.y, size.z);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const camPos = new THREE.Vector3(1.0, 0.75, 1.3).normalize().multiplyScalar(radius * 2.6).add(center);
  camera.position.copy(camPos); camera.lookAt(center);
  use.forEach((clip, r) => {
    mixer.stopAllAction();
    const action = mixer.clipAction(clip); action.play();
    for (let f = 0; f < FRAMES; f++) {
      const t = clip.duration * (f / FRAMES);
      mixer.setTime(0); mixer.update(t);
      root.updateMatrixWorld(true);
      const y = CELL * (rows - 1 - r);
      renderer.setViewport(CELL * f, y, CELL, CELL); renderer.setScissor(CELL * f, y, CELL, CELL);
      renderer.render(scene, camera);
    }
  });
  window.__ready = true;
}, undefined, (e) => { window.__info = { error: String(e) }; window.__ready = true; });
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(VIEWER); return; }
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const rel = path.relative(ROOT, path.resolve(target)).split(path.sep).join('/');
if (rel.startsWith('..')) { console.error('model must live under the project root'); process.exit(1); }
const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: GPU ? ['--use-angle=d3d11', '--enable-unsafe-swiftshader'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: CELL * FRAMES, height: CELL * 8 });
await page.evaluateOnNewDocument((m) => { window.__MODEL__ = m; }, '/' + rel);
page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
const info = await page.evaluate('window.__info');
console.log(JSON.stringify(info, null, 1));
const canvas = await page.$('canvas');
fs.mkdirSync(path.dirname(outPng), { recursive: true });
await canvas.screenshot({ path: outPng });
console.log('wrote', outPng);
await browser.close();
server.close();
