/**
 * Pack self-contained .glb copies for the comparison page's model viewers.
 * The shipping assets are .gltf + .bin + .png triples (that split is the whole point
 * of the rebuild), but a <model-viewer> is happier with one file per model.
 *   node tools/make-viewer-glbs.mjs <outDir> [--res 1024]
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const args = process.argv.slice(2);
const OUT = args[0];
const RES = parseInt((args.indexOf('--res') >= 0 ? args[args.indexOf('--res') + 1] : '1024'));
const SP = 'C:/Users/coryc/AppData/Local/Temp/claude/C--Users-coryc/528a1324-3752-4fb9-994c-0cd46161183c/scratchpad';
const NEW = 'C:/Users/coryc/ufoUnityShooter/Assets/Resources/Models';
const CHI = 'C:/Users/coryc/alienGame/art/raw_glb/chicago';

const JOBS = [
  ['police_car_old', SP + '/old-glb-backup/props/police_car.glb'],
  ['police_car_new', NEW + '/props/police_car.gltf'],
  ['l_track_old', SP + '/old-glb-backup/props/l_track.glb'],
  ['l_track_new', NEW + '/props/l_track.gltf'],
  ['rifle_old', SP + '/old-glb-backup/weapons/rifle.glb'],
  ['rifle_new', NEW + '/weapons/rifle.gltf'],
  ['res013_old', SP + '/old-glb-backup/props/building_residential_013.glb'],
  ['res013_new', CHI + '/building_residential_013.glb'],
  ['sky016_old', SP + '/old-glb-backup/props/building_skyscraper_016.glb'],
  ['sky016_new', CHI + '/building_skyscraper_016.glb'],
  ['res010_old', SP + '/old-glb-backup/props/building_residential_010.glb'],
  ['res010_new', CHI + '/building_residential_010.glb'],
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

fs.mkdirSync(OUT, { recursive: true });
const report = [];
for (const [name, src] of JOBS) {
  if (!fs.existsSync(src)) { console.error('MISSING', name, src); continue; }
  const doc = await io.read(src);
  const root = doc.getRoot();
  for (const ext of root.listExtensionsUsed())
    if (ext.extensionName === 'EXT_texture_webp') ext.dispose();
  await doc.transform(dedup(), prune());
  for (const tex of root.listTextures()) {
    const buf = await sharp(Buffer.from(tex.getImage()))
      .resize(RES, RES, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86 }).toBuffer();
    tex.setImage(buf).setMimeType('image/jpeg').setURI('');
  }
  let tris = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const i = p.getIndices(), a = p.getAttribute('POSITION');
    tris += Math.floor((i ? i.getCount() : a ? a.getCount() : 0) / 3);
  }
  const dst = path.join(OUT, name + '.glb');
  await io.write(dst, doc);
  const mb = fs.statSync(dst).size / 1e6;
  report.push({ name, tris, mb: +mb.toFixed(2) });
  console.log(name.padEnd(18) + String(tris).padStart(7) + ' tris  ' + mb.toFixed(2) + ' MB');
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log('\ntotal ' + report.reduce((n, r) => n + r.mb, 0).toFixed(1) + ' MB');
