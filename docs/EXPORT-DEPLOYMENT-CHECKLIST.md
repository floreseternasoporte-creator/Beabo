# Checklist de despliegue — backend durable de "Descargar mis datos"

**Nada de esto se ha ejecutado.** Este documento es la guía paso a paso para
desplegar en consola AWS la Lambda `drex-data-export` (implementación en
`lambda-drex-data-export/`, diseño en `docs/EXPORT-BACKEND-DESIGN.md`).

> ⚠️ El ZIP que se sube en el paso 6 es el artefacto ya probado:
> `lambda-drex-data-export/drex-data-export-lambda.zip`
> (82/82 tests en harness, contenido = solo `lambda_function.py`).
> NO tocar: la Lambda de login (`drex-login-backend`) ni el User Pool.

Región: `us-east-1` · Cuenta: `002493750027`

---

## Paso 0 — Preparar el artefacto (local, ya hecho)

```bash
cd ~/workspace/drex-centro/lambda-drex-data-export
./build-zip.sh   # py_compile + tests (82/82) + empaqueta + SHA-256
```

Verificar que existe `drex-data-export-lambda.zip` (~20 KB, solo `lambda_function.py`).

---

## Paso 1 — Bucket S3 `drex-exports-002493750027`

1. Consola S3 → **Create bucket**
   - Bucket name: `drex-exports-002493750027`
     - Si está tomado (los nombres S3 son **globales**), avisar al equipo: hay que
       elegir otro nombre y actualizar `EXPORTS_BUCKET` en la Lambda (paso 5).
   - Region: `us-east-1`
   - Object Ownership: ACLs disabled (recomendado)
   - **Block all public access: ON** (las 4 casillas marcadas)
   - Bucket Versioning: Disable
   - Default encryption: **SSE-S3** (AES-256)
   - Tags: `proyecto=drex`, `datos=pii`
2. **Bucket policy** (Permissions → Bucket policy): Deny a tráfico no TLS:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::drex-exports-002493750027",
        "arn:aws:s3:::drex-exports-002493750027/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

3. **Lifecycle rule** (Management → Lifecycle rules → Create):
   - Name: `exports-7d`
   - Scope: Limit to prefix `exports/`
   - Expiration of current versions: **7 days**
   - Delete expired delete markers: yes
   - Abort incomplete multipart uploads: **1 day**
4. Verificar: subir un objeto de prueba, confirmar que responde solo por HTTPS
   y que el cifrado es SSE-S3; luego borrarlo.

---

## Paso 2 — Verificar TTL de `drex-kv`

Consola DynamoDB → Tables → `drex-kv` → Additional settings → **Time to live (TTL)**:

- TTL attribute name debe ser **`ttl`**. Si está deshabilitado o con otro nombre,
  habilitarlo con atributo `ttl` (los jobs de exportación usan `ttl` = expiración + 30 días).

---

## Paso 3 — Rol IAM `drex-data-export-role`

1. Consola IAM → Roles → **Create role**
   - Trusted entity: **AWS service** → **Lambda**
   - Permissions: adjuntar la gestionada **`AWSLambdaBasicExecutionRole`**
     (CloudWatch Logs)
2. Trust policy (debe quedar así):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

3. **Inline policy** `drex-export-backend` (pegue este JSON exacto):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DdbReadExport",
      "Effect": "Allow",
      "Action": ["dynamodb:Query", "dynamodb:Scan", "dynamodb:GetItem", "dynamodb:BatchGetItem"],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv",
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv/index/*",
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-support-tickets",
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-support-tickets/index/*"
      ]
    },
    {
      "Sid": "DdbWriteJobsAndNotifs",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      "Resource": ["arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv"],
      "Condition": { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["users", "notifications", "ratelimit"] } }
    },
    {
      "Sid": "CognitoReadAccount",
      "Effect": "Allow",
      "Action": ["cognito-idp:AdminGetUser", "cognito-idp:GetUser"],
      "Resource": ["arn:aws:cognito-idp:us-east-1:002493750027:userpool/us-east-1_kDSYEBsnY"]
    },
    {
      "Sid": "S3Exports",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": ["arn:aws:s3:::drex-exports-002493750027/exports/*"]
    },
    {
      "Sid": "S3ListForSweep",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": ["arn:aws:s3:::drex-exports-002493750027"],
      "Condition": { "StringLike": { "s3:prefix": ["exports/*"] } }
    },
    {
      "Sid": "SelfInvokeWorker",
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction"],
      "Resource": ["arn:aws:lambda:us-east-1:002493750027:function:drex-data-export"]
    }
  ]
}
```

> Notas: las lecturas son abiertas a todos los `pk` porque el worker necesita
> `communityNotes`, `conversationMessages`, `musicTracks`, etc.; la contención es
> por código (todo filtro exige `authorId/sub == dueño del job`) + `workerToken`
> + titularidad verificada en `download-url`. Las escrituras están acotadas a
> `users/`, `notifications/` y `ratelimit/` (el worker no puede escribir posts,
> chats ni perfiles aunque tuviera un bug). `cognito-idp:GetUser` es API pública
> (se autoriza con el propio access token); `AdminGetUser` sí requiere el rol.

---

## Paso 4 — Función Lambda `drex-data-export`

1. Consola Lambda → **Create function** → Author from scratch:
   - Function name: `drex-data-export`
   - Runtime: **Python 3.12**
   - Architecture: x86_64
   - Execution role: **Use an existing role** → `drex-data-export-role`
2. Configuration → General configuration:
   - Handler: `lambda_function.lambda_handler`
   - Memory: **512 MB**
   - Timeout: **15 min 0 sec** (900 s — el worker procesa 27 secciones)
   - Ephemeral storage: 512 MB (default)
3. Environment variables (Configuration → Environment variables), **exactas**:

| Key | Value |
|---|---|
| `TABLE_NAME` | `drex-kv` |
| `EXPORTS_BUCKET` | `drex-exports-002493750027` |
| `COGNITO_USER_POOL_ID` | `us-east-1_kDSYEBsnY` |
| `EXPORT_TTL_DAYS` | `7` |
| `EXPORTS_SSE` | `AES256` |
| `PRESIGNED_TTL_SECONDS` | `900` |
| `RL_EXPORT_USER_MAX` | `3` |
| `RL_EXPORT_USER_WINDOW_S` | `3600` |
| `RL_EXPORT_IP_MAX` | `100` |
| `RL_EXPORT_IP_WINDOW_S` | `3600` |
| `RL_DOWNLOAD_USER_MAX` | `30` |
| `RL_DOWNLOAD_USER_WINDOW_S` | `3600` |
| `CORS_ALLOWED_ORIGINS` | `https://floreseternasoporte-creator.github.io,https://drex.glamworksapps.workers.dev,https://getdrex.com,https://www.getdrex.com` |

4. **Code** → Upload from → `.zip file` → subir `drex-data-export-lambda.zip`.

---

## Paso 5 — Function URL (punto de entrada HTTP)

1. Configuration → **Function URL** → Create:
   - Auth type: **NONE** (la autenticación es propia: `Authorization: Bearer <accessToken>` verificado contra Cognito dentro del código)
   - Configure CORS:
     - Allow origin: solo estos 4 (uno por línea / separados por coma):
       - `https://floreseternasoporte-creator.github.io`
       - `https://drex.glamworksapps.workers.dev`
       - `https://getdrex.com`
       - `https://www.getdrex.com`
     - Allow methods: `POST, OPTIONS`
     - Allow headers: `Authorization, Content-Type`
     - Max age: `3600`
2. **Copiar la Function URL** generada (formato `https://xxxx.lambda-url.us-east-1.on.aws/`).

---

## Paso 6 — Sweep diario (EventBridge)

1. Consola EventBridge → Rules → **Create rule**:
   - Name: `drex-export-sweep`
   - Schedule: `rate(1 day)` (o `cron(0 4 * * ? *)` — 04:00 UTC)
   - Target: Lambda function → `drex-data-export`
   - Input: Constant (JSON text): `{"internal":"sweep"}`
2. Verificar que el rol del target puede invocar la Lambda (EventBridge lo crea
   automáticamente al guardar la regla desde consola).

> El sweep: marca `expired` los jobs `ready`/`failed`/`downloaded` vencidos y
> borra jobs + objetos S3 de cuentas Cognito que ya no existen (TTL de DynamoDB
> como red de seguridad).

---

## Paso 7 — Conectar el cliente

En `~/workspace/drex-centro/index.html` (línea junto a `drex-data-export.js`):

```html
window.DREX_EXPORT_BACKEND_URL = 'https://xxxx.lambda-url.us-east-1.on.aws/';
```

Reemplazar con la Function URL real del paso 5. Sin esto, el cliente muestra
"El servicio de exportación aún no está configurado" (comportamiento intencional).

> ⚠️ **No inventar ni hardcodear una URL distinta.** Solo la del paso 5.

---

## Paso 8 — Pruebas post-despliegue (consola, cuenta de prueba)

Con una **cuenta de prueba** (nunca una cuenta real del usuario):

1. **Request feliz**: `POST {action:"request", format:"json"}` con `Authorization: Bearer <accessToken>`
   → `200 {jobId, status:"requested"}`; la Lambda se auto-invoca (revisar
   CloudWatch Logs: `evt: worker_ready`, 27 secciones).
2. **Idempotencia**: segundo request → `200 {alreadyActive:true, jobId}` (sin duplicar worker).
3. **Sin token / token malo** → `401 {error:"invalid_token"}`.
4. **Rate limit**: 4º request en la misma hora → `429 {error:"too_many_requests"}`.
5. **Job listo**: esperar `ready` (puede tardar minutos según el tamaño de la cuenta) →
   `POST {action:"download-url", jobId}` → `200 {url, filename, sha256, expiresIn:900}`.
   Descargar la URL en navegador: debe bajar el JSON/HTML y el sha256 debe coincidir.
6. **Anti-IDOR**: `download-url` con `jobId` de OTRO usuario → `404` genérico.
7. **Expirado**: job con `expiresAt` pasado → `410 {error:"job_expired"}`.
8. **CORS**: preflight OPTIONS desde un origen NO listado → sin header
   `Access-Control-Allow-Origin`.
9. **Privacidad**: revisar el JSON descargado — no debe contener `twoFactorSecret`,
   `hashes`, endpoints push, tokens, ni datos de otros usuarios.
10. **Sweep**: invocar manualmente con `{"internal":"sweep"}` → CloudWatch
    `evt: sweep_done`.

---

## Paso 9 — Enganchar al borrado de cuenta (recomendado, no bloqueante)

Cuando se implemente el borrado de cuenta del usuario, invocar la misma lógica
del sweep para el `sub` borrado: eliminar `users/<sub>/dataExports/*` en
`drex-kv` y los objetos `exports/<sub>/*` en S3. Hoy el sweep diario ya cubre
cuentas Cognito eliminadas.

---

## Orden de verificación final

- [ ] Bucket creado con Block Public Access ON, SSE-S3, lifecycle 7 días, policy Deny HTTP
- [ ] TTL de `drex-kv` = `ttl`
- [ ] Rol `drex-data-export-role` con trust `lambda.amazonaws.com` + `AWSLambdaBasicExecutionRole` + policy inline exacta
- [ ] Lambda `drex-data-export` (Python 3.12, 512 MB, 900 s, handler `lambda_function.lambda_handler`, 13 env vars, ZIP subido)
- [ ] Function URL con AuthType NONE y CORS restringido a los 4 orígenes
- [ ] Regla EventBridge `drex-export-sweep` diaria con payload `{"internal":"sweep"}`
- [ ] `window.DREX_EXPORT_BACKEND_URL` configurada en `index.html`
- [ ] Las 10 pruebas del paso 8 en verde
- [ ] La Lambda de login y el User Pool intactos (no se tocan)

## Prohibido en este despliegue

- No desplegar nada distinto de `drex-data-export-lambda.zip`.
- No modificar la Lambda de login/username ni el User Pool.
- No relajar CORS, el Block Public Access ni el lifecycle de 7 días.
- No aceptar `uid` del body del cliente como identidad (la Lambda ya lo impide).
