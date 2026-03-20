# Guía súper simple: pasar comentarios de Firebase Realtime Database a Amazon DynamoDB con Amplify

> Esta guía está hecha para **principiantes** y para este proyecto (`index.html`) que ya quedó preparado para leer comentarios desde un API REST de AWS.

## 0) ¿Qué vas a crear?
Vas a crear en AWS, en este orden:

1. Una tabla en **DynamoDB** para comentarios.
2. Una función **Lambda** para listar/crear/votar/eliminar comentarios.
3. Un API en **API Gateway** para exponer endpoints HTTP.
4. (Opcional pero recomendado) un proyecto en **Amplify Hosting** para desplegar tu web.
5. Vas a copiar 4 datos en `index.html` para activar el modo AWS.

---

## 1) Entrar a AWS y preparar región

1. Inicia sesión en AWS Console.
2. Arriba a la derecha elige una región (por ejemplo `us-east-1`).
3. Usa esa misma región para TODO (DynamoDB, Lambda, API Gateway, Amplify).

---

## 2) Crear tabla DynamoDB

1. Ve a **DynamoDB** > **Tables** > **Create table**.
2. Table name: `PostComments`.
3. Partition key: `postId` (String).
4. Sort key: `commentPath` (String).
5. Clic en **Create table**.

### Estructura recomendada de cada comentario
- `postId`: ID del post.
- `commentPath`: ruta única (ej: `cmt_123` o `cmt_123/replies/cmt_456`).
- `content`, `authorId`, `authorName`, `authorImage`, `gifUrl`.
- `timestamp` (number).
- `upvotes`, `downvotes` (number).
- `parentPath` (opcional, para respuestas).

---

## 3) Crear Lambda

1. Ve a **Lambda** > **Create function**.
2. Author from scratch.
3. Function name: `drex-comments-api`.
4. Runtime: **Node.js 20.x**.
5. Create function.

### 3.1 Dar permisos a Lambda
1. En la Lambda, pestaña **Configuration** > **Permissions**.
2. Abre el Role en IAM.
3. Attach policy con permisos de DynamoDB para la tabla `PostComments`:
   - `dynamodb:GetItem`
   - `dynamodb:PutItem`
   - `dynamodb:UpdateItem`
   - `dynamodb:DeleteItem`
   - `dynamodb:Query`
   - `dynamodb:Scan`

### 3.2 Variables de entorno de Lambda
En **Configuration** > **Environment variables** agrega:
- `COMMENTS_TABLE = PostComments`

---

## 4) Crear API Gateway (HTTP API)

1. Ve a **API Gateway** > **Create API** > **HTTP API**.
2. Integración: selecciona tu Lambda `drex-comments-api`.
3. Crea estas rutas (métodos):
   - `GET /posts/{noteId}/comments`
   - `GET /posts/{noteId}/comment-votes`
   - `POST /posts/{noteId}/comments`
   - `GET /posts/{noteId}/comments/count`
   - `POST /posts/{noteId}/comments/vote`
   - `DELETE /posts/{noteId}/comments/{commentPath}`
4. Deploy API.
5. Copia el **Invoke URL** (ejemplo: `https://abc123.execute-api.us-east-1.amazonaws.com`).

### 4.1 CORS (muy importante)
En API Gateway activa CORS:
- Allow origin: tu dominio (o `*` temporalmente).
- Allow methods: GET, POST, DELETE, OPTIONS.
- Allow headers: `content-type`, `x-api-key`.

### 4.2 Seguridad rápida
Si aún no tienes Cognito:
- Puedes usar **API Key** temporalmente.
- Más adelante migras a Cognito/IAM.

---

## 5) Activar en tu `index.html`

Busca `commentsBackendConfig` y cambia:

```js
const commentsBackendConfig = {
  enabled: true,
  region: 'us-east-1',
  restApiName: 'drexCommentsApi',
  endpoint: 'https://TU-INVOKE-URL',
  apiKey: 'TU_API_KEY_SI_USAS'
};
```

> Si `enabled` está en `false`, seguirá usando Firebase para comentarios.

---

## 6) Probar manualmente (sin código)

1. Abre tu sitio.
2. Entra a un post.
3. Crea un comentario.
4. Responde a un comentario.
5. Da voto (fuego).
6. Elimina un comentario tuyo.
7. Revisa DynamoDB: deberían aparecer/actualizarse registros.

---

## 7) Problemas comunes

### No carga comentarios
- Verifica CORS.
- Verifica `endpoint` correcto.
- Revisa CloudWatch Logs de Lambda.

### Error 403
- Falta API key o autorización.
- Revisa configuración de seguridad del API.

### Error 500
- Bug en Lambda o permisos IAM insuficientes.

---

## 8) Orden recomendado para ti (sin enredarte)

1. DynamoDB table.
2. Lambda + permisos + variables.
3. API Gateway + rutas + CORS.
4. Copiar endpoint en `commentsBackendConfig`.
5. Poner `enabled: true`.
6. Probar.

---

## 9) ¿Qué ya dejó listo este proyecto?

El frontend ya está preparado para:
- Leer comentarios desde API REST (AWS) cuando `enabled: true`.
- Seguir usando Firebase automáticamente cuando `enabled: false`.
- Crear, votar, eliminar y contar comentarios en ambos modos.

