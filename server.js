const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || 'http://localhost:5000';
const OPENROUTER_APP_TITLE = process.env.OPENROUTER_APP_TITLE || 'Drex';

const MAX_AI_MESSAGES = 14;
const MAX_AI_CONTENT_CHARS = 6000;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}


function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sanitizeAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-MAX_AI_MESSAGES)
    .map((message) => ({
      role: ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'user',
      content: `${message?.content ?? ''}`.slice(0, MAX_AI_CONTENT_CHARS)
    }))
    .filter(message => message.content.trim());
}

function requestJson(options, payload) {
  return new Promise((resolve, reject) => {
    const externalReq = https.request(options, (externalRes) => {
      let body = '';
      externalRes.on('data', chunk => { body += chunk.toString(); });
      externalRes.on('end', () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${body.slice(0, 160)}`));
          return;
        }
        resolve({ statusCode: externalRes.statusCode || 500, body: parsed });
      });
    });

    externalReq.on('error', reject);
    externalReq.write(payload);
    externalReq.end();
  });
}

async function handleAiRequest(req, res) {
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 503, {
      error: 'AI service is not configured',
      details: 'Configura OPENROUTER_API_KEY con una clave gratuita de OpenRouter para usar modelos gratis.'
    });
    return;
  }

  const body = await readBody(req);
  const input = JSON.parse(body || '{}');
  const messages = sanitizeAiMessages(input.messages);

  if (!messages.length) {
    sendJson(res, 400, { error: 'messages are required' });
    return;
  }

  const payload = JSON.stringify({
    model: input.model || OPENROUTER_MODEL,
    messages,
    temperature: typeof input.temperature === 'number' ? input.temperature : 0.4,
    max_tokens: typeof input.max_tokens === 'number' ? input.max_tokens : 900
  });

  const { statusCode, body: aiBody } = await requestJson({
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'HTTP-Referer': OPENROUTER_REFERER,
      'X-Title': OPENROUTER_APP_TITLE
    }
  }, payload);

  if (statusCode < 200 || statusCode >= 300) {
    console.error('OpenRouter error:', statusCode, aiBody);
    sendJson(res, 502, { error: 'AI provider error', status: statusCode });
    return;
  }

  const reply = aiBody?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    sendJson(res, 502, { error: 'AI provider returned an empty response' });
    return;
  }

  sendJson(res, 200, { reply: reply.trim(), model: aiBody?.model || input.model || OPENROUTER_MODEL });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai') {
    try {
      await handleAiRequest(req, res);
    } catch (err) {
      console.error('AI handler error:', err);
      sendJson(res, 500, { error: 'Internal AI server error' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/tts') {
    try {
      const body = await readBody(req);
      const { text } = JSON.parse(body);
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text is required' }));
        return;
      }

      if (!ELEVENLABS_API_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'TTS service is not configured' }));
        return;
      }

      const payload = JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        output_format: 'mp3_44100_128',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      });

      const options = {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Accept': 'audio/mpeg'
        }
      };

      const elevenReq = https.request(options, (elevenRes) => {
        if (elevenRes.statusCode !== 200) {
          let errBody = '';
          elevenRes.on('data', c => { errBody += c; });
          elevenRes.on('end', () => {
            console.error('ElevenLabs error:', elevenRes.statusCode, errBody);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ElevenLabs error', status: elevenRes.statusCode }));
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' });
        elevenRes.pipe(res);
      });

      elevenReq.on('error', (err) => {
        console.error('ElevenLabs request error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'TTS proxy error' }));
      });

      elevenReq.write(payload);
      elevenReq.end();
    } catch (err) {
      console.error('TTS handler error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
