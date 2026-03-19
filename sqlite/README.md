# SQLite (base inicial)

Se agregó una base de esquema para migrar la parte de comunidad a SQLite:

- Comentarios
- Respuestas
- Reacciones de fuego

## Cómo usarlo

1. Crea la base:

```bash
sqlite3 community.db < sqlite/schema.sql
```

2. Conecta tu backend (Node/Express, Bun, etc.) a `community.db` y expone endpoints para:

- `GET /posts/:postId/comments`
- `POST /posts/:postId/comments`
- `POST /comments/:commentId/replies`
- `POST /comments/:commentId/votes`

> Nota: `index.html` actual usa Firebase Realtime Database. Este esquema es la base para una migración gradual sin romper la app actual.
