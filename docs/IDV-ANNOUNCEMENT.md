# Anuncio oficial de verificación de edad (IDV) — broadcast a usuarios

Script: `scripts/idv-announcement/broadcast.js`
Rama: `feature/age-verification` (commits locales; NO merge a main, NO push).

> ⚠️ **El broadcast real (`--execute`) SOLO lo corre el dueño de Drex,
> personalmente, DESPUÉS de publicar la función de verificación de edad.**
> Toca a todos los usuarios reales. El modo por defecto (`--dry-run`)
> no escribe nada.

---

## 1. Esquemas descubiertos en el repo

Fuente de verdad: `drex-cloud.js` (adaptador DynamoDB) e `index.html`.
La tabla `drex-kv` (us-east-1) emula un árbol: **pk = primer segmento de la
ruta, sk = resto unido con `/`, atributo `v` = hoja serializada en JSON**
(`drex-cloud.js`, cabecera). Los objetos se guardan **aplanados hoja por
hoja**; p. ej. `ref('users/abc/name').set('Zed')` →
`pk='users', sk='abc/name', v='"Zed"'`. Este script replica ese aplanado.

### Notificaciones in-app (`index.html`, `addNotification` ~línea 24880)

Ruta: `notifications/<uid>/<pushId>` →
`pk='notifications'`, `sk='<uid>/<pushId>/<campo>'`

| Campo | Valor que escribe el script |
|---|---|
| `message` | texto del anuncio en el idioma del usuario |
| `timestamp` | `Date.now()` |
| `read` | `false` (activa el badge de no leídas) |
| `type` | `'announcement'` |
| `notificationId` | el pushId generado |
| `actorId` / `actorName` / `actorImage` | sub / nombre / foto de la cuenta oficial |
| `announcement` | `'idv-age-verification-2026-09-21'` (etiqueta propia) |

Decisión de `type`: `'announcement'` **no** está mapeado en
`notifTypeToPrefKey()` (index.html ~24830), que solo mapea tipos como
`'info'`, `'message'`, `'comment'`, etc. Un tipo sin mapeo hace que
`shouldSkipNotificationFor()` devuelva `false` siempre: el aviso oficial
**no se puede silenciar** con los toggles de notificaciones del usuario.
La tarjeta renderiza `actorName` + avatar (`paintNotifName`,
`hydrateNotifActor`).

### Conversaciones y mensajes (`index.html`)

- ID de conversación 1-a-1: `[uidA, uidB].sort().join('__')`
  (idéntico a `getDirectConversationId()`, ~línea 31237).
- `conversations/<convoId>` → `pk='conversations'`:
  `{ participants: {uidA:true, uidB:true}, createdAt, updatedAt,
  lastMessage, lastSenderId }`
- `userConversations/<uid>/<convoId>` → `pk='userConversations'`
  (inbox de cada lado): `{ otherUid, updatedAt, lastMessage }`
- Mensaje: `conversationMessages/<convoId>/<msgId>` →
  `pk='conversationMessages'`:
  `{ senderId: <sub oficial>, text: <anuncio>, timestamp }`
  (esquema de `_sendChatMessageBuildAndPush`, ~línea 33035).
- Los push IDs usan el algoritmo de Firebase de `drex-cloud.js`
  (`newPushId`), ordenables por tiempo.
- No hay contador de no-leídos en servidor: `isChatConversationUnread`
  lo deriva el cliente comparando `updatedAt` con localStorage.

### Cuenta oficial (remitente)

**No existe una cuenta `@drex` hardcodeada en el repo.** Lo más cercano a
una cuenta oficial es **`drexcreators`**, referenciada en el código vía el
índice `usernames/drexcreators` (`index.html` ~15568; solo esa cuenta puede
crear colaboraciones). `VERIFIED_USERS` se carga desde la BD en runtime.

Por eso el script **resuelve la cuenta oficial en tiempo de ejecución**
leyendo `pk='usernames', sk='<nombre-en-minúsculas>'` (v = sub en JSON) y
luego su `users/<sub>/username|displayName|profileImage`. Por defecto usa
`drexcreators`; se puede cambiar con `--official-username <nombre>` o fijar
directamente con `--official-uid <sub>`. **El dueño debe confirmar cuál es
la cuenta oficial correcta antes del envío real.**

### Idioma por usuario

El campo de idioma del perfil es `userSettings/<uid>/appLanguage`
(`pk='userSettings'`, `sk='<uid>/appLanguage'`; solo existe si el usuario
cambió el idioma alguna vez). Valores: `es` | `en` | `zh`.
**Decisión:** si el perfil tiene idioma válido se envía solo esa versión;
si no, se envía **ES** (idioma por defecto de la app,
`getAppLanguage()`).

### Marcador de idempotencia

`pk='users'`, `sk='<sub>/idvAnnouncement'`, `v='{"sent":true,"at":<ms>,
"via":"notification+dm","tag":"idv-age-verification-2026-09-21"}'`.
Hoja única (no aplanada) para que la condición
`attribute_not_exists(pk)` sea atómica dentro de la transacción.

---

## 2. Cómo correr el dry-run

```bash
cd scripts/idv-announcement
npm install   # una vez; instala @aws-sdk/client-dynamodb
node broadcast.js --selftest          # pruebas unitarias, sin AWS ni red
node broadcast.js                     # DRY-RUN: escanea y reporta, 0 escrituras
node broadcast.js --limit 5           # DRY-RUN piloto de 5 usuarios
node broadcast.js --verify-sub <sub>  # estado del anuncio para un usuario
```

El dry-run necesita **credenciales AWS de lectura** (las estándar del
entorno: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `~/.aws/credentials`
o rol IAM) con permiso `dynamodb:Query`, `dynamodb:BatchGetItem` y
`dynamodb:GetItem` sobre `drex-kv`. Hace:

1. `Query(pk='users', ProjectionExpression=sk)` → subs únicos.
2. `BatchGetItem` por lotes de 100: `users/<sub>/{username,email,idvAnnouncement}`
   y `userSettings/<sub>/appLanguage`.
3. `GetItem(usernames/<oficial>)` para resolver la cuenta remitente.
4. Clasifica cada sub: `to-send` / `already-sent` (tiene marcador) /
   `excluded-official` / `excluded-qa` / `invalid-sub`.
5. Muestra conteos, desglose por idioma y **2 payloads de ejemplo**
   (notificación + mensaje + marcador) con sus pk/sk exactos.
6. Termina con `=== FIN DRY-RUN: 0 escrituras realizadas ===`.

Exclusiones: la propia cuenta oficial; cuentas QA/prueba
(`drexqa` en username o email, `+drexqa`; regex extra con `--qa-pattern`);
subs inválidos (vacíos, con `/` o espacios).

---

## 3. Qué hace `--execute` paso a paso

```
node broadcast.js --execute --confirm
```

Sin `--confirm` el script **se niega a correr** (código 3). Con ambas
banderas:

1. Resuelve la cuenta oficial. Si no existe → aborta.
2. Pausa de 5 s con aviso (Ctrl+C cancela).
3. Escanea usuarios y atributos igual que el dry-run.
4. Por cada usuario `to-send` (con `--throttle-ms` entre usuarios,
   120 ms por defecto):
   - Lee si ya existen `conversations/<convoId>` y las dos entradas de
     `userConversations` (para crear o solo refrescar).
   - Arma **una transacción DynamoDB** (`TransactWriteItems`) con:
     * hojas de la notificación (`pk='notifications'`),
     * hojas del mensaje (`pk='conversationMessages'`),
     * hojas de la conversación (crear o actualizar
       `lastMessage`/`lastSenderId`/`updatedAt`),
     * hojas del inbox de ambos lados (`pk='userConversations'`),
     * el marcador `users/<sub>/idvAnnouncement` **con condición
       `attribute_not_exists(pk)`**.
   - Si la transacción se aborta por `TransactionCanceledException`
     (el marcador ya existía → carrera con otra ejecución), el usuario se
     cuenta como omitido, no como fallo.
5. Reporte final: `enviados / omitidos / fallidos` + lista de fallos
   (re-ejecutar es seguro: el marcador evita duplicados).

---

## 4. Checklist previo a ejecutar (dueño)

- [ ] La función de verificación de edad está **publicada** y el flujo
      Configuración → Cumpleaños la invoca (el anuncio dice "a partir del
      21 de septiembre de 2026").
- [ ] **Backup** de `drex-kv` (backup on-demand desde la consola DynamoDB)
      antes del envío.
- [ ] Confirmada la **cuenta oficial remitente** (`--official-username`
      o `--official-uid`); su perfil tiene nombre y foto presentables
      (aparecen en la notificación y como remitente del DM).
- [ ] Dry-run revisado: conteos coherentes con el número esperado de
      usuarios reales; 0 sorpresas en excluidos.
- [ ] (Opcional) Piloto: `--execute --confirm --limit 5` y verificar en
      la app esos 5 usuarios antes del envío masivo.
- [ ] **Hora recomendada:** madrugada del huso horario de la mayoría de
      usuarios (p. ej. 03:00–05:00 CDMX) del 20→21 de septiembre, para que
      el aviso esté esperando al despertar y no interrumpa el día.
      El throttle de 120 ms ≈ 8 usuarios/segundo; para ~10k usuarios son
      ~20 minutos.
- [ ] Credenciales AWS con `dynamodb:Query`, `BatchGetItem`, `GetItem` y
      `TransactWriteItems` sobre `drex-kv`, región `us-east-1`.

---

## 5. Verificar después que llegó

```bash
# Estado de un usuario concreto (marcador + notificaciones + conversación)
node broadcast.js --verify-sub <sub>
```

En la consola DynamoDB (tabla `drex-kv`, us-east-1):

- Marcadores escritos: `pk = users` y `sk` contiene `/idvAnnouncement`.
- Notificaciones: `pk = notifications`, `sk` comienza con `<sub>/`; la hoja
  `.../type` vale `"announcement"`.
- En la app: el usuario ve la notificación con el nombre/avatar de la
  cuenta oficial, y un DM 1-a-1 con la cuenta oficial con el texto del
  anuncio (el inbox muestra `lastMessage` actualizado).

---

## 6. Decisiones de diseño (resumen)

1. **Dry-run por defecto.** Cualquier invocación sin `--execute` no
   escribe nada; `--execute` exige además `--confirm`.
2. **Idempotencia transaccional.** El marcador se escribe en la misma
   transacción que la notificación y el mensaje, con condición
   `attribute_not_exists(pk)`: reintentos y ejecuciones paralelas no
   duplican.
3. **Mismo formato que la app.** Hojas aplanadas hoja-por-hoja como
   `drex-cloud.js` (`flatten` replicado y probado en `--selftest`), push
   IDs con el algoritmo de Firebase del repo, `convoId` con
   `getDirectConversationId()`.
4. **`type: 'announcement'`** en la notificación: no mapeado en
   `notifTypeToPrefKey()` → ningún toggle del usuario la silencia.
5. **Cuenta oficial resuelta por índice**, no hardcodeada: el repo no
   define `@drex`; `drexcreators` es la única cuenta oficial referenciada
   en código.
6. **Idioma:** perfil → `es`/`en`/`zh`; ausente → `es` (default de la app).
7. **QA excluido** por patrones `drexqa` / `+drexqa` (+ `--qa-pattern`
   opcional); la cuenta oficial y subs inválidos también se excluyen.
