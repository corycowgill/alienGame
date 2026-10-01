"""
Image -> textured GLB via the tencent/Hunyuan3D-2.1 Hugging Face Space (ZeroGPU).

Replaces tools/trellis.py for new assets. microsoft/TRELLIS.2 still *generates* fine but its
/extract_glb endpoint returns a bare server-side RuntimeError at every decimation_target
(100k/150k/300k, all inside the advertised 100000-500000 range), so nothing can be exported
from it. Verified 2026-10-01. Keep trellis.py for reference and for re-running the old assets
if the Space is repaired.

Hunyuan3D-2.1 is also a better fit here: /generation_all returns an already-textured mesh at
~40k triangles in ~150s, which is close to the budget rebuild-assets.mjs wants anyway.

  python tools/hunyuan.py <image.png> <out.glb> [--steps 30] [--octree 256] [--seed 1234]
  python tools/hunyuan.py --batch <dir_of_pngs> <out_dir> [same options]

Skips outputs that already exist, so a run interrupted by a ZeroGPU quota error can simply be
re-run. On a quota error it waits out the stated retry window rather than hammering the Space.
"""
import sys, os, time, shutil, argparse, re

from gradio_client import Client, handle_file

TOKEN_PATH = os.path.expanduser('~/.cache/huggingface/token')
SPACE = 'tencent/Hunyuan3D-2.1'


def token():
    t = os.environ.get('HF_TOKEN')
    if t:
        return t
    with open(TOKEN_PATH) as f:
        return f.read().strip()


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def make_client():
    return Client(SPACE, token=token(), verbose=False)


def _path_of(item):
    """/generation_all returns gradio update dicts, not plain paths."""
    if isinstance(item, dict):
        return item.get('value')
    return item if isinstance(item, str) else None


def generate(client, image_path, out_glb, steps=30, octree=256, seed=1234, retries=4):
    for attempt in range(1, retries + 1):
        try:
            log('generate', os.path.basename(image_path), 'steps', steps, 'octree', octree)
            t0 = time.time()
            res = client.predict(
                image=handle_file(image_path),
                mv_image_front=None, mv_image_back=None, mv_image_left=None, mv_image_right=None,
                steps=steps, guidance_scale=5.0, seed=seed, octree_resolution=octree,
                check_box_rembg=True, num_chunks=8000, randomize_seed=False,
                api_name='/generation_all')
            # Returns (white_mesh.obj, textured_mesh.glb, html, stats, seed) - we want the textured one.
            glb = None
            for item in (res if isinstance(res, (list, tuple)) else [res]):
                p = _path_of(item)
                if p and p.lower().endswith('.glb'):
                    glb = p
            if not glb or not os.path.exists(glb):
                raise RuntimeError('no .glb in response: ' + str(res)[:200])
            os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
            shutil.copyfile(glb, out_glb)
            log('  wrote %s  %.1f MB  in %.0fs' % (out_glb, os.path.getsize(out_glb) / 1e6, time.time() - t0))
            return True
        except Exception as e:
            msg = str(e)
            log('  attempt', attempt, 'failed:', msg[:300])
            wait = 90 * attempt
            low = msg.lower()
            if any(k in low for k in ('quota', 'gpu', 'exceeded', 'queue')):
                m = re.search(r'(\d+):(\d+):(\d+)', msg)
                if m:
                    h, mi, s = map(int, m.groups())
                    wait = h * 3600 + mi * 60 + s + 15
            if attempt < retries:
                log('  waiting %ds before retry' % wait)
                time.sleep(wait)
                try:
                    client = make_client()
                except Exception:
                    pass
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp')
    ap.add_argument('out')
    ap.add_argument('--batch', action='store_true')
    ap.add_argument('--steps', type=int, default=30)
    ap.add_argument('--octree', type=int, default=256)
    ap.add_argument('--seed', type=int, default=1234)
    a = ap.parse_args()

    client = make_client()
    if a.batch:
        os.makedirs(a.out, exist_ok=True)
        imgs = sorted(f for f in os.listdir(a.inp) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')))
        ok = 0
        for f in imgs:
            out = os.path.join(a.out, os.path.splitext(f)[0] + '.glb')
            if os.path.exists(out):
                log('skip (exists)', out)
                ok += 1
                continue
            if generate(client, os.path.join(a.inp, f), out, a.steps, a.octree, a.seed):
                ok += 1
            time.sleep(5)
        log('done %d/%d' % (ok, len(imgs)))
        sys.exit(0 if ok == len(imgs) else 1)
    else:
        sys.exit(0 if generate(client, a.inp, a.out, a.steps, a.octree, a.seed) else 1)


if __name__ == '__main__':
    main()
