// Play the game in a real browser: a plain static server for the project root.
//
//   npm run serve            → http://127.0.0.1:8080
//   npm run serve -- 3000    → a different port
//   node tools/serve.mjs --host   → also bind 0.0.0.0 so a phone on the same
//                                   Wi-Fi can open it (prints the LAN URLs)
//
// Add ?debug to the URL for the test hook tools/playtest.mjs drives.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const port = parseInt(args.find(a => /^\d+$/.test(a)) || '8080', 10);
const host = args.includes('--host') ? '0.0.0.0' : '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.css': 'text/css', '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
};

const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  // Never serve outside the project, and never 500 on a directory request
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found: ' + url); return; }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    // The whole point is seeing edits, so nothing is cached
    'Cache-Control': 'no-store',
  });
  // An unhandled stream 'error' takes the whole dev server down mid-playtest. Windows throws
  // EMFILE/EBUSY here when several large GLBs are pulled at once, which showed up as random
  // assets failing to load in bot runs.
  const stream = fs.createReadStream(file);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
});

srv.listen(port, host, () => {
  console.log(`Castle Survivor  →  http://127.0.0.1:${port}/`);
  if (host === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  on this network →  http://${n.address}:${port}/   (phone testing)`);
      }
    }
  }
  console.log(`  test hook       →  http://127.0.0.1:${port}/index.html?debug`);
  console.log('Ctrl-C to stop.');
});
srv.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${port} is already in use — try: npm run serve -- ${port + 1}`); process.exit(1); }
  throw e;
});
