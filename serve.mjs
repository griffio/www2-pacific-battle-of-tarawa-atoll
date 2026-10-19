// Minimal static server. `node serve.mjs` → http://localhost:8080
// `node serve.mjs --https` serves HTTPS with a self-signed cert (needed for WebGPU on an iPad over the LAN).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const useHttps = process.argv.includes('--https');
const port = +(process.env.PORT || (useHttps ? 8443 : 8080));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

function handler(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

let server;
if (useHttps) {
  const dir = path.join(os.tmpdir(), 'tarawa-cert');
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key)) {
    fs.mkdirSync(dir, { recursive: true });
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 365 -subj "/CN=tarawa.local"`, { stdio: 'ignore' });
  }
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
} else server = http.createServer(handler);

server.listen(port, '0.0.0.0', () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`Tarawa 1943 → ${proto}://localhost:${port}`);
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || [])
    if (i.family === 'IPv4' && !i.internal) console.log(`           ${proto}://${i.address}:${port}${useHttps ? '' : '   (iPad needs --https for WebGPU)'}`);
});
