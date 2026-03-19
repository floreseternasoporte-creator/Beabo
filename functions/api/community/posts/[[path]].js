export async function onRequest(context) {
  const { request, env } = context;
  if (!env.COMMUNITY_DB) return json({ error: 'Falta binding D1 COMMUNITY_DB en Cloudflare Pages' }, 500);

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const tail = parts.slice(4); // /api/community/posts/:id/...

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'health') {
      const tableCheck = await env.COMMUNITY_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'community_posts'"
      ).first();
      return json({
        ok: true,
        databaseBinding: 'COMMUNITY_DB',
        communityPostsTable: Boolean(tableCheck?.name),
      }, 200);
    }

    if (request.method === 'GET' && tail.length === 0) {
      const requestedLimit = Number(url.searchParams.get('limit') || 50);
      const safeLimit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
      const limit = Math.max(1, Math.min(100, safeLimit));
      const { results } = await env.COMMUNITY_DB.prepare(
        `SELECT * FROM community_posts
         WHERE deleted_at IS NULL
         ORDER BY datetime(created_at) DESC
         LIMIT ?1`
      ).bind(limit).all();
      return json({ posts: (results || []).map(rowToPost) }, 200);
    }

    if (request.method === 'GET' && tail.length === 1) {
      const id = decodeURIComponent(tail[0] || '');
      if (!id) return json({ error: 'Post ID es obligatorio' }, 400);
      const row = await env.COMMUNITY_DB.prepare(
        'SELECT * FROM community_posts WHERE id = ?1 AND deleted_at IS NULL'
      ).bind(id).first();
      if (!row) return json({ error: 'Post no encontrado' }, 404);
      return json({ post: rowToPost(row) }, 200);
    }

    if (request.method === 'POST' && tail.length === 0) {
      const body = sanitizePayload(await safeJson(request));
      if (!body.authorId) return json({ error: 'authorId es obligatorio' }, 400);
      if (!body.content && !body.gifUrl && !body.imageUrls.length && !body.poll) {
        return json({ error: 'El post está vacío' }, 400);
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await env.COMMUNITY_DB.prepare(
        `INSERT INTO users (id, username, profile_image, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           profile_image = excluded.profile_image,
           updated_at = excluded.updated_at`
      ).bind(body.authorId, body.authorName, body.authorImage, now).run();

      await env.COMMUNITY_DB.prepare(
        `INSERT INTO community_posts (
          id, author_id, author_name, author_image, content, gif_url,
          image_url, image_urls_json, poll_json, disclosures_json,
          location_name, location_lat, location_lng,
          upvotes, downvotes, comments_count, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, 0, ?14, ?15)`
      ).bind(
        id,
        body.authorId,
        body.authorName,
        body.authorImage,
        body.content,
        body.gifUrl,
        body.imageUrls[0] || null,
        JSON.stringify(body.imageUrls),
        body.poll ? JSON.stringify(body.poll) : null,
        JSON.stringify(body.disclosures || { paidPartnership: false, aiGenerated: false }),
        body.location?.name || null,
        Number.isFinite(Number(body.location?.lat)) ? Number(body.location.lat) : null,
        Number.isFinite(Number(body.location?.lng)) ? Number(body.location.lng) : null,
        now,
        now
      ).run();

      return json({ id }, 201);
    }

    if (request.method === 'PATCH' && tail.length === 2 && tail[1] === 'comments-count') {
      const id = decodeURIComponent(tail[0] || '');
      const body = await safeJson(request);
      const commentsCount = Math.max(0, Number(body.commentsCount || 0));
      const now = new Date().toISOString();

      const found = await env.COMMUNITY_DB.prepare(
        'SELECT id FROM community_posts WHERE id = ?1 AND deleted_at IS NULL'
      ).bind(id).first();
      if (!found) return json({ error: 'Post no encontrado' }, 404);

      await env.COMMUNITY_DB.prepare(
        'UPDATE community_posts SET comments_count = ?1, updated_at = ?2 WHERE id = ?3'
      ).bind(commentsCount, now, id).run();
      return json({ ok: true }, 200);
    }

    return json({ error: 'Método no soportado' }, 405);
  } catch (error) {
    return json({ error: 'Error interno', detail: String(error?.message || error) }, 500);
  }
}

function rowToPost(row) {
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
    timestamp: Date.parse(row.created_at || '') || Date.now(),
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
