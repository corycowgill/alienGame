// Print bounds and the cross-section profile along each axis to tell which end of a model is thin.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const doc = await io.read(process.argv[2]);
const pts = [];
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) { const a = prim.getAttribute('POSITION').getArray(); for (let i = 0; i < a.length; i += 3) pts.push([a[i], a[i + 1], a[i + 2]]); }
const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
console.log('bounds', mn.map(v => v.toFixed(2)), mx.map(v => v.toFixed(2)), 'verts', pts.length);
for (const ax of [0, 2]) {
  const bins = 10, prof = [];
  for (let b = 0; b < bins; b++) {
    const lo = mn[ax] + (mx[ax] - mn[ax]) * b / bins, hi = lo + (mx[ax] - mn[ax]) / bins;
    const sel = pts.filter(p => p[ax] >= lo && p[ax] < hi);
    const o = [0, 1, 2].filter(k => k !== ax);
    let smn = [1e9, 1e9], smx = [-1e9, -1e9];
    for (const p of sel) for (let j = 0; j < 2; j++) { smn[j] = Math.min(smn[j], p[o[j]]); smx[j] = Math.max(smx[j], p[o[j]]); }
    prof.push(sel.length ? ((smx[0] - smn[0]) * (smx[1] - smn[1])).toFixed(3) : '0');
  }
  console.log('axis', 'xyz'[ax], 'cross-section from min->max:', prof.join(' '));
}
