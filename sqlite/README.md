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

## Endpoints esperados por `index.html`

- `GET /api/community/posts/:postId/comments`
  - Respuesta: `{ "comments": [ ...arbol de comentarios... ] }`
- `POST /api/community/posts/:postId/comments`
  - Body: `{ content, authorId, authorName, authorImage, gifUrl?, parentCommentId? }`
- `POST /api/community/posts/:postId/comments/:commentId/votes`
  - Body: `{ voteType: "up" }`
  - Respuesta: `{ score: number, userVoted: boolean }`
- `DELETE /api/community/posts/:postId/comments/:commentId`

## Nota de integración

- El frontend usa `window.COMMUNITY_SQLITE_API_BASE`.
- Por defecto usa:
  - `http://localhost:8787/api/community` si abres `index.html` como archivo local (`file://`).
  - `/api/community` si estás sirviendo la web desde un backend.
- Firebase se mantiene para autenticación/perfil y otros módulos, pero comentarios/respuestas/votos ya apuntan al backend SQLite.
