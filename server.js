const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const PORT = 5000;

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dwkutkyqd';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '448394361211235';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'UV4brna4meM0I5uZ_UG_U7pJz4Q';

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
let totalRequests = 0;
let pulseRequests = 0;
let lastPulseAt = Date.now();

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  totalRequests += 1;
  pulseRequests += 1;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Endpoint para firmar uploads de Cloudinary
  if (req.method === 'POST' && req.url === '/api/cloudinary-sign') {
    try {
      const body = await parseBody(req);
      const timestamp = body.timestamp || Math.floor(Date.now() / 1000);
      const paramsToSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
      const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        signature,
        api_key: CLOUDINARY_API_KEY,
        cloud_name: CLOUDINARY_CLOUD_NAME,
        timestamp
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Error al generar firma' }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.split('?')[0] === '/api/neuro/telemetry') {
    const startedAt = process.hrtime.bigint();
    const memory = process.memoryUsage();
    const now = Date.now();
    const intervalSeconds = Math.max((now - lastPulseAt) / 1000, 0.001);
    const requestRate = pulseRequests / intervalSeconds;
    const eventLoop = typeof performance.eventLoopUtilization === 'function'
      ? performance.eventLoopUtilization().utilization
      : null;

    pulseRequests = 0;
    lastPulseAt = now;

    const responseTimeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const payload = {
      source: 'node-runtime',
      scope: 'server-runtime',
      generatedAt: new Date(now).toISOString(),
      telemetry: {
        neuralLoad: Number(((memory.heapUsed / Math.max(memory.heapTotal, 1)) * 100).toFixed(1)),
        signalVelocity: Number(requestRate.toFixed(2)),
        activeSynapses: totalRequests,
        uplinkLatency: Number(responseTimeMs.toFixed(2)),
        queueDepth: activeSockets,
        memoryFlux: Number((memory.rss / 1024 / 1024).toFixed(1)),
        coreTemp: 'n/a',
        openStreams: activeSockets,
        pulseRate: Number(requestRate.toFixed(2)),
        driftIndex: eventLoop === null ? 'n/a' : Number(eventLoop.toFixed(3))
      },
      runtime: {
        uptimeSeconds: Number(process.uptime().toFixed(1)),
        heapUsedBytes: memory.heapUsed,
        rssBytes: memory.rss,
        activeSockets
      }
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
    return;
  }

  let urlPath = req.url.split('?')[0];

  if (urlPath === '/') {
    urlPath = '/index.html';
  }

  const filePath = path.join(__dirname, urlPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const notFound = path.join(__dirname, '404.html');
      fs.readFile(notFound, (e, data) => {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(e ? '<h1>404 Not Found</h1>' : data);
      });
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
