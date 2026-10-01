/**
 * Measure shipped GLB quality: triangles, texture resolution/format, bounds,
 * and derived density metrics. Compares against the pristine Trellis raw when
 * one exists, so we can see how much each asset lost in the optimize pass.
 *
 *   node tools/analyze-glb-quality.mjs <shipDir> [--raw <rawDir>] [--json out.json]
 */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const dirs = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

function listGlb(d) {
  const out = [];
  (function walk(p) {
    for (const f of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, f.name);
      if (f.isDirectory()) walk(fp);
      else if (f.name.toLowerCase().endsWith('.glb')) out.push(fp);
    }
  })(d);
  return out;
}

async function measure(file) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  let tris = 0, verts = 0, prims = 0, uvSets = 0, hasNormals = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    prims++;
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    verts += pos.getCount();
    const idx = prim.getIndices();
    tris += Math.floor((idx ? idx.getCount() : pos.getCount()) / 3);
    if (prim.getAttribute('TEXCOORD_0')) uvSets++;
    if (prim.getAttribute('NORMAL')) hasNormals++;
    const mn = pos.getMin([0, 0, 0]), mx = pos.getMax([0, 0, 0]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], mn[i]); max[i] = Math.max(max[i], mx[i]); }
  }
  const size = isFinite(min[0]) ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : [0, 0, 0];

  const texes = root.listTextures().map(t => {
    const img = t.getImage();
    let w = 0, h = 0;
    try { const s = t.getSize(); if (s) { w = s[0]; h = s[1]; } } catch {}
    return { mime: t.getMimeType(), w, h, bytes: img ? img.byteLength : 0, name: t.getName() };
  });

  // Which PBR slots are actually populated across all materials?
  const slots = new Set();
  for (const m of root.listMaterials()) {
    if (m.getBaseColorTexture()) slots.add('baseColor');
    if (m.getNormalTexture()) slots.add('normal');
    if (m.getMetallicRoughnessTexture()) slots.add('metalRough');
    if (m.getEmissiveTexture()) slots.add('emissive');
    if (m.getOcclusionTexture()) slots.add('occlusion');
    const e = m.getEmissiveFactor();
    if (e && (e[0] + e[1] + e[2]) > 0.001) slots.add('emissiveFactor');
  }

  return {
    bytes: fs.statSync(file).size,
    tris, verts, prims,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    animations: root.listAnimations().length,
    skins: root.listSkins().length,
    size: size.map(v => +v.toFixed(3)),
    maxDim: +Math.max(...size).toFixed(3),
    texes,
    maxTex: texes.length ? Math.max(...texes.map(t => Math.max(t.w, t.h))) : 0,
    texCount: texes.length,
    slots: [...slots],
    uvSets, hasNormals,
    draco: (doc.getRoot().listExtensionsUsed?.() || []).map(e => e.extensionName).includes('KHR_draco_mesh_compression'),
  };
}

const ship = {};
for (const d of dirs) for (const f of listGlb(d)) {
  const key = path.basename(f, '.glb');
  try { ship[key] = { file: f, rel: path.relative(dirs[0], f), ...(await measure(f)) }; }
  catch (e) { ship[key] = { file: f, error: String(e.message || e).slice(0, 160) }; }
}

const rawDir = opt('raw', null);
const raw = {};
if (rawDir && fs.existsSync(rawDir)) {
  for (const f of listGlb(rawDir)) {
    const b = path.basename(f, '.glb');
    if (b.endsWith('_lo') || b.startsWith('test_') || b.startsWith('tex_')) continue;
    const key = b.replace(/^weapon_/, '');   // raw weapons are weapon_rifle.glb -> rifle.glb
    try { raw[key] = { file: f, ...(await measure(f)) }; } catch {}
  }
}

const rows = Object.entries(ship).map(([k, s]) => ({ name: k, ...s, raw: raw[k] || null }));
rows.sort((a, b) => (a.rel || '').localeCompare(b.rel || ''));

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(pad('asset', 30) + num('MB', 6) + num('tris', 8) + num('rawTris', 9) + num('kept%', 7) + num('tex', 6) + num('rawTex', 7) + num('mat', 5) + num('maxDim', 8) + num('tri/m2', 8) + num('px/m', 7) + '  slots');
for (const r of rows) {
  if (r.error) { console.log(pad(r.name, 30) + '  ERROR ' + r.error); continue; }
  // crude surface area proxy: bounding-box surface area
  const [x, y, z] = r.size;
  const area = 2 * (x * y + y * z + z * x) || 1;
  const triDen = r.tris / area;
  const pxPerM = r.maxTex / (r.maxDim || 1);
  console.log(
    pad(r.name, 30) + num((r.bytes / 1e6).toFixed(2), 6) + num(r.tris, 8) +
    num(r.raw ? r.raw.tris : '-', 9) + num(r.raw ? (100 * r.tris / r.raw.tris).toFixed(1) : '-', 7) +
    num(r.maxTex, 6) + num(r.raw ? r.raw.maxTex : '-', 7) + num(r.materials, 5) +
    num(r.maxDim, 8) + num(triDen.toFixed(0), 8) + num(pxPerM.toFixed(0), 7) + '  ' + r.slots.join(',')
  );
}

const jsonOut = opt('json', null);
if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify({ generated: new Date().toISOString(), rows }, null, 2)); console.log('\nwrote ' + jsonOut); }

const tot = rows.filter(r => !r.error);
console.log(`\n${tot.length} assets, ${(tot.reduce((n, r) => n + r.bytes, 0) / 1e6).toFixed(1)} MB, ${tot.reduce((n, r) => n + r.tris, 0).toLocaleString()} tris total`);
