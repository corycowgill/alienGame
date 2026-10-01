/**
 * Render each shipped GLB beside the pristine Trellis raw it came from, so the
 * cost of the optimize pass (decimation + 256px textures) is visible rather than
 * inferred. Writes a two-column contact sheet: raw on the left, shipped on the right.
 *
 *   node tools/compare-raw-vs-ship.mjs --ship <dir>[,<dir>] --raw <dir> --out sheet.png [--only a,b,c]
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SHIP = opt('ship').split(',');
const RAW = opt('raw');
const OUT = opt('out');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const CELL = parseInt(opt('cell', '420'));

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.toLowerCase().endsWith('.glb') ? [path.join(d, e.name)] : []));

const shipped = {};
for (const d of SHIP) for (const f of walk(d)) shipped[path.basename(f, '.glb')] = f;
const raws = {};
for (const f of walk(RAW)) {
  const b = path.basename(f, '.glb');
  if (b.endsWith('_lo') || b.startsWith('test_') || b.startsWith('tex_')) continue;
  raws[b.replace(/^weapon_/, '')] = f;
}

let pairs = Object.keys(shipped).filter(k => raws[k]).sort();
if (ONLY.length) pairs = pairs.filter(k => ONLY.includes(k));
console.log(`${pairs.length} pairs`);

const files = [];
for (const k of pairs) { files.push(raws[k], shipped[k]); }

const VIEWER = (cell) => `<!DOCTYPE html><html><body style="margin:0;background:#202830"><canvas id=c width=${cell} height=${cell}></canvas>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
const C=${cell};
const canvas=document.getElementById('c');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
renderer.setSize(C,C,false); renderer.outputColorSpace=THREE.SRGBColorSpace;
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x202830);
scene.add(new THREE.AmbientLight(0xffffff,1.1));
const dl=new THREE.DirectionalLight(0xffffff,2.0); dl.position.set(3,6,4); scene.add(dl);
const dl2=new THREE.DirectionalLight(0x88aaff,0.8); dl2.position.set(-4,2,-3); scene.add(dl2);
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
    cam.position.set(r*0.95,r*0.75,r*1.45); cam.lookAt(0,0,0);
    renderer.render(scene,cam);
    res({ok:true,png:canvas.toDataURL('image/png')});
  },undefined,(e)=>res({ok:false,error:String(e&&e.message||e).slice(0,120)}));
});
window.__ready=true;
</script></body></html>`;

const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/viewer') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(VIEWER(CELL)); return; }
  const m = u.match(/^\/glb\/(\d+)$/);
  if (m && files[+m[1]]) { res.writeHead(200, { 'Content-Type': 'model/gltf-binary' }); fs.createReadStream(files[+m[1]]).pipe(res); return; }
  res.writeHead(404); res.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/viewer`);
await page.waitForFunction(() => window.__ready, { timeout: 120000 });

const shots = [];
for (let i = 0; i < files.length; i++) {
  let v;
  try { v = await Promise.race([page.evaluate(u => window.shot(u), `/glb/${i}`), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 90000))]); }
  catch (e) { v = { ok: false, error: e.message }; }
  shots.push(v.ok ? Buffer.from(v.png.split(',')[1], 'base64') : null);
  if (!v.ok) console.log('  fail', files[i], v.error);
}
await browser.close(); srv.close();

// layout: 2 pairs per row (4 cells), label strip under each pair
const LBL = 24, PAIRS_PER_ROW = 2;
const rows = Math.ceil(pairs.length / PAIRS_PER_ROW);
const W = PAIRS_PER_ROW * CELL * 2, H = rows * (CELL + LBL);
const comps = [];
for (let i = 0; i < pairs.length; i++) {
  const col = i % PAIRS_PER_ROW, row = Math.floor(i / PAIRS_PER_ROW);
  const x = col * CELL * 2, y = row * (CELL + LBL);
  if (shots[i * 2]) comps.push({ input: shots[i * 2], left: x, top: y });
  if (shots[i * 2 + 1]) comps.push({ input: shots[i * 2 + 1], left: x + CELL, top: y });
  const svg = `<svg width="${CELL * 2}" height="${LBL}"><rect width="${CELL * 2}" height="${LBL}" fill="#13202c"/>` +
    `<text x="6" y="17" font-size="13" font-family="Arial" fill="#9fe">${pairs[i]} — RAW 2048px</text>` +
    `<text x="${CELL + 6}" y="17" font-size="13" font-family="Arial" fill="#fa8">SHIPPED</text></svg>`;
  comps.push({ input: Buffer.from(svg), left: x, top: y + CELL });
}
await sharp({ create: { width: W, height: H, channels: 4, background: '#0c1218' } }).composite(comps).png().toFile(OUT);
console.log('wrote', OUT, W + 'x' + H);
