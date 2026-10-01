"""
Convert a black-background decal sheet into an RGBA PNG: alpha comes from brightness (with gain),
so pure black becomes transparent and the artwork keeps its own colours.

  python tools/make_decal.py art/images/decal_scorch.png assets/decals/scorch.png [--size 1024] [--gain 3.0] [--floor 0.06]
"""
import sys
from PIL import Image
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
def opt(k, d): return float(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
size = int(opt('--size', 1024)); gain = opt('--gain', 3.0); floor = opt('--floor', 0.06)
im = Image.open(src).convert('RGB').resize((size, size), Image.LANCZOS)
a = np.asarray(im).astype(np.float32) / 255
lum = a.max(axis=2)
alpha = np.clip((lum - floor) * gain, 0, 1)
# Soft vignette per quadrant so nothing touches the tile borders.
h = size // 2
yy, xx = np.mgrid[0:h, 0:h]
r = np.sqrt(((xx - h / 2) / (h / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
vig = np.clip((1.0 - r) * 3.0, 0, 1)
for qy in (0, 1):
    for qx in (0, 1):
        alpha[qy * h:(qy + 1) * h, qx * h:(qx + 1) * h] *= vig
# Un-premultiply-ish: brighten the colour where alpha is low so thin edges keep their hue.
rgb = a if '--noboost' in sys.argv else np.clip(a / np.maximum(alpha[..., None], 0.35), 0, 1)
out = np.dstack([rgb, alpha])
Image.fromarray((out * 255).astype(np.uint8), 'RGBA').save(dst)
print('wrote', dst, 'alpha coverage %.1f%%' % (100 * (alpha > 0.1).mean()))
