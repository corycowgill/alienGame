/**
 * Pack the comparison page's models as (texture-less GLB, loose JPEG) pairs.
 *
 * Why the split: the artifact sandbox's CSP blocks blob: URLs, and three's GLTFLoader
 * turns every *embedded* glTF image into a blob: URL before handing it to the image
 * loader - so a self-contained .glb fails to parse there even though the bytes are
 * already in memory. Stripping the images means parse() never touches blob:, and the
 * texture arrives as an ordinary same-origin .jpg, which artifacts serve natively.
 * The geometry still has to travel as base64 text, because .glb is not a served type.
 *
 *   node tools/make-viewer-assets.mjs <outDir> [--res 1024]
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
const RES = parseInt(args.indexOf('--res') >= 0 ? args[args.indexOf('--res') + 1] : '1024');
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
let total = 0;
for (const [name, src] of JOBS) {
  if (!fs.existsSync(src)) { console.error('MISSING', name, src); continue; }
  const doc = await io.read(src);
  const root = doc.getRoot();
  for (const ext of root.listExtensionsUsed())
    if (ext.extensionName === 'EXT_texture_webp') ext.dispose();
  await doc.transform(dedup(), prune());

  // Pull the baseColor image out to a real JPEG, then detach every texture so the
  // stripped GLB carries no images at all.
  let wrote = false;
  for (const m of root.listMaterials()) {
    const t = m.getBaseColorTexture();
    if (t && !wrote) {
      const jpg = await sharp(Buffer.from(t.getImage()))
        .resize(RES, RES, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88 }).toBuffer();
      fs.writeFileSync(path.join(OUT, name + '.jpg'), jpg);
      wrote = true;
    }
    m.setBaseColorTexture(null);
    m.setMetallicRoughnessTexture(null);
    m.setNormalTexture(null);
    m.setOcclusionTexture(null);
    m.setEmissiveTexture(null);
    // The viewer multiplies the JPEG by this, so it has to be white.
    m.setBaseColorFactor([1, 1, 1, 1]);
    m.setMetallicFactor(0.0);
    m.setRoughnessFactor(0.85);
  }
  // Dispose the orphaned textures by hand rather than pruning. prune() also drops
  // accessors nothing references any more, and with every texture detached that
  // includes TEXCOORD_0 - which leaves the viewer sampling one texel and rendering
  // the whole model flat grey.
  for (const t of root.listTextures()) t.dispose();

  let tris = 0;
  for (const me of root.listMeshes()) for (const p of me.listPrimitives()) {
    const i = p.getIndices(), a = p.getAttribute('POSITION');
    tris += Math.floor((i ? i.getCount() : a ? a.getCount() : 0) / 3);
  }

  const glb = await io.writeBinary(doc);
  fs.writeFileSync(path.join(OUT, name + '.txt'), Buffer.from(glb).toString('base64'));
  const mesh = fs.statSync(path.join(OUT, name + '.txt')).size / 1e6;
  const tex = wrote ? fs.statSync(path.join(OUT, name + '.jpg')).size / 1e6 : 0;
  total += mesh + tex;
  console.log(name.padEnd(18) + String(tris).padStart(7) + ' tris   mesh ' +
    mesh.toFixed(2) + ' MB   tex ' + tex.toFixed(2) + ' MB' + (wrote ? '' : '   NO TEXTURE'));
}
console.log('\ntotal ' + total.toFixed(1) + ' MB');
