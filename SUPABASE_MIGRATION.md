# Migración de Firebase a Supabase - Guía Completa

## ✅ Estado de la Migración

La migración de Firebase a Supabase ha sido completada exitosamente. Todos los sistemas de posts, comentarios, votaciones y reportes ahora utilizan Supabase.

## 📊 Base de Datos

### Tablas Creadas

1. **community_posts** - Publicaciones principales
   - id, user_id, content, image_urls, image_url
   - poll_question, poll_options
   - location, latitude, longitude
   - upvotes_count, downvotes_count, comments_count
   - is_hidden, moderation_reason
   - timestamps (created_at, updated_at)

2. **post_comments** - Comentarios de primer nivel
   - id, post_id, user_id, content, image_urls
   - upvotes_count, downvotes_count, replies_count
   - timestamps

3. **comment_replies** - Respuestas anidadas
   - id, post_id, parent_comment_id, user_id
   - content, image_urls
   - upvotes_count, downvotes_count
   - timestamps

4. **post_votes** - Votos en posts
   - id, post_id, user_id, vote_type (upvote/downvote)
   - UNIQUE constraint: (post_id, user_id)

5. **comment_votes** - Votos en comentarios
   - id, comment_id, user_id, vote_type
   - UNIQUE constraint: (comment_id, user_id)

6. **post_reports** - Reportes de contenido
   - id, post_id, reported_by_user_id, reason, description
   - status (pending/reviewed/action_taken)
   - admin_notes

7. **hidden_posts_by_user** - Posts ocultos por usuario
   - id, user_id, post_id
   - UNIQUE constraint: (user_id, post_id)

### Triggers Automáticos

Se han creado triggers que mantienen automáticamente actualizados:
- Contadores de upvotes/downvotes en posts
- Contadores de upvotes/downvotes en comentarios
- Contador de comentarios por post
- Contador de respuestas por comentario

## 🔐 Seguridad (Row Level Security)

Todas las tablas tienen RLS habilitado con políticas apropiadas:

- **Posts**: Todos pueden ver posts no ocultos; solo el propietario puede editar/eliminar
- **Comentarios**: Todos pueden ver; solo propietarios pueden crear/editar/eliminar
- **Votos**: Los usuarios solo pueden votar una vez por post/comentario
- **Reportes**: Solo el usuario que reporta puede ver sus propios reportes

## 📁 Archivos Creados/Modificados

### Nuevos Archivos

- `supabase-client.js` - Cliente inicializado de Supabase
- `supabase-posts.js` - Funciones de posts, comentarios y votación
- `supabase-integration.js` - Integración con la interfaz del HTML
- `vite.config.js` - Configuración de Vite
- `package.json` - Dependencias del proyecto

### Modificados

- `index.html` - Removidas referencias a Firebase, agregado cliente de Supabase
- Todas las llamadas a `firebase.database()` han sido reemplazadas

## 🚀 Funciones Principales Migradas

### Publicación de Posts
```javascript
publishPost(content, imageFiles, pollData, location, coordinates)
```

### Votación
```javascript
votePost(postId, voteType)  // 'upvote' o 'downvote'
voteComment(commentId, voteType)
```

### Comentarios
```javascript
createComment(postId, content, imageFiles)
createReply(postId, parentCommentId, content, imageFiles)
loadPostComments(postId)
```

### Gestión de Posts
```javascript
deletePost(postId)
hidePostForUser(postId)
reportPost(postId, reason, description)
```

### Lectura
```javascript
loadPostsFeed(limit, offset)
loadUserPosts(userId, limit, offset)
loadPostsByLocation(location, limit, offset)
```

## 📦 Storage

Las imágenes ahora se suben en URL pública de AWS S3 cuando hay credenciales configuradas.
Si no hay variables de AWS disponibles, el sistema hace fallback automático a Supabase Storage.

- Carpeta S3 para posts/comentarios: `posts/{userId}/{uuid}.{extension}`
- Carpeta S3 para avatares: `avatars/{userId}/{uuid}.{extension}`
- Fallback Supabase bucket: `posts-images` y `user-avatars`

## ⚙️ Configuración Necesaria

### 1. Variables de Entorno (.env)

```
VITE_SUPABASE_URL=https://yvtmakdvntkegbjcloyb.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Opcional: AWS S3 (recomendado para imágenes, evita base64)
VITE_AWS_REGION=us-east-2
VITE_AWS_S3_BUCKET=tu-bucket
VITE_AWS_ACCESS_KEY_ID=...
VITE_AWS_SECRET_ACCESS_KEY=...
```

### 2. Crear Buckets en Supabase

En el dashboard de Supabase (Storage):

1. Crear bucket: `posts-images`
   - Configurar como público o con políticas de acceso

2. Crear bucket: `user-avatars` (opcional, para futuros perfiles)

### 3. Autenticación

El sistema ya está conectado a Supabase Auth. Los usuarios pueden:
- Registrarse con email/password
- Iniciar sesión
- Recuperar contraseña

## 🧪 Testing

Para probar la migración:

1. Instalar dependencias:
```bash
npm install
```

2. Ejecutar en desarrollo:
```bash
npm run dev
```

3. Compilar para producción:
```bash
npm run build
```

## 📝 Notas Importantes

### Compatibilidad Hacia Atrás

Todas las funciones JavaScript existentes en `onclick` handlers del HTML han sido mapeadas a las nuevas funciones de Supabase. El cambio es transparente para el usuario.

### Moderación de Contenido

Se mantiene el sistema de moderación:
- `moderarContenidoNota()` - Verifica palabras prohibidas
- `contienePalabrasOfensivas()` - Valida contenido

### Contadores

Los contadores de votos, comentarios y respuestas se actualizan automáticamente en la base de datos mediante triggers, no requieren actualizaciones manuales del código.

### Prevención de Voto Duplicado

La constraint UNIQUE en las tablas de votos previene que un usuario vote más de una vez por el mismo post/comentario.

## 🔄 Próximos Pasos

1. **Crear buckets de Storage** en dashboard de Supabase (si no existen)
2. **Configurar CORS** en Storage (si es necesario)
3. **Probar todas las funcionalidades** con usuarios reales
4. **Migrar datos existentes** de Firebase (si es requerido)
5. **Monitorear logs** de Supabase en producción

## 🐛 Solución de Problemas

### Error: "User not authenticated"
- El usuario debe iniciar sesión primero
- Verificar que Supabase Auth está configurado

### Imágenes no se suben
- Verificar que los buckets de Storage existen
- Verificar configuración de CORS en Supabase
- Revisar la consola del navegador para errores

### Comentarios no se cargan
- Verificar que el post_id es válido
- Revisar RLS policies en Supabase

## 📚 Documentación Adicional

- [Supabase Docs](https://supabase.com/docs)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
