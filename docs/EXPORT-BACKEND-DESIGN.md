# Diseño: backend durable para "Descargar mis datos"

**Fecha:** 2026-09-21 · **Estado:** diseño aprobado para implementar (NO implementado aún)
**Contexto:** el flujo actual (`drex-data-export.js`) ensambla el archivo en el navegador: si el usuario cierra la pestaña, la preparación muere. Este diseño mueve la preparación al servidor y el archivo a almacenamiento durable, estilo Meta: solicitar → preparar (minutos a días) → notificar in-app → descargar, sobreviviendo al cierre de la pestaña.
**Referencias:** `docs/DATA-SCHEMA.md` (38 categorías → 27 secciones, exclusiones obligatorias), `drex-data-export.js` (contrato cliente actual).

---

## 1. Decisión de arquitectura

**Nueva Lambda `drex-data-export` (Python 3.12) + bucket S3 privado + jobs en `drex-kv`.** La Lambda de login (`drex-username-resolve`) **no se toca**: sigue intacta.

```
 Cliente (GitHub Pages)                AWS us-east-1
 ──────────────────────                ─────────────
 requestExport() ──POST /request──────▶ Lambda drex-data-export
   {format, browserSnapshot?}           │ 1. verifica access token (Cognito GetUser)
                                        │ 2. rate limit (DynamoDB pk='ratelimit')
                                        │ 3. crea job users/<sub>/dataExports/<jobId>
                                        │ 4. invoca worker ASYNC (Event)
                                        │◀── 200 {jobId, status:'requested'}
                                        │
 Cliente cierra la pestaña. No pasa nada.
                                        │ Worker (misma Lambda, invocación async):
                                        │  status→preparing, lee 27 secciones con
                                        │  límites, checkpoint de progreso en el
                                        │  job, ensambla JSON (+HTML), sube a S3,
                                        │  status→ready, escribe notificación in-app
                                        ▼
 Días después el usuario vuelve ──GET job (DynamoDB directo, como hoy)
   ve "Lista" ──POST /download-url────▶ Lambda verifica token + titularidad
                                        │◀── 200 {url: presigned GET 15 min}
 Navegador descarga directo desde S3 ──▶ (el archivo vive 7 días)
```

### Alternativas evaluadas

| Opción | Veredicto |
|---|---|
| **A. Elegida: worker Lambda + S3 + presigned URLs** | Sobrevive al cierre de pestaña; sin servidores que administrar; costo ~centavos por exportación; sin dependencias nuevas en el zip (boto3 ya está en el runtime). |
| B. Guardar el archivo en DynamoDB (chunks) | **Rechazada:** límite 400 KB/ítem → decenas de ítems por exportación con media; más caro y más lento que S3; escaneos caros para descargar. |
| C. Cliente ensambla + sube a S3 con PUT pre-firmado | **Rechazada como principal:** el ensamblaje seguiría muriendo al cerrar la pestaña (el requisito explícito del usuario). Queda como plan B si el worker Lambda resultara insuficiente. |
| D. Step Functions / Fargate / EC2 | **Rechazada:** sobreingeniería para volúmenes actuales; la Lambda de 15 min con auto-continuación cubre el caso (ver §5). |
| E. Servir el archivo desde GitHub Pages o URL pública | **Rechazada:** expondría PII; viola el requisito de acceso controlado. |

---

## 2. Componentes y nombres concretos

| Componente | Nombre / valor |
|---|---|
| Lambda | `drex-data-export` · runtime Python 3.12 · handler `lambda_function.lambda_handler` · memoria 512 MB · timeout 15 min |
| Function URL | nueva, `AuthType: NONE` (la autenticación es por access token en código, igual que la Lambda de login es pública con lógica propia) · CORS restringido a los orígenes oficiales de Drex (misma allowlist que `drex-username-resolve`) |
| Bucket S3 | `drex-exports-002493750027` (región `us-east-1`) · privado · **Block Public Access ON** · SSE-S3 · sin versionado · lifecycle: borrar objetos con prefijo `exports/` a los **7 días** |
| Clave del objeto | `exports/<sub>/<jobId>.json` y `exports/<sub>/<jobId>.html` (el `<sub>` en la clave evita colisiones y facilita limpieza por usuario) |
| Job (DynamoDB `drex-kv`) | `pk='users'`, `sk='<sub>/dataExports/<jobId>'`, `v` = JSON (§3) — **mismo esquema que ya usa el cliente**, el worker solo lo actualiza |
| Notificación in-app | `pk='notifications'`, `sk='<sub>/<notifId>'`, `v` = JSON `{type:'data_export', title, body, jobId, ts, read:false}` (el cliente ya renderiza `notifications/<uid>`) |
| Rate limit | `pk='ratelimit'`, `sk='export/<sub>'` y `sk='exportip/<ip>'` (mismo patrón de UpdateItem condicional que la Lambda de login) |
| Limpieza diaria | regla EventBridge `drex-export-sweep` (cron diario) → invoca la Lambda con `{"internal":"sweep"}` |
| TTL DynamoDB | atributo `ttl` (epoch seconds) en el ítem del job = `expiresAt + 30 días`. **Verificar antes de implementar:** si `drex-kv` ya tiene TTL habilitado con otro atributo, reutilizar estrategia de borrado en `sweep` en vez de pelear por el atributo |

---

## 3. Ciclo de vida del job (esquema del ítem)

```jsonc
// pk='users', sk='<sub>/dataExports/<jobId>'
{
  "jobId": "ex_9f3a…",            // uuid hex, generado en servidor
  "format": "json",               // 'json' | 'html' (pedido por el cliente)
  "status": "requested",          // requested → preparing → ready | failed ; expired lo marca sweep
  "progress": { "done": 0, "total": 27, "current": null },  // current = id de sección en curso
  "summary": null,                // al terminar: {sections:27, items:1234, bytes:482113, ms:8123}
  "fileKey": null,                // 'exports/<sub>/<jobId>.json' cuando ready
  "fileSize": null,
  "fileSha256": null,             // integridad verificable por el cliente
  "error": null,                  // {code:'worker_error'|'too_large', message:'…'} mensaje genérico, sin PII
  "createdAt": 1758412345000,     // ms
  "updatedAt": 1758412345000,     // ms
  "expiresAt": 1759017145000,     // ms = createdAt + 7 días → el archivo deja de existir
  "ttl": 1761609145,              // s = expiresAt + 30 días → el registro histórico se auto-borra
  "attempts": 1,
  "workerToken": "…32 bytes hex…",// anti-confused-deputy para la auto-continuación (§5)
  "requestedFrom": "web"
}
```

Estados y transiciones:

- `requested`: creado por `action=request`. Solo puede haber **un** job en `requested`/`preparing` por usuario (idempotencia: si existe, se devuelve el existente).
- `preparing`: el worker lo marca al empezar; actualiza `progress` tras cada sección (el cliente sigue haciendo polling directo a DynamoDB, **sin cambios** en esa ruta).
- `ready`: archivo en S3 + `fileKey`/`fileSize`/`fileSha256` + notificación in-app. El cliente pide `download-url`.
- `failed`: el worker registra `error` genérico; el cliente ofrece **reintentar** (crea un job nuevo; el fallido queda en el historial).
- `expired`: lo marca el `sweep` diario cuando `now > expiresAt` (el objeto S3 ya lo borró el lifecycle). El cliente muestra "Expirada → solicitar de nuevo". A los 30 días el TTL de DynamoDB borra el registro.

---

## 4. Contrato API (Function URL de `drex-data-export`)

Todas las respuestas llevan CORS restringido y `Content-Type: application/json`. Errores **genéricos** (sin enumeración de usuarios): 401 `invalid_token`, 404 `not_found` (también para jobs ajenos: no se distingue "no existe" de "no es tuyo"), 409 `not_ready` / `already_active`, 429 `too_many_requests`.

### 4.1 `POST /` `{action:'request', format:'json'|'html', browserSnapshot?}`

- **Auth:** header `Authorization: Bearer <accessToken de Cognito>`.
- **Body opcional `browserSnapshot`:** objeto ≤ 64 KB con las categorías que solo existen en el navegador (`drex_hidden_posts`, `drex_music_history`, borradores `drex_chat_draft_*`, `drex_translation_settings`, idioma). Se capturan **en el momento de la solicitud** y el worker las incluye como sección `browserData`. Así los datos locales también sobreviven al cierre de la pestaña. El servidor **nunca** lee `CognitoIdentityServiceProvider.*` (tokens): el cliente no los envía y el snapshot los excluye por construcción.
- **Pasos:** ① verifica token (§7); ② rate limit: 3 solicitudes/hora por usuario, 100/hora por IP; ③ si hay job en `requested`/`preparing` → 200 con ese job (idempotente); ④ crea el job (`requested`), genera `workerToken`; ⑤ invoca el worker async (`InvocationType:'Event'`, payload `{"internal":"worker","jobId","sub","format","workerToken","cursor":null}`); ⑥ responde:
```json
{ "jobId": "ex_9f3a…", "status": "requested",
  "message": "Solicitud recibida. Estamos preparando tu archivo; te avisaremos cuando esté listo." }
```

### 4.2 `POST /` `{action:'download-url', jobId}`

- **Auth:** igual que 4.1.
- **Pasos:** ① verifica token; ② lee el job; ③ comprueba `sk` pertenece al `sub` del token, `status=='ready'`, `now < expiresAt`, y que el objeto existe en S3 (`HeadObject`); ④ genera **presigned GET de 15 minutos** y responde:
```json
{ "url": "https://drex-exports-….s3.amazonaws.com/exports/…?X-Amz-…",
  "expiresIn": 900, "filename": "drex-mis-datos-2026-09-21.json",
  "sha256": "…", "size": 482113 }
```
- El navegador descarga directo de S3 (rango/retries nativos). El cliente puede verificar el sha256 tras descargar.

### 4.3 Interno: worker (`{"internal":"worker", …}`)

No llega por la Function URL (llega por `lambda:InvokeFunction`). Validaciones: `workerToken` del payload == el del job (comparación en tiempo constante); si no coincide → abortar (confused deputy). Pasos:

1. `status→preparing`, `progress={done:0,total:27,current:null}`.
2. Por cada una de las **27 secciones** (mismo orden y **mismos límites** que el cliente: `posts:200, comments:500, notifs:100, convs:50, msgsPerConv:50, mediaPosts:50, global:100`): lee de `drex-kv`/`drex-support-tickets`/Cognito, aplica **las exclusiones de `DATA-SCHEMA.md`** (secretos, datos ajenos, transitorio, infra) + `stripSecretsDeep()` equivalente en Python, actualiza `progress` tras cada sección.
3. **Checkpoint de continuación:** si `context.get_remaining_time_in_millis() < 60_000` y quedan secciones → guarda `cursor={nextSection, lastKey}` en el job y se **auto-invoca** async con el cursor. (Raro en la práctica; el mecanismo existe para no truncar nunca.)
4. Ensambla el JSON final `{exportedAt, format, sections:[{id,title,status,data,count,note}], excluded:[{id,reason}], summary}`; si `format=='html'`, renderiza además el informe HTML desde la misma estructura (plantilla Python determinista, sin JS).
5. `PutObject` a S3 con `ContentType`, `ServerSideEncryption:'AES256'`, metadata `sha256`.
6. `status→ready` + `summary` + escribe la **notificación in-app** (`notifications/<sub>/…`, `type:'data_export'`).
7. En excepción: `status→failed`, `error` genérico, notificación `type:'data_export'` de fallo con botón reintentar. **Nunca** se escribe PII ni el `sub` en CloudWatch: solo `jobId`, sección en curso y clase de error.

### 4.4 Interno: `sweep` (EventBridge diario)

`{"internal":"sweep"}` → por cada job con `expiresAt < now` y `status in (ready, failed)` → `status='expired'` (el objeto S3 ya lo borró el lifecycle de 7 días). Opcional: si el usuario eliminó su cuenta (perfil inexistente), borra jobs y objetos de inmediato. **Checklist:** enganchar este borrado al flujo de eliminación de cuenta.

---

## 5. Lecturas del worker: qué lee y cómo (acotado)

El worker **solo** lee datos del `sub` dueño del job. Patrón por sección (Query con `KeyConditionExpression`, paginado; Scan **solo** donde el filtro es por `authorId`, con `Limit` y `FilterExpression`):

| Sección | Lectura |
|---|---|
| account | `cognito-idp:AdminGetUser(Username=sub)` → `sub, email, email_verified, name, picture`. Sin hashes ni tokens. |
| profile (+moved) | `Query pk='users' sk begins_with '<sub>/'` → filtra en código las subclaves de secciones propias (`devices, logins, sessions, ratings, recoveryCodes, twoFactorEnabled, supervisedBy, supervising, parentalControls, dataExports`) y excluye `twoFactorSecret`, `twoFactorBackupCodes`. |
| twoFactor | `GetItem users/<sub>/recoveryCodes` → solo `{generatedAt, usedCount}`; estado 2FA de `AdminGetUser` (`UserMFASettingList`) + `twoFactorEnabled`. |
| interests, savedPosts/Folders/Comments, userSettings, security prefs, profileNotes, userCollabs, userEcos/userReposts, userVotes, userCommentVotes, following/followers/followRequests, blocks, chatMutes/groupMutes/chatThemes/chatDeletedForMe/conversationReadAt, correctionHelpful | `GetItem`/`Query` directos por `pk` + `sk='<sub>[…]'` (lecturas puntuales, baratas). |
| posts + media | `Scan communityNotes` con `FilterExpression authorId=:uid`, `Limit` 200 → por cada post (máx 50 con media) `GetItem noteImages/<id>`, `noteVideos/<id>`; si un `data:` base64 supera el tope, se incluye solo la URL/metadata y se anota. |
| comments | `Scan postComments` filtrado por `authorId` (límite 500) + `Query userComments sk begins_with '<sub>/'`. Normalizar `authorEmail` → email del usuario (ya lo tiene del token). |
| conversations | `Query userConversations sk begins_with '<sub>/'` (máx 50 convs) → por cada una `Query conversationMessages pk='<convId>'` (máx 50 msgs, ordenados). Incluye mensajes de interlocutores **dentro de sus conversaciones** (documentado en la UI, igual que Meta). |
| notifications | `Query notifications sk begins_with '<sub>/'` límite 100. |
| logins (50), devices, sessions | `Query users sk begins_with '<sub>/logins/'` etc. (sin IP por diseño; `ip` ya es null). |
| fiestas | `Scan fiestas` filtrado `hostId==uid` + `Query fiestaMembers sk begins_with '<fiestaId>/<uid>'`, `fiestaSignals`, `fiestaKicked`. |
| groups | `Scan groups` filtrado por creador `== uid`. |
| music | `Scan musicTracks` filtrado `authorId==uid` (metadata; **audio excluido en v1**, como hoy) + `musicPlaylists`, `musicFavorites`, `musicVotes` por `sk begins_with '<sub>/'`. |
| languages | `GetItem userLanguages/<sub>` + `Scan languageExercises` filtrado `authorId==uid` + `Query exerciseCorrections` por `sk` con `<exId>/<uid>`. |
| appeals | `Scan appeals` filtrado `authorId==uid`. |
| moderation reports | `Scan commentModerationQueue` filtrado `authorId==uid`, `contentPreview` ya truncado a 180. |
| support tickets | tabla `drex-support-tickets`: `Query` GSI `byUser` (`userId==sub`). |
| parental | `GetItem users/<sub>/supervisedBy|supervising|parentalControls/dailyLimitMins`; `parentalLinkCodes`: solo metadata de usados/vencidos. |
| ratings recibidas | `Query users sk begins_with '<sub>/ratings/'`. (Las dadas viven bajo otros usuarios: **no intentables**, documentado.) |
| browserData | del `browserSnapshot` del request (sin tokens). |

**Exclusiones duras** (heredadas de `DATA-SCHEMA.md`, aplicadas también en el worker): `pushSubscriptions` completa, `recoveryCodes.hashes`, `twoFactorSecret`, `twoFactorBackupCodes`, `parentalLinkCodes` activos, tokens Cognito, datos de otros usuarios, `ratelimit`, `userCount`, `revokeOtherSessions`, `usernames/`, transitorio (`typing`, `userPresence`, `fiestaReactions`, flags de UI), `musicAudio`.

---

## 6. IAM exacto (rol nuevo `drex-data-export-role`)

Política inline `drex-export-backend` (cuenta `002493750027`, región `us-east-1`):

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
      "Action": ["s3:ListBucket"],
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

Notas:
- **Lecturas abiertas a todos los `pk`**: el worker necesita `communityNotes`, `conversationMessages`, `musicTracks`, etc. La contención es por código (todo filtro exige `authorId/sub == dueño del job`) + `workerToken` + titularidad verificada en `download-url`. Es el mismo nivel de confianza que ya tiene la Lambda de login con `users/`.
- **Escrituras acotadas** con `dynamodb:LeadingKeys` (mismo patrón ya aprobado en `drex-login-backend`): solo `users/` (jobs), `notifications/` y `ratelimit/`. El worker **no puede** escribir posts, chats ni perfiles ajenos aunque tuviera un bug.
- `cognito-idp:GetUser` es API pública (se autoriza con el propio access token); se incluye por claridad pero no requiere permiso del rol. `AdminGetUser` sí lo requiere (sección `account` autoritativa).
- Política de confianza (trust): `lambda.amazonaws.com` + `AWSLambdaBasicExecutionRole` gestionada para CloudWatch Logs.

### Bucket S3 (crear con)

- `Block Public Access`: todo ON. Política del bucket: `Deny` a `aws:SecureTransport == false` (solo HTTPS).
- Lifecycle: `Expiration: 7 días` sobre prefijo `exports/` (+ `AbortIncompleteMultipartUpload` a 1 día, por si se usa multipart en el futuro).
- SSE-S3 por defecto (sin costo). Sin versionado. Etiqueta `proyecto=drex`, `datos=pii`.

---

## 7. Autorización por access token (sin dependencias nuevas)

El cliente envía `Authorization: Bearer <accessToken>`. La Lambda llama **`cognito-idp:GetUser(AccessToken=token)`** (API pública, sin IAM):

- Token inválido/expirado/revocado → `NotAuthorizedException` → **401** genérico.
- Válido → devuelve `Username` (= `sub`) y atributos. El `sub` **es** la identidad: el `uid` nunca se acepta del body (anti-IDOR).
- Ventaja frente a verificar JWT con JWKS: **cero dependencias** en el zip (boto3 ya viene en el runtime), y respeta revocación global de tokens (sign-out) automáticamente. Costo: 1 llamada a Cognito por request (~50 ms). Optimización futura: cachear JWKS y verificar firma local si el volumen lo pide.

Rate limit (mismo patrón de la Lambda de login, `UpdateItem` condicional + `ADD` sobre `pk='ratelimit'`):
- `export/<sub>`: 3 solicitudes/hora (una exportación real tarda minutos; 3/hora sobra y frena abuso).
- `exportip/<ip>`: 100/hora.
- `download-url`: 30/hora por usuario (las URLs duran 15 min; no hay razón legítima para pedir más).

---

## 8. Notificación in-app

Al pasar a `ready` (o `failed`), el worker escribe `pk='notifications'`, `sk='<sub>/exp_<jobId>'`:

```json
{ "type": "data_export", "title": "Tu archivo de datos está listo",
  "body": "Tu copia de datos de Drex está lista para descargar. Disponible por 7 días.",
  "jobId": "ex_9f3a…", "timestamp": 1758412345000, "read": false }
```

El cliente ya renderiza `notifications/<uid>` y dispara aviso del sistema; el tipo `data_export` no está silenciado por ninguna preferencia (auditado 2026-09-20). El deep-link abre el Centro de Seguridad → "Descargar mis datos". **Privacidad:** la notificación no contiene datos del usuario, solo el aviso.

---

## 9. Estimación de costo (orden de magnitud, us-east-1)

Supuestos: exportación típica con los límites v1 (≤200 posts, ≤500 comentarios, ≤50 convs×50 msgs, resto puntual).

| Concepto | Costo típico por exportación |
|---|---|
| Lambda worker (512 MB, ~5–20 s, 1–3 invocaciones) | $0.0001 – $0.0005 |
| DynamoDB on-demand: ~2k–8k lecturas (mayoría `Query` paginadas; los `Scan` con `Limit`+filtro consumen por KB escaneado) | $0.001 – $0.01 |
| S3: PUT + 7 días de ~0.5–5 MB + 1 GET | < $0.0001 |
| Cognito `GetUser`/`AdminGetUser` | $0 |
| **Total típico** | **< $0.01** |
| Usuario pesado (miles de mensajes, 50 posts con media) | $0.02 – $0.10 (dominado por el `Scan` de `conversationMessages`) |

Costo fijo mensual: **$0** (sin nada provisionado; la regla EventBridge diaria cuesta ~$0). Incluso con 1,000 exportaciones/mes, el total queda en un dígito de dólares. El `Scan` de mensajes es el único costo con cola larga: si un usuario supera ~10k mensajes, el worker lo procesa por tandas con el mecanismo de continuación (§4.3) y el costo sigue siendo lineal y bajo.

---

## 10. Riesgos de seguridad y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Robo de access token → un atacante pide la exportación de la víctima | HTTPS obligatorio; tokens de 1 h; rate limit 3/h; la **notificación in-app** avisa al dueño real; URLs de descarga de 15 min; el atacante además necesitaría el token vigente (misma exposición que leer la app). |
| IDOR (pedir el job de otro) | El `sub` sale **solo** del token verificado; `download-url` devuelve 404 genérico si el job no es del `sub`; `workerToken` anti-confused-deputy en la auto-invocación. |
| Fuga por logs | Prohibido registrar `sub`, email, contenidos o el token. Solo `jobId`, sección y clase de error. Revisar con `grep` antes de cada deploy. |
| Bucket expuesto | Block Public Access ON + política `Deny` sin TLS + lifecycle 7 días + SSE. Verificar con `aws s3api get-public-access-block` tras crear. |
| Enumeración de usuarios | Todos los errores 401/404/409 genéricos; `request` no revela si un `sub` existe (el `sub` viene del token, no del body). |
| Exportación gigante / DoS económico | Límites v1 fijos (§5); tope de 1 job activo; rate limits; el worker aborta con `failed/too_large` si el JSON supera 50 MB (configurable). |
| Datos de terceros en chats | Se exportan **solo** las conversaciones del dueño (es su buzón, como Meta); documentado en la UI y en el `note` de la sección. |
| Cuenta eliminada con archivo pendiente | El `sweep` borra jobs+objetos de cuentas inexistentes; enganchar al flujo de eliminación de cuenta (checklist). |
| Cliente viejo / manipulado | El servidor no confía en el cliente: secciones, límites y exclusiones viven en el worker; el `browserSnapshot` se trata como datos no confiables (se valida tamaño y se sanitiza). |

---

## 11. Contrato con el cliente (`drex-data-export.js`)

La API pública **no cambia**: `requestExport({format})`, `getJobs()`, `getJob()`, `retryExport()`, `downloadExport()`, `renderInto()`, `onExportReady()`. Cambia la implementación interna:

- `requestExport` → `POST /request` (+ `browserSnapshot` capturado ahí mismo) → bottom sheet "Solicitud recibida" (igual que hoy).
- El polling de estado **sigue leyendo el job en DynamoDB** (sin cambios).
- `downloadExport` → `POST /download-url` → descarga del navegador desde S3 → verificación opcional de `sha256`.
- El ensamblaje por lotes en el navegador **se elimina** (o queda como fallback con flag si el backend no responde: decisión del ingeniero UI).
- i18n es/en/zh intacta; el mensaje honesto "de unos minutos a unos días" ahora es **verdad arquitectónica**.

---

## 12. Checklist de implementación (en orden)

1. [ ] Crear bucket `drex-exports-002493750027` (us-east-1): Block Public Access ON, SSE-S3, lifecycle 7 días en `exports/`, política Deny sin TLS. Verificar `get-public-access-block`.
2. [ ] Crear rol `drex-data-export-role` + política inline `drex-export-backend` (§6) + `AWSLambdaBasicExecutionRole`.
3. [ ] Habilitar/verificar TTL en `drex-kv` (atributo `ttl`); si ya existe con otro atributo, adaptar `sweep`.
4. [ ] Escribir `lambda_function.py`: acciones `request`, `download-url`, `worker`, `sweep`; verificación por `GetUser`; rate limit con el patrón existente; las 27 secciones con límites y exclusiones de §5; `stripSecretsDeep()` en Python; plantilla HTML determinista.
5. [ ] Empaquetar zip **solo** con `lambda_function.py` (sin dependencias externas: solo boto3 del runtime). `node --check` equivalente: `python -m py_compile`.
6. [ ] Harness local con fakes (DynamoDB/S3/Cognito stub): probar request→worker→ready, token inválido→401, job ajeno→404, expiración, reintento, continuación con cursor, `failed` en excepción.
7. [ ] Crear Lambda (512 MB, 15 min, env `TABLE=drex-kv`, `BUCKET=…`, `POOL_ID=us-east-1_kDSYEBsnY`, `SUPPORT_TABLE=drex-support-tickets`), Function URL pública con CORS de Drex, regla EventBridge diaria → `{"internal":"sweep"}`.
8. [ ] QA extremo a extremo con cuenta temporal: verificar token real, archivo real en S3, presigned URL descarga, **cierre de pestaña simulado** (request → matar cliente → worker termina → download-url días después simulado), expiración 7 días, exclusión de secretos (grep del JSON: sin `endpoint`, `p256dh`, `hashes`, `twoFactorSecret`), i18n es/en/zh.
9. [ ] Migrar `drex-data-export.js` al contrato §11; pruebas 45/45 del módulo + `node --check`.
10. [ ] Publicar (merge a `main`, push, rebuild GitHub Pages) y verificar bytes públicos.
11. [ ] Enganchar borrado de exportaciones al flujo de eliminación de cuenta.
12. [ ] Monitoreo: alarma CloudWatch si `failed/total > 5%` en 1 h; dashboard de latencia worker y tamaño medio.

**Fuera de alcance v1 (documentado, no prometido):** audio de `musicAudio`, media original en alta resolución (se exportan URLs/metadata), aumento de límites tras medir, verificación JWT local con JWKS (optimización).
