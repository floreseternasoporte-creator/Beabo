# Código de verificación por correo al iniciar sesión (como Instagram)

Esta carpeta tiene **todo lo que hay que hacer en AWS** para que, al iniciar sesión,
Beabo/Drex pida un **código de 6 dígitos enviado al correo** además de usuario/correo + contraseña.

> **Importante:** el código del repo (la app) ya está listo y **no rompe nada** mientras no hagas
> los pasos de AWS. El código se vuelve obligatorio en el momento en que haces el **Paso 8**.
> Hasta entonces el login funciona como hoy.

## Qué se eligió y por qué (resumen)

Se eligió **MFA por correo nativo de Cognito** ("Email MFA"), con **dispositivos recordados** de Cognito.

* **El servidor lo exige**: Cognito no entrega tokens sin el código, así que **nadie puede saltárselo
  desde el navegador** (editando JavaScript, etc.). Si algo falla, falla "cerrado" (no deja entrar).
* **Se parece a Instagram**: la primera vez en un dispositivo pide el código; si marcas
  "Recordar este dispositivo" no lo vuelve a pedir ahí; en *Ajustes → Centro de seguridad* hay
  **"Pedir siempre"** para volver a exigirlo en ese dispositivo.
* **Si el usuario tiene app de autenticación (TOTP)**, se usa el TOTP en vez del correo.
* **Facebook** (login social) **queda fuera**: Cognito no pide MFA a usuarios federados; la seguridad
  la pone Facebook. (Está anotado en `docs/CODIGO-LOGIN-CORREO.md`.)

Se descartó el "custom auth challenge" con 3 Lambdas porque la Lambda de login por nombre de usuario
(`drex-username-resolve`) usa `ADMIN_NO_SRP_AUTH`, que **se salta esos desafíos sin avisar** (falla "abierto").
Comparación completa en `docs/CODIGO-LOGIN-CORREO.md`.

## Qué cuesta dinero

| Paso | ¿Cuesta? |
|---|---|
| Plan **Essentials** de Cognito (Paso 3) | Primeros **10,000 usuarios activos al mes: gratis**. Después **US$0.015 por usuario activo/mes**. (Precio de la página oficial de Cognito.) |
| **SES** para enviar los correos (Pasos 1, 2 y 4) | **US$0.10 por cada 1,000 correos** (≈ US$1 por 10,000 códigos). Verificar el remitente es gratis. |
| Lambda, device tracking, MFA, TOTP | Sin costo extra relevante. |

Nada de esto se cobra hasta que hay usuarios/correos; con pocos usuarios serán **centavos**.

## Orden exacto de los pasos (no lo cambies)

Todo en la región **us-east-1 (N. Virginia)**. Usa la consola de AWS (los cambios por línea de comandos
de `update-user-pool` borran ajustes que no mencionas, por eso **no** lo recomendamos).

**Paso 0 — Mira cómo está hoy (opcional, solo lectura).** En CloudShell: `bash lambda-login-otp/scripts/comprobar-pool.sh`.

**Paso 1 — SES: verifica el remitente.** Consola → *Amazon SES* → *Identities* → *Create identity*.
Mejor un **dominio** tuyo (ej. `beabo.app`) con DKIM; si no tienes dominio, un correo (ej. `no-reply@tudominio`).
Abre el enlace de verificación que te llega. *Gratis.*

**Paso 2 — SES: sal del modo de pruebas.** *Amazon SES* → *Account dashboard* → *Request production access*
(tipo "Transactional", describe: "códigos de verificación de login"). AWS suele responder en ~24 h.
Mientras SES esté en "sandbox" solo puede enviar a correos verificados: **no sigas al Paso 8 hasta que lo aprueben**.

**Paso 3 — Cognito: plan Essentials.** *Cognito* → tu User Pool `us-east-1_kDSYEBsnY` → *Settings* (Configuración) →
*Feature plan* → **Essentials**. *(Aquí puede aparecer costo, ver tabla.)*

**Paso 4 — Cognito: que los correos salgan por SES.** *Messaging* → *Email* → *Edit* →
**Send email with Amazon SES** → elige la identidad del Paso 1 y el "FROM". (Email MFA no funciona con el
correo por defecto de Cognito.)

**Paso 5 — Cognito: tiempo del código.** *Applications* → *App clients* → el cliente `7cm12q14tm12u8b3bnn6ksjqni` →
*Authentication flow session duration* = **5 minutos** (el código vale ese tiempo; la app asume 5).
Deja activado `ALLOW_USER_SRP_AUTH` y `ALLOW_REFRESH_TOKEN_AUTH` (y lo que ya use `drex-username-resolve`).

**Paso 6 — Cognito: dispositivos recordados.** *Authentication* → *Sign-in* → *Device tracking* → *Edit* →
**User opt-in** y **Suppress MFA with remembered device = Sí**. Así sale el "Recordar este dispositivo". (Si lo omites, se pedirá el código siempre.)

**Paso 7 — Actualiza la Lambda `drex-username-resolve`** (login por nombre de usuario):
1. Copia `lambda-login-otp/email-mfa.js` a la Lambda (junto a su `index.js`/`index.mjs`; si usa ES modules, renómbralo a `email-mfa.cjs` y haz `createRequire`).
2. En el **paso 1** (usuario + contraseña): después de `AdminInitiateAuth`, en vez de leer `AuthenticationResult` directo, usa:
   ```js
   const M = require('./email-mfa.js');
   const ctx = { userPoolId: POOL_ID, clientId: CLIENT_ID, cognitoUsername: <el username/email real del usuario> };
   const c = await M.classifyAuthResponse(cognito, ctx, authResp);  // `cognito` = objeto con adminRespondToAuthChallenge(params) -> Promise
   if (c.type === 'tokens')       return json(200, { tokens: shape(c.result) });          // igual que hoy
   if (c.type === 'mfa')          return json(200, M.challengeBody(c));                    // pantalla de código
   return json(401, { error: 'invalid' });                                                // cualquier otro desafío
   ```
3. En el **paso 2** (`{username, session, code, mfaType}`): reemplaza la llamada actual por
   ```js
   const params = M.buildRespondParams(ctx, body.session, body.code);
   if (!params) return json(400, { error: 'bad_code' });
   const r = await cognito.adminRespondToAuthChallenge(params);   // TOTP sigue igual (sesión sin prefijo)
   ```
   y devuelve los tokens como hoy. Mantén los errores actuales (401 código incorrecto, 429, etc.).
4. El rol de la Lambda necesita `cognito-idp:AdminInitiateAuth` y `cognito-idp:AdminRespondToAuthChallenge` (ya lo tiene si hoy soporta TOTP).
5. Pruebas locales de la ayuda: `node lambda-login-otp/test/email-mfa.test.js` (8 pruebas).

**Paso 7b — Publica el PR de la app** (el que contiene esta carpeta) y espera a que Pages muestre la versión nueva de `sw.js`.
Los móviles se actualizan solos; la app antigua no sabe mostrar la pantalla del código.

**Paso 8 — Activa el código (este es el interruptor).** *Authentication* → *Sign-in* → *Multi-factor authentication* → *Edit* →
**Require MFA**; métodos permitidos: **Authenticator apps** ✔ y **Email message** ✔ (SMS no).
En *Messaging → Message templates* pon el mensaje MFA: `Tu código de Drex es {####}. Vence en 5 minutos.`
Desde este momento **todos** los logins con correo/usuario piden el código.

**Paso 9 — Prueba (con 2 cuentas de prueba):**
1. Entrar con **correo** + contraseña → llega correo → escribir código → entra.
2. Entrar con **nombre de usuario** + contraseña → igual (sin casilla "recordar").
3. Código incorrecto → mensaje de error; "Reenviar código" tras 30 s → llega código nuevo.
4. Marcar **Recordar este dispositivo** → cerrar sesión → volver a entrar → no pide código.
5. Ajustes → Centro de seguridad → **Pedir siempre** → salir y entrar → pide código.
6. Usuario con app de autenticación (TOTP) → pide el TOTP, no el correo.
7. Entrar con **Facebook** → entra como siempre (fuera del código).

**Paso 10 — Cómo volver atrás (inmediato):** *Multi-factor authentication* → **Optional** (o *No MFA*). La app vuelve a entrar solo con contraseña; los TOTP ya configurados siguen funcionando.

## Cosas que debes saber
* Si un correo del usuario aún no está verificado, Cognito lo marca verificado la primera vez que el usuario confirma un código MFA.
* Quien se registra hoy confirma su correo con un código y, justo después, el login pide **otro** código (el de acceso). Es normal con este enfoque.
* Si SES no está en producción (Paso 2), los códigos no llegan a usuarios no verificados y **nadie podrá entrar**: no actives el Paso 8 antes.
* Los nombres internos de Cognito para el desafío (`EMAIL_OTP` / `EMAIL_MFA`) están cubiertos por la app y por `email-mfa.js`.
* Las apps viejas en caché (anteriores a `drex-v142`) no entienden el desafío; por eso el Paso 7b va antes del 8. Si quieres forzar la actualización, sube `minBuild` en `version.json`.
