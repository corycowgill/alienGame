/**
 * Rebuild a shipping asset from its pristine Trellis raw with a sane budget.
 *
 * The shipping pipeline decimated props to 3-5% of their triangles and crushed every
 * texture to 256px, because glTFast imports GLB-embedded images as uncompressed RGBA32
 * and that was the only lever on build size. External textures are Unity assets and
 * compress to DXT1 (0.5 B/texel), so the lever moves: spend the budget on texels.
 *
 *   node tools/rebuild-asset.mjs <raw.glb> <out.glb> --tris <n> --res <px>
 */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, simplify, textureCompress, resample } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const [inp, out] = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const TRIS = parseInt(opt('tris', '12000'));
const RES = parseInt(opt('res', '1024'));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const countTris = (doc) => doc.getRoot().listMeshes().flatMap(m => m.listPrimitives())
  .reduce((n, p) => { const i = p.getIndices(), a = p.getAttribute('POSITION'); return n + Math.floor(((i ? i.getCount() : a ? a.getCount() : 0)) / 3); }, 0);

const doc = await io.read(inp);
const before = countTris(doc);
const ratio = Math.min(1, TRIS / before);

await doc.transform(
  dedup(), prune(), resample(),
  // weld first: Trellis emits split vertices that otherwise block every collapse.
  weld({ tolerance: 0.0001 }),
  // error 0.005 instead of the old 0.01: silhouettes survive (traffic_light and
  // car_wreck visibly lost theirs at the old setting).
  simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.005, lockBorder: false }),
  textureCompress({ encoder: sharp, targetFormat: 'png', resize: [RES, RES] }),
);

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
await io.write(out, doc);
const after = countTris(doc);
console.log(`${path.basename(inp)}: ${before} -> ${after} tris (${(100 * after / before).toFixed(1)}%), tex ${RES}px, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
