/**
 * Derive an emissive mask from a base-colour texture.
 *
 * The Chicago retrofit art direction paints neon straight into the base colour, which
 * means in-engine it is just a bright stripe of paint: it casts no light, never blooms
 * through the URP post stack, and reads flat against the real lighting. Nothing in the
 * project has an emissive map (see the original asset audit), so there is nothing to
 * feed the bloom.
 *
 * This pulls the lit parts back out. Brightness and saturation alone are not enough:
 * tried that first and the straight period greystone came back with 30.9% of its texels
 * "emitting" - warm brick and lamplit windows are both saturated and bright. The neon in
 * this art direction is specifically cyan and magenta, so the mask also rejects warm hues
 * (roughly 15-70 degrees, where brick, limestone and tungsten window light all sit). The
 * mask keeps the original hue so the glow matches the paint; everything else goes black.
 *
 *   node tools/make-emissive.mjs <baseColor.jpg> <emissive.jpg> [--sat 0.5] [--val 0.45]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? parseFloat(args[i + 1]) : d; };
const [inp, out] = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const MIN_SAT = opt('sat', 0.5);
const MIN_VAL = opt('val', 0.45);

/** Hue in degrees, or -1 for greys. */
function hueOf(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return -1;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
// Warm band: brick, limestone and tungsten window light. Never neon here.
const isWarm = (h) => h >= 15 && h <= 70;

const img = sharp(inp);
const { width, height } = await img.metadata();
const raw = await img.ensureAlpha().raw().toBuffer();

let lit = 0;
for (let i = 0; i < raw.length; i += 4) {
  const r = raw[i] / 255, g = raw[i + 1] / 255, b = raw[i + 2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const hue = hueOf(r, g, b);
  if (sat >= MIN_SAT && max >= MIN_VAL && hue >= 0 && !isWarm(hue)) {
    // Push it up toward full brightness so the bloom has something to work with,
    // keeping the hue the paint already chose.
    const boost = Math.min(1, 0.45 + sat * 0.8);
    raw[i] = Math.min(255, Math.round(r * 255 * boost + 255 * (boost - 0.45)));
    raw[i + 1] = Math.min(255, Math.round(g * 255 * boost + 255 * (boost - 0.45) * 0.6));
    raw[i + 2] = Math.min(255, Math.round(b * 255 * boost + 255 * (boost - 0.45)));
    lit++;
  } else {
    raw[i] = raw[i + 1] = raw[i + 2] = 0;
  }
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
await sharp(raw, { raw: { width, height, channels: 4 } })
  .removeAlpha()
  // A touch of blur: the mask drives bloom, and hard-edged emissive aliases badly
  // once the building is a few metres across on screen.
  .blur(0.6)
  .jpeg({ quality: 85 })
  .toFile(out);

console.log(path.basename(inp) + ' -> ' + path.basename(out) +
  '  ' + (100 * lit / (width * height)).toFixed(1) + '% of texels emit');
