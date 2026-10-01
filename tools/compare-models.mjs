/**
 * Render two sets of models side by side, matched by basename, into a contact sheet.
 *
 * Unlike compare-raw-vs-ship.mjs this serves files by their real directory path rather than
 * by index, because a .gltf resolves its .bin and .png siblings as relative URIs - serving
 * "/glb/3" gives the loader nowhere to resolve them from.
 *
 *   node tools/compare-models.mjs --a <dir>[,<dir>] --b <dir>[,<dir>] --out sheet.png
 *                                 [--labelA text] [--labelB text] [--only a,b] [--cell 440]
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out');
const LABEL_A = opt('labelA', 'A');
const LABEL_B = opt('labelB', 'B');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const CELL = parseInt(opt('cell', '440'));

const MODEL_EXT = /\.(gltf|glb)$/i;
function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (MODEL_EXT.test(e.name)) out.push(p);
  }
  return out;
}
function collect(spec) {
  const m = {};
  for (const d of spec.split(',')) {
    if (!fs.existsSync(d)) continue;
    for (const f of walk(d)) {
      const b = path.basename(f).replace(MODEL_EXT, '');
      if (b.endsWith('_lo') || b.startsWith('test_') || b.startsWith('tex_')) continue;
      m[b.replace(/^weapon_/, '')] = f;
    }
  }
  return m;
}

const A = collect(opt('a')), B = collect(opt('b'));
let names = Object.keys(A).filter((k) => B[k]).sort();
if (ONLY.length) names = names.filter((k) => ONLY.includes(k));
if (!names.length) { console.error('no matching pairs'); process.exit(1); }
console.log(names.length + ' pairs');

// Serve any file by its absolute path, so relative .bin/.png siblings resolve.
const urlFor = (abs) => '/fs/' + path.resolve(abs).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1');
const TYPES = { '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/viewer') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(VIEWER); return; }
  const m = u.match(/^\/fs\/([A-Za-z])\/(.*)$/);
  if (!m) { res.writeHead(404); res.end(); return; }
  const file = m[1] + ':/' + m[2];
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const VIEWER = `<!DOCTYPE html><html><body style="margin:0;background:#202830"><canvas id=c width=${CELL} height=${CELL}></canvas>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
const C=${CELL};
const canvas=document.getElementById('c');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
renderer.setSize(C,C,false); renderer.outputColorSpace=THREE.SRGBColorSpace;
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x202830);
scene.add(new THREE.AmbientLight(0xffffff,1.15));
const dl=new THREE.DirectionalLight(0xffffff,2.1); dl.position.set(3,6,4); scene.add(dl);
const dl2=new THREE.DirectionalLight(0x88aaff,0.85); dl2.position.set(-4,2,-3); scene.add(dl2);
const cam=new THREE.PerspectiveCamera(32,1,0.01,1000);
const loader=new GLTFLoader(); const dr=new DRACOLoader();
dr.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'); dr.setDecoderConfig({type:'js'}); loader.setDRACOLoader(dr);
let cur=null;
window.shot=(url)=>new Promise((res)=>{
  if(cur){scene.remove(cur);cur=null;}
  loader.load(url,(g)=>{
    const o=g.scene; scene.add(o); cur=o;
    const box=new THREE.Box3().setFromObject(o); const s=new THREE.Vector3(); box.getSize(s);
    const c=new THREE.Vector3(); box.getCenter(c); o.position.sub(c);
    const r=Math.max(s.x,s.y,s.z)||1;
    cam.position.set(r*0.95,r*0.72,r*1.45); cam.lookAt(0,0,0);
    renderer.render(scene,cam);
    res({ok:true,png:canvas.toDataURL('image/png')});
  },undefined,(e)=>res({ok:false,error:String(e&&e.message||e).slice(0,140)}));
});
window.__ready=true;
</script></body></html>`;

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:' + port + '/viewer');
await page.waitForFunction(() => window.__ready, { timeout: 120000 });

async function shot(file) {
  try {
    return await Promise.race([
      page.evaluate((u) => window.shot(u), urlFor(file)),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 90000)),
    ]);
  } catch (e) { return { ok: false, error: e.message }; }
}

const shots = [];
for (const n of names) {
  const a = await shot(A[n]), b = await shot(B[n]);
  if (!a.ok) console.log('  fail A', n, a.error);
  if (!b.ok) console.log('  fail B', n, b.error);
  shots.push([a.ok ? Buffer.from(a.png.split(',')[1], 'base64') : null,
              b.ok ? Buffer.from(b.png.split(',')[1], 'base64') : null]);
}
await browser.close(); srv.close();

const LBL = 26, PER_ROW = 2;
const rows = Math.ceil(names.length / PER_ROW);
const comps = [];
for (let i = 0; i < names.length; i++) {
  const col = i % PER_ROW, row = Math.floor(i / PER_ROW);
  const x = col * CELL * 2, y = row * (CELL + LBL);
  if (shots[i][0]) comps.push({ input: shots[i][0], left: x, top: y });
  if (shots[i][1]) comps.push({ input: shots[i][1], left: x + CELL, top: y });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg width="${CELL * 2}" height="${LBL}"><rect width="${CELL * 2}" height="${LBL}" fill="#13202c"/>` +
    `<text x="6" y="18" font-size="14" font-family="Arial" fill="#ffb27a">${esc(names[i])} — ${esc(LABEL_A)}</text>` +
    `<text x="${CELL + 6}" y="18" font-size="14" font-family="Arial" fill="#8fe3a0">${esc(LABEL_B)}</text></svg>`;
  comps.push({ input: Buffer.from(svg), left: x, top: y + CELL });
}
await sharp({ create: { width: PER_ROW * CELL * 2, height: rows * (CELL + LBL), channels: 4, background: '#0c1218' } })
  .composite(comps).png().toFile(OUT);
console.log('wrote', OUT);
