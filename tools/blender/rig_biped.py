"""
Auto-rig a Trellis biped (A-pose humanoid / alien soldier) in headless Blender and bake a clip set.

  blender-launcher.exe -b --python tools/blender/rig_biped.py -- <in.glb> <out.glb> [options]

Options
  --faces N        decimate to about N faces (default 14000)
  --forward DIR    which way the face points after import: auto | +x | -x | +y | -y
  --log FILE       progress log (the Store launcher swallows stdout)
  --dump FILE      landmark JSON
  --clips a,b,c    keep only these clips (default: Idle,Walk,Run,Attack,Shoot,Hit,Death)
  --height M       final height in metres (default 1.8) -> model is scaled so bbox height == M
  --hover          flying unit: no leg clips, Idle/Walk/Run become bob+bank
  --stubby         squat unit with short legs: lower hip line, smaller leg amplitude

Measures the mesh (A-pose: arms out ~30 deg), builds a 17-bone armature, weights by distance to
bone segments (bone-heat fails on Trellis shells), keys clips by formula and exports NLA tracks as
separate glTF animations. Blender convention here: character faces -Y (glTF +Z after export).
"""
import bpy, sys, os, math, json, traceback
from mathutils import Vector, Matrix
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if len(argv) < 2:
    raise SystemExit('usage: -- <in.glb> <out.glb> [--faces N] [--forward DIR] [--log FILE]')
IN, OUT = argv[0], argv[1]
def opt(k, d):
    return argv[argv.index(k) + 1] if k in argv else d
TARGET_FACES = int(opt('--faces', '14000'))
FORWARD = opt('--forward', 'auto')
LOG_PATH = opt('--log', None)
DUMP_PATH = opt('--dump', None)
CLIPS = opt('--clips', 'Idle,Walk,Run,Attack,Shoot,Hit,Death').split(',')
HEIGHT = float(opt('--height', '1.8'))
HOVER = '--hover' in argv
STUBBY = '--stubby' in argv
_log = open(LOG_PATH, 'w', encoding='utf-8') if LOG_PATH else None
def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    if _log: _log.write(s + '\n'); _log.flush()
FPS = 30

try:
    # 1. import and flatten
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=IN)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if not meshes:
        raise SystemExit('no mesh in ' + IN)
    for o in bpy.data.objects: o.select_set(False)
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    mesh = bpy.context.view_layer.objects.active
    mesh.select_set(True)
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in list(bpy.data.objects):
        if o != mesh: bpy.data.objects.remove(o, do_unlink=True)
    mesh.name = 'Body'
    log('imported', IN, 'verts', len(mesh.data.vertices), 'faces', len(mesh.data.polygons))

    # 2. decimate
    nf = len(mesh.data.polygons)
    if nf > TARGET_FACES * 1.1:
        mod = mesh.modifiers.new('dec', 'DECIMATE')
        mod.ratio = TARGET_FACES / nf
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        log('decimated to', len(mesh.data.polygons), 'faces')

    def coords():
        n = len(mesh.data.vertices)
        a = np.empty(n * 3, dtype=np.float64)
        mesh.data.vertices.foreach_get('co', a)
        return a.reshape(n, 3)

    # 3. orientation: up is +Z after glTF import. Width axis = arms (A-pose is wide).
    V = coords(); mn, mx = V.min(0), V.max(0); ext = mx - mn
    log('raw bounds', mn.round(3).tolist(), mx.round(3).tolist(), 'ext', ext.round(3).tolist())
    width_axis = 0 if ext[0] >= ext[1] else 1
    depth_axis = 1 - width_axis
    if FORWARD == 'auto':
        # Toes point forward: the lowest 6% of the mesh sits ahead of the torso band along the
        # depth axis. A backpack pushes the torso centroid backward, reinforcing the sign.
        H = ext[2]
        feet = V[V[:, 2] < mn[2] + 0.06 * H]
        torso = V[(V[:, 2] > mn[2] + 0.40 * H) & (V[:, 2] < mn[2] + 0.70 * H)]
        d_torso = float(np.median(feet[:, depth_axis]) - np.median(torso[:, depth_axis]))
        # Toes are longer than heels: measure how far the sole extends from the ankle line each way.
        ankle = V[(V[:, 2] > mn[2] + 0.06 * H) & (V[:, 2] < mn[2] + 0.12 * H)]
        ac = float(np.median(ankle[:, depth_axis])) if len(ankle) else float(np.median(feet[:, depth_axis]))
        sole = V[V[:, 2] < mn[2] + 0.03 * H]
        if len(sole) < 20: sole = feet
        d_toe = float((np.percentile(sole[:, depth_axis], 97) - ac) - (ac - np.percentile(sole[:, depth_axis], 3)))
        # Toe length is the stronger cue; the torso offset breaks ties.
        score = d_toe * 3.0 + d_torso
        face_positive = score > 0
        log('auto forward along', 'xy'[depth_axis], 'toe', round(d_toe, 4), 'torso', round(d_torso, 4), 'score', round(score, 4), '-> face at', '+' if face_positive else '-')
    else:
        face_positive = FORWARD[0] == '+'
        depth_axis = 0 if FORWARD[1] == 'x' else 1
    if depth_axis == 1:
        rot = math.pi if face_positive else 0.0
    else:
        rot = math.pi / 2 if face_positive else -math.pi / 2
    mesh.data.transform(Matrix.Rotation(rot, 4, 'Z'))
    V = coords(); mn, mx = V.min(0), V.max(0)
    mesh.data.transform(Matrix.Translation(Vector((-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2]))))
    V = coords(); mn, mx = V.min(0), V.max(0)
    s = HEIGHT / (mx[2] - mn[2])
    mesh.data.transform(Matrix.Scale(s, 4))
    V = coords(); mn, mx = V.min(0), V.max(0); ext = mx - mn
    W, D, H = ext[0], ext[1], ext[2]
    log('oriented bounds', mn.round(3).tolist(), mx.round(3).tolist(), 'W', round(W, 3), 'D', round(D, 3), 'H', round(H, 3))

    # 4. landmarks
    def band(z0, z1):
        return V[(V[:, 2] >= z0 * H) & (V[:, 2] < z1 * H)]
    def torso_halfwidth(z0, z1):
        b = band(z0, z1)
        if len(b) < 10: return 0.15 * W
        return float(np.percentile(np.abs(b[:, 0]), 55))
    head_c = band(0.88, 1.0)
    head_y = float(np.median(head_c[:, 1])) if len(head_c) else 0.0
    z_neck, z_shoulder, z_chest, z_hips, z_knee, z_ankle = 0.84 * H, 0.80 * H, 0.70 * H, 0.52 * H, 0.27 * H, 0.05 * H
    if STUBBY:
        z_hips, z_knee, z_shoulder, z_chest, z_neck = 0.42 * H, 0.22 * H, 0.72 * H, 0.60 * H, 0.80 * H
    def spine_y(zf):
        b = band(zf - 0.03, zf + 0.03)
        if len(b) < 10: return 0.0
        core = b[np.abs(b[:, 0]) < 0.35 * W]
        return float(np.median(core[:, 1])) if len(core) else 0.0
    tw = torso_halfwidth(0.55, 0.78)
    arm_band = band(0.30, 0.85)
    arms = arm_band[np.abs(arm_band[:, 0]) > tw * 1.15]
    def arm_side(sgn):
        a = arms[(arms[:, 0] * sgn) > 0]
        if len(a) < 10:
            return dict(shoulder=(sgn * tw, spine_y(0.78), z_shoulder), elbow=(sgn * (tw + 0.16 * H), spine_y(0.7), 0.62 * H), hand=(sgn * (tw + 0.30 * H), spine_y(0.62), 0.45 * H))
        far = a[np.abs(a[:, 0]) > np.percentile(np.abs(a[:, 0]), 88)]
        hand = np.array([float(np.median(far[:, 0])), float(np.median(far[:, 1])), float(np.percentile(far[:, 2], 30))])
        shoulder = np.array([sgn * tw * 0.9, spine_y(0.78), z_shoulder])
        elbow = 0.5 * (shoulder + hand); elbow[2] += 0.02 * H
        return dict(shoulder=shoulder.tolist(), elbow=elbow.tolist(), hand=hand.tolist())
    armL, armR = arm_side(+1), arm_side(-1)
    low = band(0.0, 0.12)
    def foot(sgn):
        f = low[(low[:, 0] * sgn) > 0]
        if len(f) < 5: return np.array([sgn * 0.12 * W, 0.0, 0.0])
        return np.array([float(np.median(f[:, 0])), float(np.median(f[:, 1])), 0.0])
    fL, fR = foot(+1), foot(-1)
    fx = max((abs(fL[0]) + abs(fR[0])) / 2, 0.06 * W); fy = (fL[1] + fR[1]) / 2
    fL[:2] = (fx, fy); fR[:2] = (-fx, fy)
    lm = dict(W=W, D=D, H=H, armL=armL, armR=armR, footL=fL.tolist(), footR=fR.tolist(), torso_hw=tw)
    log('landmarks', json.dumps(lm, default=lambda v: round(float(v), 3)))
    if DUMP_PATH: json.dump(lm, open(DUMP_PATH, 'w'), indent=1, default=float)

    # 5. armature
    bones = {}
    def B(name, head, tail, parent, radius):
        bones[name] = (np.array(head, dtype=float), np.array(tail, dtype=float), parent, radius)
    sy = spine_y
    P_hips = (0, sy(z_hips / H), z_hips); P_spine = (0, sy(0.61), 0.61 * H); P_chest = (0, sy(z_chest / H), z_chest)
    P_neck = (0, sy(z_neck / H), z_neck); P_head = (0, head_y, 0.87 * H); P_top = (0, head_y, H)
    B('root', (0, 0, 0), (0, 0, 0.1 * H), None, 0.0)
    B('hips', P_hips, P_spine, 'root', 0.24 * H)
    B('spine', P_spine, P_chest, 'hips', 0.26 * H)
    B('chest', P_chest, P_neck, 'spine', 0.28 * H)
    B('neck', P_neck, P_head, 'chest', 0.10 * H)
    B('head', P_head, P_top, 'neck', 0.20 * H)
    for side, a, f in (('L', armL, fL), ('R', armR, fR)):
        B('upperarm_' + side, a['shoulder'], a['elbow'], 'chest', 0.09 * H)
        B('forearm_' + side, a['elbow'], a['hand'], 'upperarm_' + side, 0.08 * H)
        hand_tip = list(a['hand']); hand_tip[2] -= 0.06 * H; hand_tip[0] += (0.03 * H if side == 'L' else -0.03 * H)
        B('hand_' + side, a['hand'], hand_tip, 'forearm_' + side, 0.09 * H)
        hip = (f[0] * 0.8, sy(z_hips / H), z_hips - 0.02 * H)
        knee = (f[0], f[1] - 0.02 * H, z_knee)
        ankle = (f[0], f[1], z_ankle)
        toe = (f[0], f[1] - 0.10 * H, 0.0)
        B('thigh_' + side, hip, knee, 'hips', 0.13 * H)
        B('shin_' + side, knee, ankle, 'thigh_' + side, 0.11 * H)
        B('foot_' + side, ankle, toe, 'shin_' + side, 0.10 * H)
    arm_data = bpy.data.armatures.new('BipedRig')
    arm = bpy.data.objects.new('Armature', arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (h, t, parent, r) in bones.items():
        eb = arm_data.edit_bones.new(name); eb.head, eb.tail = Vector(h), Vector(t); eb.roll = 0.0
    for name, (h, t, parent, r) in bones.items():
        if parent: arm_data.edit_bones[name].parent = arm_data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    log('armature', len(bones), 'bones')

    # 6. weights by distance to bone segments
    names = [n for n in bones if bones[n][3] > 0]
    Wm = np.zeros((len(V), len(names)))
    for j, n in enumerate(names):
        h, t, _, r = bones[n]
        d = t - h; ll = float(d @ d)
        tt = np.clip(((V - h) @ d) / ll, 0, 1) if ll > 1e-12 else np.zeros(len(V))
        proj = h + tt[:, None] * d
        dist = np.linalg.norm(V - proj, axis=1)
        Wm[:, j] = 1.0 / (1.0 + (dist / r) ** 4)
    for j, n in enumerate(names):
        if n.startswith(('upperarm', 'forearm', 'hand')):
            Wm[np.abs(V[:, 0]) < tw * 0.9, j] *= 0.08
        if n.startswith(('thigh', 'shin', 'foot')):
            Wm[V[:, 2] > z_hips + 0.04 * H, j] *= 0.05
            sgn = 1 if n.endswith('_L') else -1
            Wm[(V[:, 0] * sgn) < -0.02 * W, j] *= 0.1
        if n == 'head':
            Wm[V[:, 2] < z_neck - 0.03 * H, j] *= 0.1
        if n in ('hips', 'spine', 'chest'):
            Wm[np.abs(V[:, 0]) > tw * 1.6, j] *= 0.3
    order = np.argsort(-Wm, axis=1)[:, :4]
    keep = np.zeros_like(Wm); rows = np.arange(len(V))[:, None]
    keep[rows, order] = Wm[rows, order]
    keep[keep < 1e-3] = 0
    keep /= np.maximum(keep.sum(1, keepdims=True), 1e-9)
    groups = {n: mesh.vertex_groups.new(name=n) for n in names}
    for j, n in enumerate(names):
        idx = np.nonzero(keep[:, j] > 0)[0]; g = groups[n]
        for i in idx: g.add([int(i)], float(keep[i, j]), 'REPLACE')
    mesh.parent = arm
    mod = mesh.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
    log('weights assigned; top owners', {n: int((order[:, 0] == j).sum()) for j, n in enumerate(names)})

    # 7. animation helpers
    bpy.context.scene.render.fps = FPS
    rest = {b.name: b.matrix_local.to_3x3() for b in arm_data.bones}
    for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
    rest_dir = {n: (Vector(bones[n][1]) - Vector(bones[n][0])).normalized() for n in bones}
    def local_rot(bone, rots):
        Rw = Matrix.Identity(3)
        for ax, val in rots:
            if ax == 'AIM':
                # Rotate the bone (in world space) so its rest direction points along val.
                Rw = Rw @ rest_dir[bone].rotation_difference(Vector(val).normalized()).to_matrix()
            else:
                Rw = Rw @ Matrix.Rotation(math.radians(val), 3, ax)
        Rr = rest[bone]
        return (Rr.inverted() @ Rw @ Rr).to_quaternion()
    def local_loc(bone, world_offset):
        return rest[bone].inverted() @ Vector(world_offset)
    # Character faces -Y, left is +X, up +Z.
    # P(d): pitch about X; a downward bone swings its tip FORWARD (toward -Y) for +d.
    # Y(d): yaw about Z.  R(d): roll about Y (side lean).
    P = lambda d: ('X', -d)
    Y = lambda d: ('Z', d)
    R = lambda d: ('Y', d)
    A = lambda v: ('AIM', v)
    def arm_dir(sgn, swing_deg, out_deg=22, lift_deg=0):
        """World direction for an upper arm: hanging down, `out_deg` away from the body, swung
        `swing_deg` forward (-Y) and lifted `lift_deg` toward horizontal-forward."""
        a = math.radians(swing_deg + lift_deg); o = math.radians(out_deg)
        return (sgn * math.sin(o), -math.sin(a) * math.cos(o), -math.cos(a) * math.cos(o))
    def pose(frame, rot=None, loc=None):
        rot = rot or {}; loc = loc or {}
        for pb in arm.pose.bones:
            pb.rotation_quaternion = local_rot(pb.name, rot.get(pb.name, []))
            pb.keyframe_insert('rotation_quaternion', frame=frame)
            if pb.name == 'root':
                pb.location = local_loc('root', loc.get('root', (0, 0, 0)))
                pb.keyframe_insert('location', frame=frame)
    def new_action(name):
        act = bpy.data.actions.new(name)
        adt = arm.animation_data or arm.animation_data_create()
        adt.action = act
        if hasattr(act, 'slots'):
            adt.action_slot = act.slots.new(id_type='OBJECT', name=arm.name)
        return act
    def finish_action(act, frames, loop):
        adt = arm.animation_data
        act.use_frame_range = True; act.frame_start, act.frame_end = 0, frames
        if loop: act.use_cyclic = True
        fcurves = list(act.fcurves) if hasattr(act, 'fcurves') else [fc for ly in act.layers for st in ly.strips for cb in st.channelbags for fc in cb.fcurves]
        for fc in fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = 'BEZIER'; kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'
        track = adt.nla_tracks.new(); track.name = act.name
        strip = track.strips.new(act.name, 0, act)
        try: strip.action_slot = adt.action_slot
        except Exception: pass
        strip.name = act.name; adt.action = None
    def merge(*ds):
        out = {}
        for d in ds:
            for k, v in d.items(): out[k] = out.get(k, []) + v
        return out
    LEG = 0.55 if STUBBY else 1.0
    def gait(t, thigh_amp, shin_amp, arm_amp):
        sL = math.sin(2 * math.pi * t); sR = math.sin(2 * math.pi * (t + 0.5))
        liftL = max(0.0, math.sin(2 * math.pi * t + 0.9)); liftR = max(0.0, math.sin(2 * math.pi * (t + 0.5) + 0.9))
        return {
            'thigh_L': [P(thigh_amp * LEG * sL)], 'shin_L': [P(-shin_amp * LEG * liftL)], 'foot_L': [P(shin_amp * 0.4 * LEG * liftL)],
            'thigh_R': [P(thigh_amp * LEG * sR)], 'shin_R': [P(-shin_amp * LEG * liftR)], 'foot_R': [P(shin_amp * 0.4 * LEG * liftR)],
            'upperarm_L': [A(arm_dir(+1, -arm_amp * sL))], 'upperarm_R': [A(arm_dir(-1, -arm_amp * sR))],
            'forearm_L': [P(arm_amp * 0.6 * max(0, -sL) + 8)], 'forearm_R': [P(arm_amp * 0.6 * max(0, -sR) + 8)],
            'hips': [R(3 * sL)], 'spine': [R(-2 * sL)], 'chest': [Y(-4 * sL)], 'head': [Y(2 * sL)],
        }
    clips = []

    # Idle: breathing, slight sway, head look. 2.4 s loop.
    act = new_action('Idle'); F = 72
    for f in range(0, F + 1, 6):
        t = f / F; br = math.sin(2 * math.pi * t)
        pose(f, merge(
            {'chest': [P(1.5 * br)], 'spine': [P(-1.0 * br)], 'neck': [P(-1.0 * br)]},
            {'head': [Y(6 * math.sin(2 * math.pi * t + 1.0)), P(1.5 * br)]},
            {'upperarm_L': [A(arm_dir(+1, 0, 22 + 2 * br))], 'upperarm_R': [A(arm_dir(-1, 0, 22 + 2 * br))], 'forearm_L': [P(6)], 'forearm_R': [P(6)]},
            {'hips': [R(1.2 * math.sin(2 * math.pi * t + 0.5))]},
        ), loc={'root': (0, 0, 0.01 * H * br)} if HOVER else None)
    finish_action(act, F, True); clips.append('Idle')

    # Walk: 1.0 s loop.
    act = new_action('Walk'); F = 30
    for f in range(0, F + 1, 3):
        t = f / F
        bob = 0.015 * H * abs(math.sin(2 * math.pi * 2 * t))
        if HOVER:
            pose(f, {'chest': [P(6)], 'hips': [R(4 * math.sin(2 * math.pi * t))]}, loc={'root': (0, 0, 0.02 * H * math.sin(2 * math.pi * t))})
        else:
            pose(f, merge(gait(t, 26, 34, 18), {'chest': [P(3)]}), loc={'root': (0, 0, bob)})
    finish_action(act, F, True); clips.append('Walk')

    # Run: 0.6 s loop, forward lean and bigger bounce.
    act = new_action('Run'); F = 18
    for f in range(0, F + 1, 3):
        t = f / F
        bob = 0.035 * H * abs(math.sin(2 * math.pi * 2 * t))
        if HOVER:
            pose(f, {'chest': [P(14)], 'hips': [R(8 * math.sin(2 * math.pi * t))]}, loc={'root': (0, 0, 0.03 * H * math.sin(2 * math.pi * 2 * t))})
        else:
            pose(f, merge(gait(t, 44, 62, 34), {'chest': [P(10)], 'spine': [P(5)], 'head': [P(-6)]}), loc={'root': (0, 0, bob)})
    finish_action(act, F, True); clips.append('Run')

    # Attack: melee swing with the right arm (raise, chop, recover). 0.6 s.
    act = new_action('Attack'); F = 18
    keys = {
        0: {},
        5: {'upperarm_R': [A((-0.35, 0.25, 0.9))], 'forearm_R': [P(-40)], 'upperarm_L': [A(arm_dir(+1, 20, 35))], 'chest': [Y(18), P(-4)], 'spine': [Y(8)], 'head': [Y(-10)]},
        9: merge({'upperarm_R': [A((-0.2, -0.95, -0.2))], 'forearm_R': [P(-15)], 'upperarm_L': [A(arm_dir(+1, -20, 35))], 'chest': [Y(-22), P(12)], 'spine': [Y(-10), P(6)], 'head': [Y(8), P(-8)], 'hips': [Y(-6)]},
                 {'thigh_L': [P(14 * LEG)], 'thigh_R': [P(-10 * LEG)], 'shin_L': [P(-14 * LEG)]}),
        13: merge({'upperarm_R': [A((-0.25, -0.7, -0.65))], 'forearm_R': [P(-10)], 'chest': [Y(-10), P(6)], 'spine': [Y(-4)]}, {'thigh_L': [P(8 * LEG)], 'shin_L': [P(-8 * LEG)]}),
        18: {},
    }
    for f, r in keys.items(): pose(f, r)
    finish_action(act, F, False); clips.append('Attack')

    # Shoot: aim pose with both arms, recoil kick, settle. 0.5 s.
    act = new_action('Shoot'); F = 15
    aim = {'upperarm_R': [A((-0.15, -0.95, -0.15))], 'forearm_R': [P(12)], 'upperarm_L': [A((0.05, -0.9, -0.35))], 'forearm_L': [P(35), Y(-15)], 'chest': [Y(-10)], 'head': [Y(8)]}
    keys = {
        0: aim,
        3: merge({'upperarm_R': [A((-0.15, -0.85, 0.05))], 'forearm_R': [P(30)], 'upperarm_L': [A((0.05, -0.85, -0.25))], 'forearm_L': [P(40), Y(-15)], 'chest': [Y(-10), P(-5)], 'head': [Y(8), P(-3)]}),
        7: merge(aim, {'chest': [P(-2)]}),
        15: aim,
    }
    for f, r in keys.items(): pose(f, r)
    finish_action(act, F, False); clips.append('Shoot')

    # Hit: flinch back. 0.4 s.
    act = new_action('Hit'); F = 12
    keys = {0: {}, 3: {'chest': [P(-16), Y(10)], 'spine': [P(-8)], 'head': [P(-14)], 'upperarm_L': [A(arm_dir(+1, -30, 40))], 'upperarm_R': [A(arm_dir(-1, -30, 40))]}, 7: {'chest': [P(-6)], 'head': [P(-5)]}, 12: {}}
    for f, r in keys.items(): pose(f, r)
    finish_action(act, F, False); clips.append('Hit')

    # Death: stagger, knees buckle, fall onto the back. 1.2 s.
    act = new_action('Death'); F = 36
    def death(f):
        if f <= 8:
            k = f / 8
            return dict(loc=(0, 0, -0.03 * H * k), rot={'chest': [P(-14 * k)], 'head': [P(-18 * k)], 'upperarm_L': [A(arm_dir(+1, 30 * k, 30))], 'upperarm_R': [A(arm_dir(-1, 30 * k, 30))],
                                                        'thigh_L': [P(-10 * k * LEG)], 'thigh_R': [P(-10 * k * LEG)], 'shin_L': [P(-30 * k * LEG)], 'shin_R': [P(-30 * k * LEG)]})
        if f <= 24:
            k = (f - 8) / 16; e = math.sin(k * math.pi / 2)
            return dict(loc=(0, 0.35 * H * e, -0.03 * H - (z_hips - 0.12 * H) * e), rot={
                'hips': [P(-88 * e)], 'chest': [P(-14 + 8 * e)], 'head': [P(-18 + 10 * e)], 'upperarm_L': [A((0.7, -0.3 + 0.2 * e, -0.3 + 0.9 * e))], 'upperarm_R': [A((-0.7, -0.3 + 0.2 * e, -0.3 + 0.9 * e))],
                'thigh_L': [P(-10 * LEG + 45 * e)], 'thigh_R': [P(-10 * LEG + 35 * e)], 'shin_L': [P(-30 * LEG - 20 * e)], 'shin_R': [P(-30 * LEG - 30 * e)]})
        k = (f - 24) / 12
        return dict(loc=(0, 0.35 * H, -0.03 * H - (z_hips - 0.12 * H) - 0.02 * H * k), rot={
            'hips': [P(-88 - 2 * k)], 'chest': [P(-6 - 4 * k)], 'head': [P(-8 + 12 * k)], 'upperarm_L': [A((0.8, -0.1, 0.55))], 'upperarm_R': [A((-0.8, -0.1, 0.55))],
            'thigh_L': [P(35 - 10 * k)], 'thigh_R': [P(25)], 'shin_L': [P(-50 + 20 * k)], 'shin_R': [P(-60 + 20 * k)]})
    for f in (0, 4, 8, 12, 16, 20, 24, 28, 32, 36):
        d = death(f); pose(f, d['rot'], loc={'root': d['loc']})
    finish_action(act, F, False); clips.append('Death')

    adt = arm.animation_data
    for tr in list(adt.nla_tracks):
        if tr.name not in CLIPS: adt.nla_tracks.remove(tr)
    for a in list(bpy.data.actions):
        if a.name not in CLIPS: bpy.data.actions.remove(a)
    clips = [c for c in clips if c in CLIPS]
    log('clips', clips)

    # 8. export
    for o in bpy.data.objects: o.select_set(True)
    want = dict(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True,
                export_skins=True, export_animations=True, export_animation_mode='NLA_TRACKS',
                export_force_sampling=True, export_frame_range=False, export_optimize_animation_size=False,
                export_anim_single_armature=True, export_reset_pose_bones=True, export_bake_animation=True,
                export_materials='EXPORT', export_image_format='AUTO', export_texcoords=True, export_normals=True,
                export_def_bones=False, export_rest_position_armature=True, use_selection=False)
    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    kw = {k: v for k, v in want.items() if k in props}
    bpy.ops.export_scene.gltf(**kw)
    log('exported', OUT, os.path.getsize(OUT), 'bytes')
    log('DONE')
except Exception:
    log('TRACEBACK ' + traceback.format_exc())
    raise
