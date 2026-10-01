/**
 * Validate GLB files two ways, then write a report and a contact sheet.
 *
 *   node tools/validate-glb.mjs <dir-or-file> [...more] [--out tools/reports/glb-validation.json] [--sheet tools/shots/glb-sheet.png]
 *
 * 1. Structural: parse with @gltf-transform/core (Draco/WebP aware), count
 *    meshes, triangles, materials, textures; measure the bounding box.
 * 2. Viewer: load each file in a real three.js scene in headless Chrome
 *    (GLTFLoader + DRACOLoader, same versions the game uses), render it, and
 *    check that pixels were actually drawn. A file that parses but renders
 *    nothing (empty mesh, NaN transforms, broken textures) fails here.
 *
 * A file is VALID only if both pass. Thumbnails go into a contact sheet.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const inputs = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const OUT = path.resolve(ROOT, opt('out', 'tools/reports/glb-validation.json'));
const SHEET = path.resolve(ROOT, opt('sheet', 'tools/shots/glb-sheet.png'));
// Fraction of the 256px frame that must be covered. Broken Trellis meshes render
// as sparse needle splinters that still touch 1–6% of pixels; real objects
// framed to fill the view cover well over 8%.
const MIN_DRAWN = parseFloat(opt('min-drawn', '0.08'));

function collect(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).filter(f => f.toLowerCase().endsWith('.glb')).map(f => path.join(p, f));
  return [p];
}
const files = inputs.flatMap(collect);
if (!files.length) { console.error('no .glb inputs'); process.exit(1); }

// ── 1. structural pass ──
async function structural(file) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
  const r = { file, name: path.basename(file), bytes: fs.statSync(file).size, ok: false };
  try {
    const doc = await io.read(file);
    const root = doc.getRoot();
    let tris = 0, verts = 0, prims = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
      prims++;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      verts += pos.getCount();
      const idx = prim.getIndices();
      tris += Math.floor((idx ? idx.getCount() : pos.getCount()) / 3);
      const mn = pos.getMin([0, 0, 0]), mx = pos.getMax([0, 0, 0]);
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], mn[i]); max[i] = Math.max(max[i], mx[i]); }
    }
    r.meshes = root.listMeshes().length; r.primitives = prims; r.triangles = tris; r.vertices = verts;
    r.materials = root.listMaterials().length; r.textures = root.listTextures().length;
    r.animations = root.listAnimations().length; r.skins = root.listSkins().length;
    r.size = isFinite(min[0]) ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map(v => +v.toFixed(3)) : null;
    const problems = [];
    if (prims === 0) problems.push('no geometry');
    if (tris === 0) problems.push('zero triangles');
    if (!r.size || r.size.some(v => !isFinite(v))) problems.push('bad bounds');
    else if (Math.max(...r.size) < 0.01) problems.push('degenerate size');
    else if (Math.max(...r.size) > 500) problems.push('absurd size ' + Math.max(...r.size));
    if (r.textures === 0 && r.materials > 0) problems.push('no textures');
    r.problems = problems; r.ok = problems.length === 0;
  } catch (e) { r.problems = ['parse error: ' + (e.message || e).toString().slice(0, 120)]; }
  return r;
}

// ── 2. viewer pass ──
const VIEWER = `<!DOCTYPE html><html><body style="margin:0;background:#202830"><canvas id=c width=256 height=256></canvas>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(256, 256, false);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202830);
scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(3, 6, 4); scene.add(dl);
const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
const loader = new GLTFLoader(); const draco = new DRACOLoader(); draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'); draco.setDecoderConfig({ type: 'js' }); loader.setDRACOLoader(draco);
let current = null;
window.loadGlb = (url) => new Promise((resolve) => {
  if (current) { scene.remove(current); current = null; }
  loader.load(url, (gltf) => {
    const obj = gltf.scene; scene.add(obj); current = obj;
    const box = new THREE.Box3().setFromObject(obj); const size = new THREE.Vector3(); box.getSize(size); const center = new THREE.Vector3(); box.getCenter(center);
    const r = Math.max(size.x, size.y, size.z) || 1;
    obj.position.sub(center);
    cam.position.set(r * 1.1, r * 0.9, r * 1.6); cam.lookAt(0, 0, 0);
    let meshes = 0; obj.traverse(o => { if (o.isMesh) meshes++; });
    renderer.render(scene, cam);
    const gl = renderer.getContext(); const px = new Uint8Array(256 * 256 * 4); gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let drawn = 0; for (let i = 0; i < px.length; i += 16) { if (Math.abs(px[i] - 0x20) + Math.abs(px[i+1] - 0x28) + Math.abs(px[i+2] - 0x30) > 24) drawn++; }
    resolve({ ok: true, meshes, size: [size.x, size.y, size.z].map(v => +v.toFixed(3)), drawnFrac: +(drawn / (px.length / 16)).toFixed(3), png: canvas.toDataURL('image/png') });
  }, undefined, (err) => resolve({ ok: false, error: (err && (err.message || err.toString())).slice(0, 160) }));
});
window.__ready = true;
</script></body></html>`;

function findBrowser() {
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'])
    if (fs.existsSync(p)) return p;
  throw new Error('no Chrome/Edge');
}

async function main() {
  console.log(`validating ${files.length} files`);
  const results = [];
  for (const f of files) results.push(await structural(f));

  // serve files by index so the viewer can fetch any path on disk
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/viewer') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(VIEWER); return; }
    const m = u.match(/^\/glb\/(\d+)$/);
    if (m && files[+m[1]]) { res.writeHead(200, { 'Content-Type': 'model/gltf-binary' }); fs.createReadStream(files[+m[1]]).pipe(res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${port}/viewer`);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });

  const thumbs = [];
  for (let i = 0; i < files.length; i++) {
    const r = results[i];
    let v;
    try { v = await Promise.race([page.evaluate((u) => window.loadGlb(u), `/glb/${i}`), new Promise((_, rej) => setTimeout(() => rej(new Error('viewer timeout')), 60000))]); }
    catch (e) { v = { ok: false, error: e.message }; }
    r.viewer = { ok: v.ok, meshes: v.meshes, size: v.size, drawnFrac: v.drawnFrac, error: v.error };
    if (v.ok && v.drawnFrac < MIN_DRAWN) { r.viewer.ok = false; r.viewer.error = (v.drawnFrac < 0.01 ? 'rendered nothing' : 'splinter geometry') + ' (drawnFrac ' + v.drawnFrac + ')'; }
    if (v.ok && v.meshes === 0) { r.viewer.ok = false; r.viewer.error = 'no meshes after load'; }
    r.valid = r.ok && r.viewer.ok;
    if (v.png) thumbs.push({ name: r.name, valid: r.valid, buf: Buffer.from(v.png.split(',')[1], 'base64') });
    console.log(`${r.valid ? 'VALID  ' : 'INVALID'} ${r.name.padEnd(36)} tris ${String(r.triangles ?? '-').padStart(6)}  size ${r.size ? r.size.join('x') : '-'}  drawn ${v.drawnFrac ?? '-'}  ${(r.problems || []).concat(r.viewer.error ? [r.viewer.error] : []).join('; ')}`);
  }
  await browser.close(); srv.close();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2));
  // contact sheet: 8 per row, name label
  if (thumbs.length) {
    const cols = 8, cell = 256, label = 22, rows = Math.ceil(thumbs.length / cols);
    const composites = [];
    for (let i = 0; i < thumbs.length; i++) {
      const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + label);
      composites.push({ input: thumbs[i].buf, left: x, top: y });
      const svg = `<svg width="${cell}" height="${label}"><rect width="${cell}" height="${label}" fill="${thumbs[i].valid ? '#1d3a22' : '#5a1d1d'}"/><text x="4" y="15" font-size="11" font-family="Arial" fill="#fff">${thumbs[i].name.replace(/&/g, '&amp;').slice(0, 40)}</text></svg>`;
      composites.push({ input: Buffer.from(svg), left: x, top: y + cell });
    }
    fs.mkdirSync(path.dirname(SHEET), { recursive: true });
    await sharp({ create: { width: cols * cell, height: rows * (cell + label), channels: 4, background: '#101418' } }).composite(composites).png().toFile(SHEET);
  }
  const valid = results.filter(r => r.valid).length;
  console.log(`\n${valid}/${results.length} valid. Report: ${path.relative(ROOT, OUT)}. Sheet: ${path.relative(ROOT, SHEET)}`);
  if (errors.length) console.log('viewer page errors:', [...new Set(errors)].slice(0, 5).join(' | '));
}
main().catch(e => { console.error(e); process.exit(1); });
