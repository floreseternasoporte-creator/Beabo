# Seguridad de DynamoDB (`drex-kv`) — mapa de acceso del cliente, riesgos y política IAM recomendada

**Fecha:** 2026-11-04 · **Alcance:** análisis estático del repositorio (sin acceso a AWS).
**Qué es esto:** un mapa de *lo que el navegador puede leer y escribir* en DynamoDB usando las credenciales de Cognito, las peores exposiciones que implica, una política IAM de mínimo privilegio recomendada, qué escrituras deben pasar a Lambdas y una lista de verificación paso a paso para comprobar el rol real en la consola de AWS.

> **Importante — qué NO sé.** No pude ver la consola de AWS. La política IAM *real* de los roles del Identity Pool no está en el repo. Todo lo marcado como **(probable)** depende de que esa política sea amplia, que es lo que el diseño del cliente obliga a que sea (ver §2). Hay que verificarlo con la lista de la §8 **antes** de dar nada por cierto o por grave.

---

## 1. Cómo accede el cliente a los datos

```
Navegador ──(login)──▶ Cognito User Pool  us-east-1_kDSYEBsnY   ──▶ ID token (JWT)
Navegador ──(JWT)───▶ Cognito Identity Pool us-east-1:92871635-d775-42e5-b161-8de1171d271a
                       └─▶ credenciales temporales de un ROL IAM (autenticado)
Navegador ──(SigV4)──▶ DynamoDB  tabla drex-kv (y drex-support-tickets)   ← directo, sin servidor intermedio
```

- Los identificadores (Identity Pool, User Pool, client id, nombre de tabla) están en `drex-cloud.js` (`AWS_CONFIG`). **Son públicos**: cualquiera que abra el sitio los ve. La seguridad descansa 100 % en la política IAM del rol.
- **Antes de iniciar sesión** el cliente usa `fromCognitoIdentityPool` *sin* `logins` → credenciales del **rol no autenticado** (`currentCredentials()`, `drex-cloud.js`). Al iniciar sesión pasa al rol autenticado (`configureAwsCredentials`).
- Las "reglas de seguridad" estilo Firebase **no existen**: `DrexCloud.database()` es solo una fachada en el navegador (`drex-cloud.js`). Un usuario que abra DevTools puede saltarse toda la lógica de la app y llamar a DynamoDB con sus credenciales.
- Operaciones DynamoDB que usa el cliente (verificado en `drex-cloud.js`, `V3_DOC_OPS`): `GetItem`, `PutItem`, `DeleteItem`, `Query`, `BatchWriteItem`, `TransactWriteItems`. **No usa `Scan` en `drex-kv`.** El bundle SDK v3 local (`drex-aws-v3.bundle.js`) no incluye `UpdateCommand` ni `ScanCommand`.
- Modelo de datos: `pk` = primer segmento de la ruta (la **colección**: `users`, `communityNotes`…), `sk` = el resto (donde va el `uid`, p. ej. `users` / `<uid>/name`).

## 2. La limitación estructural (por qué "por usuario" no se puede expresar hoy)

IAM solo puede condicionar DynamoDB por **clave de partición** (`dynamodb:LeadingKeys`) y por atributos. **No existe condición sobre la clave de ordenación.** Con el esquema actual, el `uid` está en la `sk`, así que IAM solo puede decir *"este rol puede tocar la colección `users`"*, **no** *"solo `users/<mi-uid>/…`"*.

Además:
- `${cognito-identity.amazonaws.com:sub}` es el **Identity ID** del Identity Pool (`us-east-1:xxxxxxxx-…`), **no** el `sub` del User Pool, que es el `uid` que usa la app. No coinciden, así que esa variable no sirve tal cual para esta app.
- La alternativa correcta son las **etiquetas de principal** (*Attributes for access control* del Identity Pool): se mapea el claim `sub` del User Pool a una etiqueta (p. ej. `uid`) y la política usa `${aws:PrincipalTag/uid}`. Esto solo funciona si el `uid` va **en la clave de partición** (`pk`), lo que exige cambiar el esquema (Fase 2, §6).

**Consecuencia:** hoy todo usuario autenticado tiene, en la práctica, permisos de **colección completa**: puede leer o escribir cualquier ítem de cualquier colección que el rol permita, incluso los de otros usuarios. Las comprobaciones de la app (`authorId == uid`, `isOwner`, etc.) son solo cosméticas.

## 3. Mapa de colecciones (`pk`) que toca el cliente

Obtenido de los `ref("<colección>/…")` literales de `index.html`, `drex-cloud.js`, `recovery-codes.js`, `drex-data-export.js`, `drex-rec-engine.js` y de `docs/DATA-SCHEMA.md`. Las colecciones armadas con variables (p. ej. `DREX_REC.profilePath`) están cubiertas por el esquema documentado; confirmar con CloudTrail (§8, paso 9).

| Grupo | Colecciones | Quién escribe hoy | Riesgo si el rol es amplio |
|---|---|---|---|
| **A. Solo servidor** (el cliente no las usa) | `wallets`, `transactions`, `stripe_events`, `ratelimit`; y `users/<uid>/orbit` (dentro de `users`) | Lambdas de pagos (`lambda-drex-payments`) y de login | **Crítico**: acuñar monedas / regalarse Orbit |
| **B. Identidad y secretos de cuenta** | `users` (perfil + `recoveryCodes`, `devices`, `sessions`, `supervisedBy`, `ratings`…), `userEmails` (email→uid), `usernames`, `usernameByUid`, `security`, `userSettings`, `pushSubscriptions`, `parentalLinkCodes`, `parentalLinkCodeByUser`, `parentalLinkAttempts`, `verifiedUsers` | Cliente | **Alto**: leer/alterar cuentas ajenas, enumeración de correos, saltar 2FA de recuperación, falsificar verificación |
| **C. Mensajería privada** | `conversationMessages`, `conversations`, `userConversations`, `groupChats`, `chatFiles`, `chatUnread`, `chatMutes`, `chatThemes`, `chatSettings`, `chatDeletedForMe`, `conversationPinned`, `conversationReadAt`, `msgReactions`, `typing`, `callSignals`, `blendFeeds`, `groupMutes` | Cliente | **Alto**: leer/borrar/suplantar chats ajenos |
| **D. Moderación y soporte** | `reports`, `appeals`, `commentModerationQueue` (incluye `authorEmail`), `careerApplications`, tabla `drex-support-tickets` | Cliente | **Alto**: PII de terceros legible; tickets de soporte |
| **E. Contenido público por diseño** | `communityNotes`, `postComments`, `noteImages`, `noteVideos`, `noteAudios`, `notesByAuthor`, `musicTracks`/`musicAudio`/…, `snapshots`/`snapImages`/…, `fiestas*`, `followers`, `following`, `blocks`, `savedPosts`, `userVotes`, `userEcos`… | Cliente | **Medio**: suplantar autoría, editar/borrar contenido ajeno, inflar votos |
| **F. Contadores/estado compartido** | `userCount`, `appmetrics`, `spotlight`, `spotlightNotified`, `musicWeekly`, `musicDailyCount`, `viewMilestoneNotified`, `featuredArtistsNotified`, `fiestaGameSecrets` | Cliente | **Medio**: manipulación de métricas/rankings; secretos de juegos legibles |

(Clasificación por análisis estático del código; no sustituye a la verificación con CloudTrail de la §8.)

## 4. Peores exposiciones (de más a menos grave)

> Gravedad **(probable)** = asume que el rol permite acceso a toda la colección, que es lo que necesita la app hoy.

1. **Monedas y suscripciones (Crítico, probable).** Si el rol autenticado permite `PutItem` sobre `drex-kv` sin acotar por `LeadingKeys`, cualquier usuario puede escribir `wallets/<uid>/coins` o `users/<uid>/orbit`. El cliente no toca esas claves (verificado), por lo que **bloquearlas con un `Deny` explícito no rompe nada** (§5-A). Esta es la corrección #1.
2. **Insignia verificada falsificable y correos filtrados (Alto, confirmado en código).** `ivOnVerified()` y la sincronización de `index.html` escriben `verifiedUsers/<uid> = {at, by, em}` **desde el navegador**; cualquiera puede autoverificarse o verificar a otros. Además `refreshVerifiedUsersCache()` descarga **la colección completa** `verifiedUsers` en cada cliente, y cada entrada trae `em` = **correo** del usuario verificado → todo usuario (y el rol no autenticado, si tiene lectura) puede obtener los correos de todas las cuentas verificadas.
3. **Lectura de cuentas antes de autenticar (Alto, probable).** La pantalla de login hace `usernames/<nombre>`, `userEmails/<correo>` y `users/<uid>` **sin sesión** (tarjeta de usuario del paso de contraseña). Para que eso funcione, el **rol no autenticado** debe poder leer `users`, `usernames` y `userEmails`: cualquiera en internet (con el Identity Pool ID público) puede enumerar correos↔uid y leer perfiles.
4. **Suplantación y vandalismo entre usuarios (Alto).** Sin condiciones por usuario, un usuario puede escribir `communityNotes/<id>` con otro `authorId`, `conversationMessages` con otro `senderId`, `notifications/<otroUid>/…`, borrar publicaciones/chats ajenos o editar `users/<otro>/…` (perfil, bio, `supervisedBy`, etc.).
5. **Mensajes privados legibles (Alto).** `conversationMessages` se consulta por `convId`; los `convId` de un usuario se obtienen leyendo `userConversations/<uid>` (también abierto). Con acceso a la colección completa se pueden leer chats ajenos.
6. **Recuperación de 2FA manipulable (Alto, probable).** Los hashes de códigos de respaldo viven en `users/<uid>/recoveryCodes` (`recovery-codes.js`) y el canje de login lo hace una Lambda leyendo ese ítem. Si cualquier usuario autenticado puede escribir en `users`, un atacante que ya tenga la contraseña de la víctima puede reemplazar los hashes por los suyos y saltarse el 2.º factor. (La Lambda `drex-username-resolve` no está en el repo: verificarlo.)
7. **Tickets de soporte (Medio/Alto).** `drex-support-tickets` guarda `userEmail` y mensajes. El control "solo el dueño" (`SUPPORT_OWNER_EMAIL`, `supportApi.isOwner()`) es **solo del lado del cliente**. Hoy `adminListTickets` (Scan) y `adminReply`/`adminSetStatus` (Update) **no pueden ejecutarse** porque el bundle SDK v3 no incluye esos comandos, pero si el rol tuviera `Scan`/`UpdateItem` en esa tabla, cualquiera podría volcar todos los tickets. El rol de cliente **no debe** tener `Scan`/`UpdateItem` allí.
8. **Moderación y solicitudes (Medio).** `commentModerationQueue` guarda `authorEmail`; `reports`, `appeals`, `careerApplications` son bandejas que el cliente solo debería poder *añadir*, no leer.

## 5. Política IAM recomendada (por fases, de menor a mayor esfuerzo)

Cuenta `002493750027`, región `us-east-1` (tomados de `docs/EXPORT-BACKEND-DESIGN.md`). **Es una propuesta, no se desplegó nada.** Probar siempre en el *Policy Simulator* (§8) y con una cuenta de prueba antes de aplicarla en producción.

### A. Fase 0 — `Deny` inmediato (cero impacto en la app, hacerlo hoy)

Añadir a **ambos** roles del Identity Pool (autenticado y no autenticado). Un `Deny` gana a cualquier `Allow` existente.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyColeccionesSoloServidor",
      "Effect": "Deny",
      "Action": "dynamodb:*",
      "Resource": [
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv",
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv/index/*"
      ],
      "Condition": {
        "ForAnyValue:StringEquals": {
          "dynamodb:LeadingKeys": ["wallets", "transactions", "stripe_events", "ratelimit"]
        }
      }
    },
    {
      "Sid": "DenyScanYUpdateEnTodo",
      "Effect": "Deny",
      "Action": ["dynamodb:Scan", "dynamodb:UpdateItem", "dynamodb:BatchGetItem"],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-support-tickets",
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-support-tickets/index/*"
      ]
    }
  ]
}
```

- Verificación previa: el cliente **no** usa `wallets`, `transactions`, `stripe_events` ni `ratelimit` (grep en `index.html`, `drex-cloud.js`). Las Lambdas usan **su propio rol**, no el del Identity Pool, así que no se afectan.
- Nota: el `UpdateItem` sobre `drex-kv` **sí** hay que dejarlo si se usan transacciones (`TransactWriteItems` exige los permisos de las operaciones individuales). Por eso el `Deny` de `UpdateItem` es solo para `drex-support-tickets`.
- `users/<uid>/orbit` está dentro de la colección `users`; no se puede bloquear por IAM hasta moverla a su propia colección (ver §6, ítem 4). Mientras tanto la defensa es el guard del cliente (§7) — **no es una barrera real**.

### B. Fase 1 — rol autenticado con lista blanca de colecciones

Reemplaza cualquier `dynamodb:*` o `Resource: "*"`. Sigue siendo acceso por colección (límite de §2), pero elimina todo lo que el cliente no usa.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ClienteDrexKv",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem", "dynamodb:Query",
        "dynamodb:PutItem", "dynamodb:DeleteItem",
        "dynamodb:UpdateItem", "dynamodb:BatchWriteItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": [
          "_health", "appeals", "appmetrics", "blendFeeds", "blocks", "callSignals", "careerApplications",
          "chatDeletedForMe", "chatFiles", "chatMutes", "chatSettings", "chatThemes", "chatUnread",
          "commentModerationQueue", "communityNotes", "conversationMessages", "conversationPinned",
          "conversationReadAt", "conversations", "correctionHelpful", "exerciseCorrections",
          "featuredArtistsNotified", "fiestaGameSecrets", "fiestaKicked", "fiestaMembers",
          "fiestaReactions", "fiestaSignals", "fiestas", "followRequests", "followers", "following",
          "groupChats", "groupMutes", "groups", "languageExercises", "msgReactions", "musicAudio",
          "musicByAuthor", "musicDailyCount", "musicFavorites", "musicPlaylists", "musicSearch",
          "musicTracks", "musicVotes", "musicWeekly", "noteAudios", "noteImages", "noteVideos",
          "notesByAuthor", "notifUnread", "notifications", "parentalLinkAttempts",
          "parentalLinkCodeByUser", "parentalLinkCodes", "postComments", "postEcos", "postReposts",
          "postSavedBy", "postsByFiesta", "postsByGroup", "profileNotes", "pushSubscriptions", "reports",
          "savedComments", "savedFolders", "savedPosts", "security", "snapImages", "snapMuted",
          "snapViews", "snapshots", "spotlight", "spotlightNotified", "typing", "userCollabs",
          "userCommentVotePosts", "userCommentVotes", "userComments", "userConversations", "userCount",
          "userEcos", "userEmails", "userInterests", "userLanguages", "userPollVotes", "userPresence",
          "userReposts", "userSettings", "userSnapshots", "userViews", "userVotes", "usernameByUid",
          "usernames", "users", "verifiedUsers", "viewMilestoneNotified"
          ]
        }
      }
    },
    {
      "Sid": "SoporteSoloCrearYConsultar",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-support-tickets",
        "arn:aws:dynamodb:us-east-1:002493750027:table/drex-support-tickets/index/byUser"
      ]
    }
  ]
}
```

- La lista sale del análisis estático: **confirmar con CloudTrail (§8, paso 9)** antes de quitar permisos amplios, o habrá errores `AccessDenied` en colecciones armadas con variables.
- `TransactWriteItems` se autoriza con los permisos de `PutItem`/`DeleteItem`/`UpdateItem` de cada operación; confirmarlo en el simulador.
- Desplegar en este orden: (1) la fase A, (2) esta política en un rol *nuevo* usado por un Identity Pool de pruebas, (3) migrar el pool real.

### C. Rol no autenticado (invitado)

La app lo usa al arrancar y en el paso de login (lecturas de `usernames`, `userEmails`, `users/<uid>`). **Actualización:** el paso de login ya no hace esas lecturas (ver `docs/SEGURIDAD-LOGIN-CUENTAS.md`, que incluye el paso de AWS para activar *Prevent user existence errors* y quitar la lectura de invitados). **Objetivo: desactivar el acceso de invitados** una vez que esas tres búsquedas se muevan a la Lambda `drex-username-resolve` (ya existe `usernameLoginUrl`). Hasta entonces, como mínimo:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvitadoSoloLecturaMinima",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem"],
      "Resource": "arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["_health", "usernames", "userEmails", "users"]
        }
      }
    }
  ]
}
```
(sin `Query`, sin escrituras: así no se puede listar la colección `users` entera; solo pedir un ítem con clave conocida.)

### D. Fase 2 (objetivo) — acceso por usuario con etiquetas de principal

1. Identity Pool → *User access* → **Attributes for access control**: mapear el claim `sub` del User Pool a la etiqueta `uid`.
2. Cambiar la clave de partición de las colecciones **privadas** a `"<coleccion>#<uid>"` (p. ej. `userSettings#<uid>`, `pushSubscriptions#<uid>`, `security#<uid>`, `savedPosts#<uid>`, `userVotes#<uid>`, `notifUnread#<uid>`…). Se puede hacer de forma transparente en el adaptador (`putLeaf`/`readLeaves` en `drex-cloud.js`) para que `ref("userSettings/<uid>/…")` siga funcionando, más un script de migración.
3. Política:

```json
{
  "Sid": "MisDatosPrivados",
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
  "Resource": "arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv",
  "Condition": {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": [
        "userSettings#${aws:PrincipalTag/uid}",
        "pushSubscriptions#${aws:PrincipalTag/uid}",
        "security#${aws:PrincipalTag/uid}",
        "savedPosts#${aws:PrincipalTag/uid}"
      ]
    }
  }
}
```
*(Confirmar en la consola el nombre exacto de la etiqueta y que la variable `${aws:PrincipalTag/uid}` se resuelve; no pude probarlo.)* Esto cubre solo lo **privado de un solo dueño**. Lo compartido (contenido público, chats entre dos personas, seguidores) sigue necesitando Lambdas.

## 6. Escrituras que deben moverse a Lambdas (con verificación del JWT y `uid` = `sub` del token)

Prioridad por riesgo:

| # | Escritura actual en el cliente | Por qué | Reemplazo |
|---|---|---|---|
| 1 | `verifiedUsers/<uid>` (`ivOnVerified`, sincronización de `users.verified`) | Insignia falsificable + correo `em` público | La Lambda de verificación de identidad (ya existe) escribe `verified` tras validar; **quitar `em`** y reemplazar la lectura de toda la colección por un campo `verified` en el perfil público |
| 2 | `userEmails/*`, `usernames/*`, `usernameByUid/*` | Unicidad y anti-enumeración | Lambda *Post-confirmation* de Cognito (alta) + endpoint de cambio de usuario; búsquedas pre-login vía `drex-username-resolve` |
| 3 | `users/<uid>/recoveryCodes`, `twoFactor*`, `supervisedBy`, `supervising`, `devices`, `sessions`, `security/*`, `parentalLink*` | Controles de seguridad de la cuenta | Lambda "cuenta/seguridad" |
| 4 | `users/<uid>/orbit` (hoy escribe la Lambda de pagos) | Mezclado con `users` | Mover a colección propia `orbit/<uid>` para poder prohibir su escritura por IAM; el cliente solo la lee |
| 5 | Escrituras cruzadas: `notifications/<otro>`, `followers/<otro>/…`, `followRequests`, contadores `notifUnread`/`chatUnread`, votos/ecos sobre `communityNotes/<id>` | Un usuario no debe escribir en el espacio de otro | Lambdas `follow`, `vote`, `notify` (o procesar con DynamoDB Streams) |
| 6 | `reports`, `appeals`, `commentModerationQueue`, `careerApplications`, `drex-support-tickets` (crear) | PII/moderación; el cliente solo debe poder *añadir* | Lambda `submit` (escritura-solo, sin lectura); el `userId`/correo se toma del JWT |
| 7 | Soporte (admin): `adminListTickets`, `adminReply`, `adminSetStatus` | El chequeo de "dueño" es solo cliente | Lambda con grupo de Cognito `admin`; quitar `SUPPORT_OWNER_EMAIL` del cliente |
| 8 | `userCount`, `appmetrics`, `spotlight*`, `musicWeekly`, `musicDailyCount`, `viewMilestoneNotified`, `featuredArtistsNotified` | Métricas/rankings manipulables | Lambda de eventos / EMF en CloudWatch |
| 9 | `fiestaGameSecrets` | Secretos de juego legibles por todos | Lambda que revela solo lo permitido |

Ya están bien (solo Lambda): pagos/Stripe (`wallets`, `transactions`, `stripe_events`), exportación de datos, login por usuario.

## 7. Endurecimiento incluido en este PR (cliente)

- `drex-cloud.js` (y su copia `drex-cloud.v3.js`): el adaptador DynamoDB rechaza **en el cliente** (`permission-denied`) cualquier `PutItem`/`DeleteItem`/`BatchWriteItem`/`TransactWriteItems` sobre `wallets`, `transactions`, `stripe_events`, `ratelimit` o `users/<uid>/orbit`. La app actual nunca escribe ahí, así que no cambia nada visible.
- **Honestidad:** es *defensa en profundidad*, no una barrera. Un atacante con DevTools puede usar el SDK directamente con sus credenciales. La barrera real es la política IAM de la §5-A.
- Prueba: `tests/test-seguridad-dynamodb-guard.js`.
- No se tocó la lógica de lectura ni nada que pueda romper el login.

## 8. Lista de verificación en la consola de AWS (paso a paso)

Hacerlo con un usuario IAM de solo lectura (o como administrador, sin cambiar nada hasta el paso 10). Región **us-east-1**.

1. **Identity Pool.** *Amazon Cognito → Identity pools →* abrir el pool `92871635-d775-42e5-b161-8de1171d271a`.
   - *User access*: ¿está activado **"Guest access"**? Anotar el **ARN del rol invitado** y el **ARN del rol autenticado**.
   - Revisar *Role selection / Rules* (que no asigne un rol más amplio a ciertos usuarios).
   - Anotar si *Attributes for access control* está activo y qué se mapea.
2. **Rol autenticado.** *IAM → Roles →* abrir el rol autenticado → pestaña **Permissions**: abrir cada política (*JSON*). Buscar y anotar:
   - `"Action": "dynamodb:*"` o `"*"`, y `"Resource": "*"`.
   - Si hay `Condition` con `dynamodb:LeadingKeys` y qué colecciones lista.
   - Si incluye `Scan`, `UpdateItem`, `BatchGetItem`.
   - Acceso a **`drex-support-tickets`** (y a sus índices).
   - Cualquier otro servicio (S3, Lambda, SNS, Cognito…).
3. **Rol invitado.** Repetir el paso 2 con el rol no autenticado. **Esperado: casi nada.** Si tiene `PutItem` o acceso a toda `drex-kv`, es el hallazgo más grave: aplicar la §5-A y la §5-C de inmediato.
4. **Policy Simulator.** Abrir <https://policysim.aws.amazon.com> → elegir el rol (autenticado y luego invitado) → servicio *DynamoDB* → acciones `PutItem`, `DeleteItem`, `GetItem`, `Query`, `Scan` → recurso `arn:aws:dynamodb:us-east-1:002493750027:table/drex-kv` → *Add context key* `dynamodb:LeadingKeys` = `wallets` → *Run simulation*. **Esperado: `denied`.** Repetir con `users`, `verifiedUsers` y `communityNotes` para ver qué sí está permitido.
5. **Prueba real, solo lectura (opcional, con AWS CLI, sin credenciales de administrador).**
   ```bash
   ID=$(aws cognito-identity get-id --region us-east-1 \
        --identity-pool-id us-east-1:92871635-d775-42e5-b161-8de1171d271a --query IdentityId --output text)
   aws cognito-identity get-credentials-for-identity --region us-east-1 --identity-id "$ID"
   # Exportar AccessKeyId / SecretKey / SessionToken devueltos y probar SOLO LECTURAS:
   aws dynamodb get-item --region us-east-1 --table-name drex-kv \
        --key '{"pk":{"S":"users"},"sk":{"S":"UID_DE_PRUEBA"}}'
   ```
   Si devuelve datos **sin haber iniciado sesión** → el rol invitado puede leer perfiles (hallazgo #3).
6. **Prueba de escritura segura (opcional).** Con las mismas credenciales, intentar `put-item` en `pk=wallets`, `sk=_sectest`. **Esperado: `AccessDeniedException`.** Si *funciona*, borrar el ítem `_sectest` de inmediato y aplicar la §5-A.
7. **Tabla `drex-support-tickets`.** *DynamoDB → Tables →* revisar el índice `byUser` y confirmar que ningún rol de cliente tiene `Scan`/`UpdateItem` (paso 2).
8. **Lambdas con Function URL `AuthType NONE`.** *Lambda →* cada función → *Configuration → Function URL*: verificar que el código valide el JWT de Cognito (pagos sí lo hace; revisar `drex-username-resolve`, verificación, exportación y páginas públicas) y que `ALLOWED_ORIGINS` esté acotado.
9. **Qué colecciones usa de verdad el rol invitado/autenticado.** *CloudTrail → Event history* no incluye datos de DynamoDB: activar **data events** de DynamoDB para `drex-kv` unos días (o *CloudWatch Contributor Insights* para la tabla) y revisar `requestParameters` por `pk`. Úsalo para validar la lista de la §5-B antes de quitar permisos.
10. **Copia de seguridad antes de cambiar nada.** *DynamoDB → Tables → drex-kv → Backups*: activar **Point-in-time recovery** y crear un backup bajo demanda; activar **Deletion protection**.
11. **Aplicar y revertir.** Añadir primero la §5-A como política *inline* nueva (no editar las existentes). Probar la app (login, publicar, chat, comprar monedas). Para revertir, borrar solo esa política inline.
12. **User Pool.** *Cognito → User pools → us-east-1_kDSYEBsnY*: revisar triggers (*Pre sign-up*, *Post confirmation*), política de contraseñas, si permite **auto-confirmación**, y que MFA esté disponible.

## 9. Observaciones adicionales

- `drex-support-tickets`: `supportApi.adminListTickets/adminReply/adminSetStatus` usan `scan`/`update`, que **no existen** en el adaptador v3 (`V3_DOC_OPS`). El panel de soporte del dueño no funciona hoy; al migrarlo a Lambda (§6-7) queda resuelto.
- `drex-cloud.v3.js` es una copia idéntica de `drex-cloud.js` (se mantienen sincronizadas).
- Los índices `byUser` y similares heredan el mismo problema de la §2: la clave de partición del índice es `userId` (sub del User Pool), así que `LeadingKeys` con etiquetas de principal sí podría limitarlos por usuario en la Fase 2.
