/**
 * Optimize GLBs for the web: prune, dedup, WebP textures, Draco geometry.
 *
 *   node tools/optimize-glb.mjs <in.glb|dir> <out.glb|dir> [--res 1024] [--ratio 0.2] [--no-draco] [--rename a=b,...]
 *
 * Rigged/animated files keep their skins and animations (Draco handles skinned meshes).
 */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, draco, textureCompress, resample, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const args = process.argv.slice(2);
const inp = args[0], out = args[1];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const RES = parseInt(opt('res', '1024'));
const NO_DRACO = args.includes('--no-draco');
const RATIO = parseFloat(opt('ratio', '1'));   // triangle ratio to keep (e.g. 0.2 = keep 20%)
const ERR = parseFloat(opt('error', '0.002'));
const RENAME = Object.fromEntries((opt('rename', '') || '').split(',').filter(Boolean).map(p => p.split('=')));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

async function one(src, dst) {
  const doc = await io.read(src);
  const before = fs.statSync(src).size;
  await doc.transform(
    dedup(), prune(),
    resample(),
    ...(RATIO < 1 ? [weld({ tolerance: 0.0001 }), simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERR, lockBorder: false })] : []),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [RES, RES], quality: 88 }),
    ...(NO_DRACO ? [] : [draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 })]),
  );
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await io.write(dst, doc);
  const after = fs.statSync(dst).size;
  console.log(`${path.basename(src)} -> ${path.basename(dst)}  ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(2)} MB`);
}

if (fs.statSync(inp).isDirectory()) {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(inp).filter(f => f.toLowerCase().endsWith('.glb'))) {
    const base = f.replace(/\.glb$/i, '');
    const name = (RENAME[base] || base) + '.glb';
    try { await one(path.join(inp, f), path.join(out, name)); }
    catch (e) { console.error('FAILED', f, e.message); }
  }
} else {
  await one(inp, out);
}
