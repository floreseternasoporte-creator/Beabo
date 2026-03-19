#!/usr/bin/env python3
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / 'community.db'
SCHEMA_PATH = ROOT / 'schema.sql'


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def iso_to_ms(value: str) -> int:
    if not value:
        return int(datetime.now(timezone.utc).timestamp() * 1000)
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(datetime.now(timezone.utc).timestamp() * 1000)


def ensure_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA foreign_keys = ON')
    schema = SCHEMA_PATH.read_text(encoding='utf-8')
    conn.executescript(schema)
    conn.commit()
    conn.close()


def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def rows_to_tree(rows, viewer_id=''):
    items = {}
    roots = []
    for r in rows:
        cid = r['id']
        items[cid] = {
            'id': cid,
            'authorId': r['author_id'],
            'authorName': r['author_name'] or 'Usuario',
            'authorImage': r['author_image'] or 'https://via.placeholder.com/150',
            'content': r['content'] or '',
            'gifUrl': r['gif_url'],
            'timestamp': iso_to_ms(r['created_at']),
            'score': int(r['score'] or 0),
            'userVoted': bool(r['viewer_voted']) if viewer_id else False,
            'replies': [],
            'parentCommentId': r['parent_comment_id']
        }

    for c in items.values():
        pid = c['parentCommentId']
        if pid and pid in items:
            items[pid]['replies'].append(c)
        else:
            roots.append(c)

    def sort_nodes(nodes):
        nodes.sort(key=lambda n: n['timestamp'])
        for n in nodes:
            sort_nodes(n['replies'])

    sort_nodes(roots)
    return roots


class Handler(BaseHTTPRequestHandler):
    server_version = 'SQLiteCommentsAPI/1.0'

    def _send(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.end_headers()
        self.wfile.write(body)

    def _empty(self, code=204):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.end_headers()

    def do_OPTIONS(self):
        self._empty(204)

    def _json_body(self):
        length = int(self.headers.get('Content-Length', '0') or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        qs = parse_qs(parsed.query)

        if path.startswith('/api/community/posts/') and path.endswith('/comments'):
            # /api/community/posts/:postId/comments
            parts = path.split('/')
            if len(parts) < 6:
                return self._send(400, {'error': 'Ruta inválida'})
            post_id = parts[4]
            viewer_id = (qs.get('viewerId', [''])[0] or '').strip()

            conn = db_conn()
            try:
                if viewer_id:
                    rows = conn.execute(
                        """
                        SELECT c.*,
                               EXISTS(
                                 SELECT 1 FROM comment_votes cv
                                 WHERE cv.comment_id = c.id AND cv.user_id = ? AND cv.vote_type = 'up'
                               ) AS viewer_voted
                        FROM comments c
                        WHERE c.post_id = ? AND c.deleted_at IS NULL
                        ORDER BY datetime(c.created_at) ASC
                        """,
                        (viewer_id, post_id),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        """
                        SELECT c.*, 0 AS viewer_voted
                        FROM comments c
                        WHERE c.post_id = ? AND c.deleted_at IS NULL
                        ORDER BY datetime(c.created_at) ASC
                        """,
                        (post_id,),
                    ).fetchall()
                return self._send(200, {'comments': rows_to_tree(rows, viewer_id)})
            finally:
                conn.close()

        self._send(404, {'error': 'Not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        body = self._json_body()

        # POST /api/community/posts/:postId/comments
        if path.startswith('/api/community/posts/') and path.endswith('/comments'):
            parts = path.split('/')
            if len(parts) < 6:
                return self._send(400, {'error': 'Ruta inválida'})
            post_id = parts[4]

            author_id = (body.get('authorId') or '').strip()
            author_name = (body.get('authorName') or 'Usuario').strip() or 'Usuario'
            author_image = (body.get('authorImage') or '').strip()
            content = (body.get('content') or '').strip()
            gif_url = (body.get('gifUrl') or '').strip() or None
            parent_comment_id = (body.get('parentCommentId') or '').strip() or None

            if not author_id:
                return self._send(400, {'error': 'authorId es obligatorio'})
            if not content and not gif_url:
                return self._send(400, {'error': 'Debe enviar contenido o gifUrl'})

            conn = db_conn()
            try:
                conn.execute(
                    """
                    INSERT INTO users (id, username, profile_image, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                      username = excluded.username,
                      profile_image = excluded.profile_image,
                      updated_at = excluded.updated_at
                    """,
                    (author_id, author_name, author_image, now_iso()),
                )
                comment_id = str(uuid.uuid4())
                created_at = now_iso()
                conn.execute(
                    """
                    INSERT INTO comments (
                      id, post_id, parent_comment_id, author_id, author_name, author_image,
                      content, gif_url, score, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (
                        comment_id,
                        post_id,
                        parent_comment_id,
                        author_id,
                        author_name,
                        author_image,
                        content,
                        gif_url,
                        created_at,
                        created_at,
                    ),
                )
                conn.commit()
                return self._send(201, {'id': comment_id})
            except sqlite3.IntegrityError:
                return self._send(400, {'error': 'parentCommentId inválido'})
            finally:
                conn.close()

        # POST /api/community/posts/:postId/comments/:commentId/votes
        if '/comments/' in path and path.startswith('/api/community/posts/') and path.endswith('/votes'):
            parts = path.split('/')
            if len(parts) < 8:
                return self._send(400, {'error': 'Ruta inválida'})
            post_id = parts[4]
            comment_id = parts[6]
            user_id = (body.get('userId') or '').strip()
            vote_type = (body.get('voteType') or 'up').strip()

            if vote_type != 'up':
                return self._send(400, {'error': 'voteType no soportado'})
            if not user_id:
                return self._send(400, {'error': 'userId es obligatorio'})

            conn = db_conn()
            try:
                exists = conn.execute(
                    'SELECT id FROM comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL',
                    (comment_id, post_id),
                ).fetchone()
                if not exists:
                    return self._send(404, {'error': 'Comentario no encontrado'})

                existing_vote = conn.execute(
                    'SELECT id FROM comment_votes WHERE comment_id = ? AND user_id = ? AND vote_type = ?',
                    (comment_id, user_id, vote_type),
                ).fetchone()

                if existing_vote:
                    conn.execute('DELETE FROM comment_votes WHERE id = ?', (existing_vote['id'],))
                    conn.execute('UPDATE comments SET score = MAX(0, score - 1), updated_at = ? WHERE id = ?', (now_iso(), comment_id))
                    user_voted = False
                else:
                    conn.execute(
                        'INSERT INTO comment_votes (comment_id, user_id, vote_type, created_at) VALUES (?, ?, ?, ?)',
                        (comment_id, user_id, vote_type, now_iso()),
                    )
                    conn.execute('UPDATE comments SET score = score + 1, updated_at = ? WHERE id = ?', (now_iso(), comment_id))
                    user_voted = True

                score_row = conn.execute('SELECT score FROM comments WHERE id = ?', (comment_id,)).fetchone()
                conn.commit()
                return self._send(200, {'score': int(score_row['score'] or 0), 'userVoted': user_voted})
            finally:
                conn.close()

        self._send(404, {'error': 'Not found'})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        body = self._json_body()

        # DELETE /api/community/posts/:postId/comments/:commentId
        if '/comments/' in path and path.startswith('/api/community/posts/'):
            parts = path.split('/')
            if len(parts) < 7:
                return self._send(400, {'error': 'Ruta inválida'})
            post_id = parts[4]
            comment_id = parts[6]
            user_id = (body.get('userId') or '').strip()

            if not user_id:
                return self._send(400, {'error': 'userId es obligatorio'})

            conn = db_conn()
            try:
                row = conn.execute(
                    'SELECT author_id FROM comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL',
                    (comment_id, post_id),
                ).fetchone()
                if not row:
                    return self._send(404, {'error': 'Comentario no encontrado'})
                if row['author_id'] != user_id:
                    return self._send(403, {'error': 'No autorizado'})

                conn.execute('DELETE FROM comments WHERE id = ?', (comment_id,))
                conn.commit()
                return self._empty(204)
            finally:
                conn.close()

        self._send(404, {'error': 'Not found'})


def main():
    ensure_db()
    host = '0.0.0.0'
    port = 8787
    server = ThreadingHTTPServer((host, port), Handler)
    print(f'SQLite API activa en http://{host}:{port}/api/community')
    server.serve_forever()


if __name__ == '__main__':
    main()
