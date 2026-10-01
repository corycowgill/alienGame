// Tiny local receiver: the browser POSTs an image blob here and it lands in art/images/<name>.
// node tools/receiver.mjs   (listens on 127.0.0.1:8765)
import http from 'http'; import fs from 'fs'; import path from 'path';
const DIR = path.resolve('art/images'); fs.mkdirSync(DIR, { recursive: true });
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, 'http://x'); const name = (u.searchParams.get('name') || 'img.png').replace(/[^a-zA-Z0-9_.-]/g, '_');
  if (req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const buf = Buffer.concat(chunks); const out = path.join(DIR, name); fs.writeFileSync(out, buf);
      console.log('saved', out, buf.length); res.writeHead(200); res.end(JSON.stringify({ ok: true, bytes: buf.length, name }));
    }); return;
  }
  res.writeHead(200); res.end('receiver up');
}).listen(8765, '127.0.0.1', () => console.log('receiver on http://127.0.0.1:8765'));
