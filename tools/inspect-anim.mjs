// Print a GLB's skins, joints, animation clips, mesh sizes, bounds and textures (Draco/WebP aware).
//   node tools/inspect-anim.mjs <file.glb> [...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/core';
import draco3d from 'draco3dgltf';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  console.log(`=== ${file}`);
  for (const s of root.listSkins()) console.log('skin', s.getName(), 'joints:', s.listJoints().map(j => j.getName()).join(','));
  for (const a of root.listAnimations()) {
    const ch = a.listChannels();
    const dur = Math.max(...a.listSamplers().map(s => { const t = s.getInput().getArray(); return t[t.length-1]; }));
    console.log(`anim "${a.getName()}" channels=${ch.length} dur=${dur.toFixed(2)}s paths=${[...new Set(ch.map(c=>c.getTargetPath()))].join('/')}`);
  }
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) console.log('mesh', m.getName(), 'verts', p.getAttribute('POSITION').getCount(), 'tris', p.getIndices() ? p.getIndices().getCount()/3 : '?', 'joints?', !!p.getAttribute('JOINTS_0'));
  const sc = root.listScenes()[0]; const b = getBounds(sc); console.log('bounds min', b.min.map(v=>v.toFixed(2)), 'max', b.max.map(v=>v.toFixed(2)));
  for (const t of root.listTextures()) console.log('tex', t.getName(), t.getMimeType(), t.getSize());
}
