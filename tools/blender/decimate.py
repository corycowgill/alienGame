"""
Decimate a GLB in headless Blender (collapse decimation works on Trellis blobs where
meshopt simplification gives up).

  blender-launcher.exe -b --python tools/blender/decimate.py -- <in.glb> <out.glb> --faces 8000 --log f
"""
import bpy, sys, os, traceback

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
IN, OUT = argv[0], argv[1]
def opt(k, d): return argv[argv.index(k) + 1] if k in argv else d
FACES = int(opt('--faces', '8000'))
LOG = opt('--log', None)
_log = open(LOG, 'w', encoding='utf-8') if LOG else None
def log(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True)
    if _log: _log.write(s + '\n'); _log.flush()
try:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=IN)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    total = sum(len(o.data.polygons) for o in meshes)
    log('imported', IN, 'meshes', len(meshes), 'faces', total)
    for o in meshes:
        share = len(o.data.polygons) / max(total, 1)
        target = max(200, int(FACES * share))
        if len(o.data.polygons) <= target * 1.1: continue
        bpy.context.view_layer.objects.active = o
        mod = o.modifiers.new('dec', 'DECIMATE'); mod.ratio = target / len(o.data.polygons); mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        log(o.name, '->', len(o.data.polygons), 'faces')
    for o in bpy.data.objects: o.select_set(True)
    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    want = dict(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True, export_materials='EXPORT', export_image_format='AUTO', export_texcoords=True, export_normals=True, use_selection=False, export_animations=False)
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
    log('exported', OUT, os.path.getsize(OUT), 'DONE')
except Exception:
    log('TRACEBACK ' + traceback.format_exc()); raise
