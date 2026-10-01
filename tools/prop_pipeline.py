"""
Watch art/images/props for new PNGs and push each through Trellis -> optimize -> assets/models/props.

  python tools/prop_pipeline.py [--once] [--poll 20]

Log: tools/reports/prop_pipeline.log. A file is done when assets/models/props/<name>.glb exists.
"""
import os, sys, time, subprocess, shutil
sys.path.insert(0, os.path.dirname(__file__))
import trellis

IMG = 'art/images/props'; RAW = 'art/raw_glb/props'; OUT = 'assets/models/props'
os.makedirs(IMG, exist_ok=True); os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
LOG = open('tools/reports/prop_pipeline.log', 'a', encoding='utf-8')
def log(*a):
    s = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + '\n'); LOG.flush()

once = '--once' in sys.argv
poll = int(sys.argv[sys.argv.index('--poll') + 1]) if '--poll' in sys.argv else 20
client = None
while True:
    todo = [f for f in sorted(os.listdir(IMG)) if f.lower().endswith('.png') and not os.path.exists(os.path.join(OUT, os.path.splitext(f)[0] + '.glb'))]
    for f in todo:
        name = os.path.splitext(f)[0]
        raw = os.path.join(RAW, name + '.glb'); out = os.path.join(OUT, name + '.glb')
        # Skip files still being written.
        if time.time() - os.path.getmtime(os.path.join(IMG, f)) < 5: continue
        if not os.path.exists(raw):
            if client is None: client = trellis.make_client()
            log('trellis', name)
            ok = trellis.generate(client, os.path.join(IMG, f), raw, '1024', 100000, 2048, 0)
            if not ok: log('FAILED', name); continue
        log('optimize', name)
        r = subprocess.run(['node', 'tools/optimize-glb.mjs', raw, out, '--res', '1024', '--ratio', '0.18'], capture_output=True, text=True)
        log(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-300:])
    if once: break
    time.sleep(poll)
