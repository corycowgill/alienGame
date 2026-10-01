"""
Image -> GLB via the microsoft/TRELLIS.2 Hugging Face Space (ZeroGPU) using gradio_client.

  python tools/trellis.py <image.png> <out.glb> [--res 1024] [--faces 100000] [--tex 2048] [--seed N]
  python tools/trellis.py --batch <dir_of_pngs> <out_dir> [same options]

Session flow (from the Space API): /start_session -> /preprocess_image -> /image_to_3d -> /extract_glb.
Skips outputs that already exist. Respects the Space's rate limits: on a quota error it waits and
retries rather than hammering the endpoint.
"""
import sys, os, time, shutil, json, argparse, traceback
from gradio_client import Client, handle_file

TOKEN_PATH = os.path.expanduser('~/.cache/huggingface/token')
SPACE = 'microsoft/TRELLIS.2'

def token():
    t = os.environ.get('HF_TOKEN')
    if t: return t
    with open(TOKEN_PATH) as f: return f.read().strip()

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def make_client():
    return Client(SPACE, token=token(), verbose=False)

def generate(client, image_path, out_glb, res='1024', faces=60000, tex=2048, seed=0, retries=4):
    for attempt in range(1, retries + 1):
        try:
            client.predict(api_name='/start_session')
            log('preprocess', os.path.basename(image_path))
            client.predict(input=handle_file(image_path), api_name='/preprocess_image')
            log('image_to_3d res', res, 'seed', seed)
            t0 = time.time()
            client.predict(
                image=handle_file(image_path), seed=seed, resolution=str(res),
                ss_guidance_strength=7.5, ss_guidance_rescale=0.7, ss_sampling_steps=12, ss_rescale_t=5.0,
                shape_slat_guidance_strength=7.5, shape_slat_guidance_rescale=0.5, shape_slat_sampling_steps=12, shape_slat_rescale_t=3.0,
                tex_slat_guidance_strength=1.0, tex_slat_guidance_rescale=0.0, tex_slat_sampling_steps=12, tex_slat_rescale_t=3.0,
                api_name='/image_to_3d')
            log('  generated in %.0fs, extracting glb faces=%d tex=%d' % (time.time() - t0, faces, tex))
            glb, _dl = client.predict(decimation_target=faces, texture_size=tex, api_name='/extract_glb')
            os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
            shutil.copyfile(glb, out_glb)
            log('  wrote', out_glb, '%.1f MB' % (os.path.getsize(out_glb) / 1e6))
            return True
        except Exception as e:
            msg = str(e)
            log('  attempt', attempt, 'failed:', msg[:300])
            # ZeroGPU quota / rate limit -> back off politely
            wait = 90 * attempt
            if 'quota' in msg.lower() or 'gpu' in msg.lower() or 'exceeded' in msg.lower() or 'queue' in msg.lower():
                # try to parse "retry in HH:MM:SS"
                import re
                m = re.search(r'(\d+):(\d+):(\d+)', msg)
                if m:
                    h, mi, s = map(int, m.groups()); wait = h * 3600 + mi * 60 + s + 15
            if attempt < retries:
                log('  waiting %ds before retry' % wait)
                time.sleep(wait)
                try: client = make_client()
                except Exception: pass
    return False

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--batch', action='store_true')
    ap.add_argument('--res', default='1024'); ap.add_argument('--faces', type=int, default=100000)
    ap.add_argument('--tex', type=int, default=2048); ap.add_argument('--seed', type=int, default=0)
    a = ap.parse_args()
    client = make_client()
    if a.batch:
        os.makedirs(a.out, exist_ok=True)
        imgs = sorted(f for f in os.listdir(a.inp) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')))
        ok = 0
        for f in imgs:
            out = os.path.join(a.out, os.path.splitext(f)[0] + '.glb')
            if os.path.exists(out): log('skip (exists)', out); ok += 1; continue
            if generate(client, os.path.join(a.inp, f), out, a.res, a.faces, a.tex, a.seed): ok += 1
            time.sleep(5)
        log('done %d/%d' % (ok, len(imgs)))
    else:
        sys.exit(0 if generate(client, a.inp, a.out, a.res, a.faces, a.tex, a.seed) else 1)

if __name__ == '__main__':
    main()
