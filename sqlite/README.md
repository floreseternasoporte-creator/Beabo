# SQLite para comentarios (activo en frontend)

La sección de comentarios ahora se consume desde una API de SQLite en lugar de leer/escribir en `postComments` de Firebase Realtime Database.

## Crear base local

```bash
sqlite3 community.db < sqlite/schema.sql
```

## Levantar API SQLite local (sin dependencias externas)

```bash
python3 sqlite/api_server.py
```

Servidor por defecto: `http://localhost:8787/api/community`

## Cloudflare Pages + D1 (producción)

Este repo ahora incluye función de Cloudflare Pages en:

- `functions/api/community/posts/[[path]].js`

Para que funcione en Cloudflare:

1. Crea una base D1 (SQLite administrado por Cloudflare).
2. Ejecuta el schema de `sqlite/schema.sql` sobre la base D1.
3. En tu proyecto Pages, agrega binding D1 con nombre **`COMMUNITY_DB`**.
4. Publica/redeploy.

Si falta el binding, la API responde error 500 con mensaje claro.

## Endpoints esperados por `index.html`

- `GET /api/community/posts/:postId/comments`
  - Respuesta: `{ "comments": [ ...arbol de comentarios... ] }`
- `POST /api/community/posts/:postId/comments`
  - Body: `{ content, authorId, authorName, authorImage, gifUrl?, parentCommentId? }`
- `POST /api/community/posts/:postId/comments/:commentId/votes`
  - Body: `{ voteType: "up", userId }`
  - Respuesta: `{ score: number, userVoted: boolean }`
- `DELETE /api/community/posts/:postId/comments/:commentId`
  - Body: `{ userId }`

## Nota de integración

- El frontend usa `window.COMMUNITY_SQLITE_API_BASE`.
- Por defecto usa:
  - `http://localhost:8787/api/community` si abres `index.html` como archivo local (`file://`).
  - `/api/community` si estás sirviendo la web desde un backend.
- Firebase se mantiene para autenticación/perfil y otros módulos, pero comentarios/respuestas/votos ya apuntan al backend SQLite.
