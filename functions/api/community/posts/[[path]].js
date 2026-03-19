const AWS_SERVICE = 's3';
const POSTS_OBJECT_KEY = 'community/posts.json';

export async function onRequest(context) {
  const { request, env } = context;
  const awsConfig = getAwsConfig(env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const tail = parts.slice(4); // /api/community/posts/:id/...

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!isConfigured(awsConfig)) {
      return json({
        error: 'Configuración AWS incompleta',
        detail: 'Define AWS_BUCKET, AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY como variables de entorno en Cloudflare.',
      }, 500);
    }

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'health') {
      const storage = await loadPostsStorage(awsConfig);
      return json({
        ok: true,
        provider: 'amazon-s3',
        bucket: awsConfig.bucket,
        region: awsConfig.region,
        objectKey: POSTS_OBJECT_KEY,
        postsCount: storage.posts.length,
      }, 200);
    }

    if (request.method === 'GET' && tail.length === 0) {
      const requestedLimit = Number(url.searchParams.get('limit') || 50);
      const safeLimit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
      const limit = Math.max(1, Math.min(100, safeLimit));
      const storage = await loadPostsStorage(awsConfig);
      const visiblePosts = storage.posts
        .filter((post) => !post.deleted_at)
        .sort((a, b) => Number(b.created_at_ms || 0) - Number(a.created_at_ms || 0))
        .slice(0, limit)
        .map(storageToApiPost);
      return json({ posts: visiblePosts }, 200);
    }

    if (request.method === 'GET' && tail.length === 1) {
      const id = decodeURIComponent(tail[0] || '').trim();
      if (!id) return json({ error: 'Post ID es obligatorio' }, 400);

      const storage = await loadPostsStorage(awsConfig);
      const row = storage.posts.find((post) => post.id === id && !post.deleted_at);
      if (!row) return json({ error: 'Post no encontrado' }, 404);
      return json({ post: storageToApiPost(row) }, 200);
    }

    if (request.method === 'POST' && tail.length === 0) {
      const body = sanitizePayload(await safeJson(request));
      if (!body.authorId) return json({ error: 'authorId es obligatorio' }, 400);
      if (!body.content && !body.gifUrl && !body.imageUrls.length && !body.poll) {
        return json({ error: 'El post está vacío' }, 400);
      }

      const nowIso = new Date().toISOString();
      const nowMs = Date.now();
      const id = crypto.randomUUID();

      const storage = await loadPostsStorage(awsConfig);
      storage.posts.push({
        id,
        author_id: body.authorId,
        author_name: body.authorName,
        author_image: body.authorImage,
        content: body.content,
        gif_url: body.gifUrl,
        image_url: body.imageUrls[0] || null,
        image_urls_json: JSON.stringify(body.imageUrls),
        poll_json: body.poll ? JSON.stringify(body.poll) : null,
        disclosures_json: JSON.stringify(body.disclosures || { paidPartnership: false, aiGenerated: false }),
        location_name: body.location?.name || null,
        location_lat: Number.isFinite(Number(body.location?.lat)) ? Number(body.location.lat) : null,
        location_lng: Number.isFinite(Number(body.location?.lng)) ? Number(body.location.lng) : null,
        upvotes: 0,
        downvotes: 0,
        comments_count: 0,
        created_at: nowIso,
        created_at_ms: nowMs,
        updated_at: nowIso,
        deleted_at: null,
      });

      await savePostsStorage(awsConfig, storage);
      return json({ id }, 201);
    }

    if (request.method === 'PATCH' && tail.length === 2 && tail[1] === 'comments-count') {
      const id = decodeURIComponent(tail[0] || '').trim();
      if (!id) return json({ error: 'Post ID es obligatorio' }, 400);

      const body = await safeJson(request);
      const commentsCount = Math.max(0, Number(body.commentsCount || 0));

      const storage = await loadPostsStorage(awsConfig);
      const post = storage.posts.find((item) => item.id === id && !item.deleted_at);
      if (!post) return json({ error: 'Post no encontrado' }, 404);

      post.comments_count = commentsCount;
      post.updated_at = new Date().toISOString();
      await savePostsStorage(awsConfig, storage);

      return json({ ok: true }, 200);
    }

    return json({ error: 'Método no soportado' }, 405);
  } catch (error) {
    return json({ error: 'Error interno', detail: String(error?.message || error) }, 500);
  }
}

function getAwsConfig(env = {}) {
  return {
    region: String(env.AWS_REGION || 'us-east-2').trim(),
    bucket: String(env.AWS_BUCKET || '').trim(),
    accessKeyId: String(env.AWS_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.AWS_SECRET_ACCESS_KEY || '').trim(),
  };
}

function isConfigured(config) {
  return config.bucket && config.accessKeyId && config.secretAccessKey;
}

function storageToApiPost(row) {
  const images = parseJsonArray(row.image_urls_json);
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name || 'Usuario',
    authorImage: row.author_image || 'https://via.placeholder.com/150',
    content: row.content || '',
    gifUrl: row.gif_url || null,
    imageUrl: row.image_url || images[0] || null,
    imageUrls: images,
    poll: parseJsonObject(row.poll_json),
    disclosures: parseJsonObject(row.disclosures_json) || { paidPartnership: false, aiGenerated: false },
    location: row.location_name
      ? {
          name: row.location_name,
          lat: Number.isFinite(Number(row.location_lat)) ? Number(row.location_lat) : null,
          lng: Number.isFinite(Number(row.location_lng)) ? Number(row.location_lng) : null,
        }
      : null,
    upvotes: Number(row.upvotes || 0),
    downvotes: Number(row.downvotes || 0),
    commentsCount: Number(row.comments_count || 0),
    timestamp: Number(row.created_at_ms || Date.parse(row.created_at || '') || Date.now()),
  };
}

function sanitizePayload(body = {}) {
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 3)
    : [];
  return {
    authorId: String(body.authorId || '').trim(),
    authorName: String(body.authorName || 'Usuario').trim() || 'Usuario',
    authorImage: String(body.authorImage || '').trim(),
    content: String(body.content || '').trim(),
    gifUrl: String(body.gifUrl || '').trim() || null,
    imageUrls,
    poll: body.poll && typeof body.poll === 'object' ? body.poll : null,
    disclosures: body.disclosures && typeof body.disclosures === 'object' ? body.disclosures : null,
    location: body.location && typeof body.location === 'object' ? body.location : null,
  };
}

function parseJsonArray(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw) {
  try {
    const value = JSON.parse(raw || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function loadPostsStorage(awsConfig) {
  const object = await s3GetObject(awsConfig, POSTS_OBJECT_KEY);
  if (!object) return { posts: [] };

  try {
    const parsed = JSON.parse(object);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posts)) {
      return { posts: [] };
    }
    return parsed;
  } catch {
    return { posts: [] };
  }
}

async function savePostsStorage(awsConfig, storage) {
  const normalized = {
    posts: Array.isArray(storage?.posts) ? storage.posts : [],
  };
  await s3PutObject(awsConfig, POSTS_OBJECT_KEY, JSON.stringify(normalized));
}

async function s3GetObject(awsConfig, key) {
  const path = `/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  const { headers, url } = await buildSignedRequest(awsConfig, { method: 'GET', path, payload: '' });
  const response = await fetch(url, { method: 'GET', headers });

  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`S3 GET error (${response.status}): ${txt.slice(0, 300)}`);
  }
  return response.text();
}

async function s3PutObject(awsConfig, key, bodyText) {
  const path = `/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  const { headers, url } = await buildSignedRequest(awsConfig, {
    method: 'PUT',
    path,
    payload: bodyText,
    extraHeaders: {
      'content-type': 'application/json; charset=utf-8',
    },
  });

  const response = await fetch(url, { method: 'PUT', headers, body: bodyText });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`S3 PUT error (${response.status}): ${txt.slice(0, 300)}`);
  }
}

async function buildSignedRequest(awsConfig, { method, path, payload, extraHeaders = {} }) {
  const host = `${awsConfig.bucket}.s3.${awsConfig.region}.amazonaws.com`;
  const url = `https://${host}${path}`;
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(payload || '');
  const headersLower = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...toLowerCaseKeys(extraHeaders),
  };

  const sortedHeaderKeys = Object.keys(headersLower).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${String(headersLower[k]).trim()}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${awsConfig.region}/${AWS_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSignatureKey(awsConfig.secretAccessKey, dateStamp, awsConfig.region, AWS_SERVICE);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${awsConfig.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    headers: {
      ...headersLower,
      Authorization: authorization,
    },
  };
}

function toAmzDate(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return `${iso.slice(0, 8)}T${iso.slice(8, 14)}Z`;
}

function toLowerCaseKeys(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

async function hmacHex(key, data) {
  const sig = await hmac(key, data);
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  const kDate = await hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = await hmac(kDate, regionName);
  const kService = await hmac(kRegion, serviceName);
  return hmac(kService, 'aws4_request');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}
