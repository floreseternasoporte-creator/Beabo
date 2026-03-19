# Estado actual de backend comunitario

## Posts (migrado a Amazon S3)

La API de publicaciones ahora usa Amazon S3 (AWS) desde la función:

- `functions/api/community/posts/[[path]].js`

Configuración actual (temporal):

- Las credenciales y bucket están **hardcodeadas** en el archivo de la función (constantes `AWS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).
- El objeto usado en S3 es `community/posts.json`.
- Endpoints de posts:
  - `GET /api/community/posts?limit=50`
  - `GET /api/community/posts/health`
  - `GET /api/community/posts/:postId`
  - `POST /api/community/posts`
  - `PATCH /api/community/posts/:postId/comments-count`

> Pendiente: reemplazar los valores `REEMPLAZAR_*` con las credenciales reales que compartas.

## Comentarios (aún en SQLite/D1)

La API de comentarios sigue en SQLite/D1 por ahora en:

- `functions/api/community/comments.js`

Se migrará después a AWS en el siguiente paso.
