/**
 * Compress GLB models that bypassed the AssetFactory pipeline.
 *
 *   node tools/compress-models.mjs --check                 list models missing Draco/WebP
 *   node tools/compress-models.mjs <name> [...]            compress by basename (no .glb)
 *   node tools/compress-models.mjs --all                   compress everything --check reports
 *
 * Options: --res <px>   texture size (default 1024; 2048 for player characters)
 *          --dry        report projected sizes without writing
 *
 * Originals are copied to AssetFactory/glb_precompress/ before the first write.
 * Applies the same transforms as AssetFactory/scripts/optimize-single.mjs:
 * prune, dedup, WebP textures, Draco geometry.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, textureCompress, prune, draco, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import draco3d from 'draco3dgltf';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'Game3DAssets');
const BACKUP = path.join(ROOT, 'AssetFactory', 'glb_precompress');

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const MB = (b) => (b / 1048576).toFixed(2);

// Read a GLB's JSON chunk without a full parse — fast enough to scan the folder.
function peek(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546C67) return null; // not a GLB
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.slice(20, 20 + len).toString('utf8'));
  const ext = json.extensionsUsed || [];
  // Older pipeline output embeds WebP without declaring EXT_texture_webp, so
  // trust the image mimeTypes rather than the extension list.
  return {
    size: b.length,
    draco: ext.includes('KHR_draco_mesh_compression'),
    pngBytes: (json.images || []).reduce((n, im) =>
      im.mimeType === 'image/png' && im.bufferView != null
        ? n + json.bufferViews[im.bufferView].byteLength : n, 0),
  };
}

// Needs work if geometry is uncompressed or textures are still PNG.
function scan() {
  return fs.readdirSync(ASSETS).filter(f => f.endsWith('.glb')).map(f => {
    const info = peek(path.join(ASSETS, f));
    return info && { name: f.replace(/\.glb$/, ''), ...info };
  }).filter(m => m && (!m.draco || m.pngBytes > 0)).sort((a, b) => b.size - a.size);
}

async function main() {
  if (flag('check')) {
    const m = scan();
    if (!m.length) { console.log('All GLBs are compressed.'); return; }
    let t = 0;
    console.log(`${m.length} model(s) missing compression:\n`);
    for (const x of m) {
      t += x.size;
      console.log(`  ${x.name.padEnd(40)} ${MB(x.size).padStart(7)} MB  ` +
        `draco=${x.draco ? 'yes' : 'NO '}  png=${MB(x.pngBytes)} MB`);
    }
    console.log(`\n  total ${MB(t)} MB — run with --all to compress`);
    return;
  }

  const names = flag('all')
    ? scan().map(m => m.name)
    : args.filter((a, i) => !a.startsWith('--') && !['--res', '--simplify'].includes(args[i - 1]));

  if (!names.length) { console.error('Nothing to do. Use --check, --all, or name models.'); process.exit(1); }

  const res = parseInt(opt('res', '1024'), 10);
  const ratio = parseFloat(opt('simplify', '0'));
  const dry = flag('dry');
  fs.mkdirSync(BACKUP, { recursive: true });

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

  let before = 0, after = 0;
  for (const name of names) {
    const file = path.join(ASSETS, name + '.glb');
    if (!fs.existsSync(file)) { console.error(`  ${name}: not found`); continue; }

    const backup = path.join(BACKUP, name + '.glb');
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);

    const inSize = fs.statSync(backup).size;
    // Always read the pristine original so re-runs don't stack lossy passes.
    const doc = await io.read(backup);
    const steps = [prune(), dedup()];
    if (ratio > 0 && ratio < 1) {
      // weld first: Trellis meshes carry split vertices that stop the simplifier
      // collapsing anything. error is generous because these are viewed from a
      // top-down gameplay camera, not inspected up close.
      steps.push(weld({ tolerance: 0.0001 }));
      steps.push(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 }));
    }
    steps.push(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [res, res] }));
    steps.push(draco());
    await doc.transform(...steps);

    const out = dry ? path.join(BACKUP, '_dry_' + name + '.glb') : file;
    await io.write(out, doc);
    const outSize = fs.statSync(out).size;
    if (dry) fs.unlinkSync(out);

    before += inSize; after += outSize;
    console.log(`  ${name.padEnd(40)} ${MB(inSize).padStart(7)} -> ${MB(outSize).padStart(6)} MB  ` +
      `(${((1 - outSize / inSize) * 100).toFixed(1)}% smaller)`);
  }

  console.log(`\n  ${dry ? '[dry run] ' : ''}total ${MB(before)} MB -> ${MB(after)} MB  ` +
    `(saved ${MB(before - after)} MB, ${((1 - after / before) * 100).toFixed(1)}%)`);
  if (!dry) console.log(`  originals in ${path.relative(ROOT, BACKUP)}/`);
}

main().catch(e => { console.error(e); process.exit(1); });
