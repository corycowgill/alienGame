/**
 * Stage the newest reference image out of Downloads into art/images/props_chicago.
 *
 * Chrome will not overwrite an existing download, it suffixes " (1)" - which silently
 * staged a stale period-Chicago building the first time round. So this ignores the
 * filename the browser chose and takes the most recently written matching PNG instead.
 *
 *   node tools/stage-ref.mjs <assetName> [--pattern cyb_]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const name = args[0];
const pat = args.indexOf('--pattern') >= 0 ? args[args.indexOf('--pattern') + 1] : 'cyb_';
const DL = 'C:/Users/coryc/Downloads';
const OUT = 'C:/Users/coryc/alienGame/art/images/props_chicago';

const cands = fs.readdirSync(DL)
  .filter((f) => f.toLowerCase().endsWith('.png') && f.startsWith(pat))
  .map((f) => ({ f, t: fs.statSync(path.join(DL, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

if (!cands.length) { console.error('no download matching ' + pat); process.exit(1); }
const src = path.join(DL, cands[0].f);
const age = (Date.now() - cands[0].t) / 1000;
if (age > 600) { console.error('newest match is ' + Math.round(age) + 's old - refusing stale file: ' + cands[0].f); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });
const dst = path.join(OUT, name + '.png');
await sharp(src).resize(1024, 1024, { fit: 'cover' }).png().toFile(dst);
fs.unlinkSync(src);   // consumed, so the next run cannot pick it up again
console.log('staged ' + name + '  <- ' + cands[0].f + '  (' + Math.round(age) + 's old)');
