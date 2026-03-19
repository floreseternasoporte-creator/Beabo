export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // /api/community/comments/:postId/... => postId index 3
  const postId = decodeURIComponent(pathParts[3] || '');
  const tail = pathParts.slice(4); // [:commentId?, votes?]

  if (!postId) {
    return json({ error: 'Post ID es obligatorio' }, 400);
  }

  if (!env.COMMUNITY_DB) {
    return json({ error: 'Falta binding D1 COMMUNITY_DB en Cloudflare Pages' }, 500);
  }

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === 'GET' && tail.length === 0) {
      const viewerId = (url.searchParams.get('viewerId') || '').trim();
      const rows = await getCommentsRows(env.COMMUNITY_DB, postId, viewerId);
      return json({ comments: rowsToTree(rows, viewerId) }, 200);
    }

    if (request.method === 'POST' && tail.length === 0) {
      const body = await safeJson(request);
      const payload = sanitizeCreatePayload(body);
      if (!payload.authorId) return json({ error: 'authorId es obligatorio' }, 400);
      if (!payload.content && !payload.gifUrl) return json({ error: 'Debe enviar contenido o gifUrl' }, 400);

      const commentId = crypto.randomUUID();
      const now = new Date().toISOString();

      await env.COMMUNITY_DB.prepare(
        `INSERT INTO users (id, username, profile_image, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           profile_image = excluded.profile_image,
           updated_at = excluded.updated_at`
      ).bind(payload.authorId, payload.authorName, payload.authorImage, now).run();

      await env.COMMUNITY_DB.prepare(
        `INSERT INTO comments (
          id, post_id, parent_comment_id, author_id, author_name, author_image,
          content, gif_url, score, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)`
      ).bind(
        commentId,
        postId,
        payload.parentCommentId,
        payload.authorId,
        payload.authorName,
        payload.authorImage,
        payload.content,
        payload.gifUrl,
        now,
        now
      ).run();

      return json({ id: commentId }, 201);
    }

    if (request.method === 'POST' && tail.length === 2 && tail[1] === 'votes') {
      const commentId = decodeURIComponent(tail[0] || '');
      const body = await safeJson(request);
      const userId = String(body.userId || '').trim();
      const voteType = String(body.voteType || 'up').trim();

      if (!userId) return json({ error: 'userId es obligatorio' }, 400);
      if (voteType !== 'up') return json({ error: 'voteType no soportado' }, 400);

      const exists = await env.COMMUNITY_DB.prepare(
        'SELECT id FROM comments WHERE id = ?1 AND post_id = ?2 AND deleted_at IS NULL'
      ).bind(commentId, postId).first();

      if (!exists) return json({ error: 'Comentario no encontrado' }, 404);

      const foundVote = await env.COMMUNITY_DB.prepare(
        'SELECT id FROM comment_votes WHERE comment_id = ?1 AND user_id = ?2 AND vote_type = ?3'
      ).bind(commentId, userId, 'up').first();

      const now = new Date().toISOString();
      let userVoted = false;

      if (foundVote) {
        await env.COMMUNITY_DB.prepare('DELETE FROM comment_votes WHERE id = ?1').bind(foundVote.id).run();
        await env.COMMUNITY_DB.prepare('UPDATE comments SET score = MAX(0, score - 1), updated_at = ?1 WHERE id = ?2').bind(now, commentId).run();
      } else {
        await env.COMMUNITY_DB.prepare(
          'INSERT INTO comment_votes (comment_id, user_id, vote_type, created_at) VALUES (?1, ?2, ?3, ?4)'
        ).bind(commentId, userId, 'up', now).run();
        await env.COMMUNITY_DB.prepare('UPDATE comments SET score = score + 1, updated_at = ?1 WHERE id = ?2').bind(now, commentId).run();
        userVoted = true;
      }

      const scoreRow = await env.COMMUNITY_DB.prepare('SELECT score FROM comments WHERE id = ?1').bind(commentId).first();
      return json({ score: Number(scoreRow?.score || 0), userVoted }, 200);
    }

    if (request.method === 'DELETE' && tail.length === 1) {
      const commentId = decodeURIComponent(tail[0] || '');
      const body = await safeJson(request);
      const userId = String(body.userId || '').trim();

      if (!userId) return json({ error: 'userId es obligatorio' }, 400);

      const row = await env.COMMUNITY_DB.prepare(
        'SELECT author_id FROM comments WHERE id = ?1 AND post_id = ?2 AND deleted_at IS NULL'
      ).bind(commentId, postId).first();

      if (!row) return json({ error: 'Comentario no encontrado' }, 404);
      if (row.author_id !== userId) return json({ error: 'No autorizado' }, 403);

      await env.COMMUNITY_DB.prepare('DELETE FROM comments WHERE id = ?1').bind(commentId).run();
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return json({ error: 'Método no soportado' }, 405);
  } catch (err) {
    return json({ error: 'Error interno', detail: String(err?.message || err) }, 500);
  }
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

async function getCommentsRows(db, postId, viewerId) {
  if (viewerId) {
    const { results } = await db.prepare(
      `SELECT c.*,
              EXISTS(
                SELECT 1 FROM comment_votes cv
                WHERE cv.comment_id = c.id AND cv.user_id = ?1 AND cv.vote_type = 'up'
              ) AS viewer_voted
       FROM comments c
       WHERE c.post_id = ?2 AND c.deleted_at IS NULL
       ORDER BY datetime(c.created_at) ASC`
    ).bind(viewerId, postId).all();
    return results || [];
  }

  const { results } = await db.prepare(
    `SELECT c.*, 0 AS viewer_voted
     FROM comments c
     WHERE c.post_id = ?1 AND c.deleted_at IS NULL
     ORDER BY datetime(c.created_at) ASC`
  ).bind(postId).all();
  return results || [];
}

function rowsToTree(rows, viewerId) {
  const map = new Map();
  const roots = [];

  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      authorId: row.author_id,
      authorName: row.author_name || 'Usuario',
      authorImage: row.author_image || 'https://via.placeholder.com/150',
      content: row.content || '',
      gifUrl: row.gif_url || null,
      timestamp: Date.parse(row.created_at || '') || Date.now(),
      score: Number(row.score || 0),
      userVoted: viewerId ? Boolean(row.viewer_voted) : false,
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
