import fs from 'node:fs'; import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
const OUT = process.argv[2];
const JOBS = [
  ['grey_period', 'C:/Users/coryc/alienGame/art/raw_glb/chicago/building_residential_010.glb'],
  ['grey_cyber',  'C:/Users/coryc/alienGame/art/raw_glb/chicago_v2/building_residential_010.glb'],
];
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
fs.mkdirSync(OUT, { recursive: true });
for (const [name, src] of JOBS) {
  const doc = await io.read(src); const root = doc.getRoot();
  await doc.transform(dedup(), prune());
  for (const m of root.listMaterials()) {
    const t = m.getBaseColorTexture();
    if (t) {
      const jpg = await sharp(Buffer.from(t.getImage())).resize(1024,1024,{fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
      fs.writeFileSync(path.join(OUT, name + '.jpg'), jpg);
    }
    m.setBaseColorTexture(null); m.setMetallicRoughnessTexture(null); m.setNormalTexture(null);
    m.setOcclusionTexture(null); m.setEmissiveTexture(null);
    m.setBaseColorFactor([1,1,1,1]); m.setMetallicFactor(0.0); m.setRoughnessFactor(0.85);
  }
  for (const t of root.listTextures()) t.dispose();
  let tris=0; for (const me of root.listMeshes()) for (const p of me.listPrimitives()) {
    const i=p.getIndices(), a=p.getAttribute('POSITION');
    tris += Math.floor((i?i.getCount():a?a.getCount():0)/3);
  }
  const glb = await io.writeBinary(doc);
  fs.writeFileSync(path.join(OUT, name + '.txt'), Buffer.from(glb).toString('base64'));
  console.log(name, tris, 'tris');
}
