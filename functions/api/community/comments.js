const AWS_SERVICE = 's3';
const COMMENTS_OBJECT_KEY = 'community/comments.json';

export async function onRequest(context) {
  const { request, env } = context;
  const awsConfig = getAwsConfig(env);
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  const postId = decodeURIComponent(pathParts[3] || '');
  const tail = pathParts.slice(4); // [:commentId?, votes?]

  if (!postId) {
    return json({ error: 'Post ID es obligatorio' }, 400);
  }

  if (!isConfigured(awsConfig)) {
    return json({
      error: 'Configuración AWS incompleta',
      detail: 'Define AWS_BUCKET, AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY como variables de entorno en Cloudflare.',
    }, 500);
  }

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === 'GET' && tail.length === 0) {
      const viewerId = (url.searchParams.get('viewerId') || '').trim();
      const storage = await loadCommentsStorage(awsConfig);
      return json({ comments: storageToTree(storage, postId, viewerId) }, 200);
    }

    if (request.method === 'POST' && tail.length === 0) {
      const body = await safeJson(request);
      const payload = sanitizeCreatePayload(body);
      if (!payload.authorId) return json({ error: 'authorId es obligatorio' }, 400);
      if (!payload.content && !payload.gifUrl) return json({ error: 'Debe enviar contenido o gifUrl' }, 400);

      const now = new Date().toISOString();
      const storage = await loadCommentsStorage(awsConfig);
      const commentId = crypto.randomUUID();

      storage.comments.push({
        id: commentId,
        post_id: postId,
        parent_comment_id: payload.parentCommentId,
        author_id: payload.authorId,
        author_name: payload.authorName,
        author_image: payload.authorImage,
        content: payload.content,
        gif_url: payload.gifUrl,
        score: 0,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });

      await saveCommentsStorage(awsConfig, storage);
      return json({ id: commentId }, 201);
    }

    if (request.method === 'POST' && tail.length === 2 && tail[1] === 'votes') {
      const commentId = decodeURIComponent(tail[0] || '').trim();
      const body = await safeJson(request);
      const userId = String(body.userId || '').trim();
      const voteType = String(body.voteType || 'up').trim();

      if (!userId) return json({ error: 'userId es obligatorio' }, 400);
      if (!commentId) return json({ error: 'commentId es obligatorio' }, 400);
      if (voteType !== 'up') return json({ error: 'voteType no soportado' }, 400);

      const storage = await loadCommentsStorage(awsConfig);
      const comment = storage.comments.find((item) => item.id === commentId && item.post_id === postId && !item.deleted_at);

      if (!comment) return json({ error: 'Comentario no encontrado' }, 404);

      const existingVoteIndex = storage.votes.findIndex(
        (vote) => vote.comment_id === commentId && vote.user_id === userId && vote.vote_type === 'up'
      );

      let userVoted = false;
      if (existingVoteIndex >= 0) {
        storage.votes.splice(existingVoteIndex, 1);
        comment.score = Math.max(0, Number(comment.score || 0) - 1);
      } else {
        storage.votes.push({
          id: crypto.randomUUID(),
          comment_id: commentId,
          user_id: userId,
          vote_type: 'up',
          created_at: new Date().toISOString(),
        });
        comment.score = Number(comment.score || 0) + 1;
        userVoted = true;
      }

      comment.updated_at = new Date().toISOString();
      await saveCommentsStorage(awsConfig, storage);
      return json({ score: Number(comment.score || 0), userVoted }, 200);
    }

    if (request.method === 'DELETE' && tail.length === 1) {
      const commentId = decodeURIComponent(tail[0] || '').trim();
      const body = await safeJson(request);
      const userId = String(body.userId || '').trim();

      if (!userId) return json({ error: 'userId es obligatorio' }, 400);

      const storage = await loadCommentsStorage(awsConfig);
      const comment = storage.comments.find((item) => item.id === commentId && item.post_id === postId && !item.deleted_at);

      if (!comment) return json({ error: 'Comentario no encontrado' }, 404);
      if (comment.author_id !== userId) return json({ error: 'No autorizado' }, 403);

      comment.deleted_at = new Date().toISOString();
      comment.updated_at = comment.deleted_at;
      await saveCommentsStorage(awsConfig, storage);
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return json({ error: 'Método no soportado' }, 405);
  } catch (err) {
    return json({ error: 'Error interno', detail: String(err?.message || err) }, 500);
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

function sanitizeCreatePayload(body = {}) {
  return {
    authorId: String(body.authorId || '').trim(),
    authorName: String(body.authorName || 'Usuario').trim() || 'Usuario',
    authorImage: String(body.authorImage || '').trim(),
    content: String(body.content || '').trim(),
    gifUrl: String(body.gifUrl || '').trim() || null,
    parentCommentId: String(body.parentCommentId || '').trim() || null,
  };
}

function storageToTree(storage, postId, viewerId) {
  const rows = storage.comments
    .filter((comment) => comment.post_id === postId && !comment.deleted_at)
    .sort((a, b) => Date.parse(a.created_at || '') - Date.parse(b.created_at || ''));

  const map = new Map();
  const roots = [];

  for (const row of rows) {
    const userVoted = viewerId
      ? storage.votes.some((vote) => vote.comment_id === row.id && vote.user_id === viewerId && vote.vote_type === 'up')
      : false;

    map.set(row.id, {
      id: row.id,
      authorId: row.author_id,
      authorName: row.author_name || 'Usuario',
      authorImage: row.author_image || 'https://via.placeholder.com/150',
      content: row.content || '',
      gifUrl: row.gif_url || null,
      timestamp: Date.parse(row.created_at || '') || Date.now(),
      score: Number(row.score || 0),
      userVoted,
      replies: [],
      parentCommentId: row.parent_comment_id || null,
    });
  }

  for (const comment of map.values()) {
    if (comment.parentCommentId && map.has(comment.parentCommentId)) {
      map.get(comment.parentCommentId).replies.push(comment);
    } else {
      roots.push(comment);
    }
  }

  const sortTree = (nodes) => {
    nodes.sort((a, b) => a.timestamp - b.timestamp);
    for (const node of nodes) sortTree(node.replies);
  };

  sortTree(roots);
  return roots;
}

async function loadCommentsStorage(awsConfig) {
  const object = await s3GetObject(awsConfig, COMMENTS_OBJECT_KEY);
  if (!object) return { comments: [], votes: [] };

  try {
    const parsed = JSON.parse(object);
    return {
      comments: Array.isArray(parsed?.comments) ? parsed.comments : [],
      votes: Array.isArray(parsed?.votes) ? parsed.votes : [],
    };
  } catch {
    return { comments: [], votes: [] };
  }
}

async function saveCommentsStorage(awsConfig, storage) {
  const normalized = {
    comments: Array.isArray(storage?.comments) ? storage.comments : [],
    votes: Array.isArray(storage?.votes) ? storage.votes : [],
  };

  await s3PutObject(awsConfig, COMMENTS_OBJECT_KEY, JSON.stringify(normalized));
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

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
