# SQLite para comentarios (activo en frontend)

La sección de publicaciones + comentarios ahora se consume desde una API de SQLite en lugar de leer/escribir en `communityNotes` / `postComments` de Firebase Realtime Database.

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

- `GET /api/community/posts?limit=50`
  - Respuesta: `{ "posts": [ ... ] }`
- `GET /api/community/posts/:postId`
  - Respuesta: `{ "post": { ... } }`
- `POST /api/community/posts`
  - Body: `{ content, authorId, authorName, authorImage, gifUrl?, imageUrls?, poll?, disclosures?, location? }`
  - `location` se guarda en SQLite (`location_name`, `location_lat`, `location_lng`).
- `PATCH /api/community/posts/:postId/comments-count`
  - Body: `{ commentsCount }`
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
- Firebase se mantiene para autenticación/perfil y otros módulos, pero publicaciones/comentarios/respuestas/votos de comentarios ya apuntan al backend SQLite.

## Configuración Cloudflare Pages + D1 (paso a paso)

1. **Crear base D1**:
   - Cloudflare Dashboard → **Workers & Pages** → **D1 SQL Database** → **Create**.
   - Guarda el nombre y `database_id`.
2. **Aplicar schema**:
   - Opción CLI:
     ```bash
     wrangler d1 execute <DB_NAME> --file=sqlite/schema.sql --remote
     ```
   - Opción Dashboard: pestaña SQL y pegar `sqlite/schema.sql`.
3. **Binding en Pages**:
   - Pages Project → **Settings** → **Functions** → **D1 bindings**.
   - Variable/binding name: `COMMUNITY_DB`.
   - Selecciona la base creada.
4. **Publicar**:
   - Re-deploy del proyecto Pages.
5. **Verificación rápida**:
   - `GET https://<tu-dominio>/api/community/posts?limit=1` debe responder `200`.
   - Crea un post desde la UI con ubicación y valida que aparezca.
