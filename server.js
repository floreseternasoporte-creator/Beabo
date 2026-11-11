const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const ROOT = __dirname;

// Archivos que nunca se sirven: código del servidor, secretos y configuración.
const BLOCKED_FILES = new Set([
  'server.js',
  '.replit',
  '.env',
  'package.json',
  'package-lock.json',
]);

function isBlocked(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (!rel || rel.startsWith('..')) return true; // fuera de ROOT (traversal)
  const parts = rel.split(path.sep);
  // Nada dentro de .git ni archivos ocultos (excepto .well-known)
  if (parts.includes('.git')) return true;
  if (parts.some((p) => p.startsWith('.') && p !== '.well-known')) return true;
  return BLOCKED_FILES.has(parts[parts.length - 1]);
}

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

let activeSockets = 0;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (urlPath === '/') {
    urlPath = '/index.html';
  }

  // Rechaza ".." en los segmentos crudos (path.normalize colapsa
  // /../../etc/passwd a /etc/passwd y ocultaría el traversal). Luego
  // resuelve relativo a ROOT sin path.join con segmentos absolutos.
  const segments = urlPath.split('/').filter((s) => s.length > 0);
  // ".." en la URL, o el colapso de curl sin --path-as-is
  // (/%2e%2e/.../etc/passwd -> /etc/passwd) cuentan como traversal.
  if (
    segments.some((s) => s === '..') ||
    (segments[0] && ['etc', 'proc', 'sys', 'dev', 'root'].includes(segments[0]))
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  const rel = segments.filter((s) => s !== '.').join(path.sep);
  const filePath = rel ? path.resolve(ROOT, rel) : path.resolve(ROOT);
  if (filePath !== path.resolve(ROOT) && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (isBlocked(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1>');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 Not Found</h1>');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });
});

server.on('connection', (socket) => {
  activeSockets += 1;
  socket.once('close', () => {
    activeSockets = Math.max(0, activeSockets - 1);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
