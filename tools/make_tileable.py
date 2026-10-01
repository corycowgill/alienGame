"""
Turn a ChatGPT texture into a seamless tile: offset by half, cross-fade the seams, resize, save JPG.

  python tools/make_tileable.py art/images/tex_asphalt.png assets/textures/asphalt.jpg [--size 1024] [--blend 0.12]
"""
import sys
from PIL import Image, ImageChops
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
size = int(sys.argv[sys.argv.index('--size') + 1]) if '--size' in sys.argv else 1024
blend = float(sys.argv[sys.argv.index('--blend') + 1]) if '--blend' in sys.argv else 0.12

im = Image.open(src).convert('RGB').resize((size, size), Image.LANCZOS)
a = np.asarray(im).astype(np.float32)
# Offset by half so the original edges meet in the middle, then blend a band across that seam
# using the un-offset image (whose middle is continuous).
off = np.roll(np.roll(a, size // 2, axis=0), size // 2, axis=1)
w = int(size * blend)
out = off.copy()
# vertical seam at x = size/2 and horizontal seam at y = size/2
for axis in (0, 1):
    ramp = np.linspace(0, 1, w * 2, dtype=np.float32)
    ramp = (1 - np.cos(ramp * np.pi)) / 2  # smoothstep
    lo = size // 2 - w
    if axis == 1:
        band = a[:, lo:lo + 2 * w]  # continuous middle of the original
        k = ramp[None, :, None]
        out[:, lo:lo + 2 * w] = out[:, lo:lo + 2 * w] * (1 - (1 - np.abs(2 * ramp - 1))[None, :, None]) + band * (1 - np.abs(2 * ramp - 1))[None, :, None]
    else:
        band = a[lo:lo + 2 * w, :]
        out[lo:lo + 2 * w, :] = out[lo:lo + 2 * w, :] * (1 - (1 - np.abs(2 * ramp - 1))[:, None, None]) + band * (1 - np.abs(2 * ramp - 1))[:, None, None]
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(dst, quality=90)
print('wrote', dst, size, 'x', size)
