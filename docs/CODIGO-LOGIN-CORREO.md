# Código por correo al iniciar sesión — diseño y comparación

Pedido: el login debe exigir **siempre** un código de verificación enviado al correo (como Instagram),
además de usuario/correo + contraseña, de forma segura (que no se pueda saltar desde el cliente).

## Opciones evaluadas

| | (a) MFA por correo nativo de Cognito | (b) Custom auth challenge (3 Lambdas + SES) | (c) Código solo en dispositivo nuevo |
|---|---|---|---|
| ¿Lo exige el servidor? | **Sí** (Cognito no entrega tokens sin el código) | Sí, pero solo si se desactiva `USER_SRP_AUTH` y ninguna ruta usa `ADMIN_NO_SRP_AUTH` | Depende de la implementación |
| Login por nombre de usuario (`drex-username-resolve`, `ADMIN_NO_SRP_AUTH`) | Funciona: Cognito devuelve el desafío y la Lambda lo reenvía; si no se actualiza falla **cerrado** | **Se salta el desafío sin avisar (falla abierto)** | – |
| Soporte en `amazon-cognito-identity-js` 6.3.15 | No nativo (ni en 6.3.22): se agregó un adaptador en `drex-cloud.js` | Sí (custom challenge) | – |
| Dispositivos recordados | Nativo (device tracking, "User opt-in" + "suprimir MFA") | Hay que programarlo | Es esta opción |
| Código a mantener | Poco (adaptador + ayuda para la Lambda) | Mucho (3 Lambdas, caducidad, intentos, SES) | Medio |
| Costo | Essentials (gratis 10k MAU, luego US$0.015/MAU) + SES (US$0.10/1000) | SES + Lambdas | – |

**Elegida: (a) + dispositivos recordados de Cognito**, que da el comportamiento de (c) de forma nativa:
código en dispositivos no reconocidos, "Recordar este dispositivo" y "Pedir siempre" en Ajustes.
Si el usuario tiene TOTP, se usa el TOTP (prioridad sobre el correo).

## Cómo funciona en la app
* `drex-cloud.js` detecta el desafío `EMAIL_OTP`/`EMAIL_MFA` (y `SELECT_MFA_TYPE`, eligiendo TOTP antes que correo) con un adaptador sobre `CognitoUser.authenticateUserInternal` y añade `sendEmailMfaCode`.
* La pantalla del código reutiliza `#reg-verify-step` (la del registro) sin cambiar estilos: título "Confirma que eres tú", correo enmascarado, casilla "Recordar este dispositivo" (solo en login con correo), "Reenviar código" con espera de 30 s.
* Reenviar = volver a iniciar sesión (Cognito no tiene "reenviar" para MFA).
* Login por nombre de usuario: la Lambda devuelve `{challenge:'mfa', mfaType:'email', destination, session}`; el paso 2 manda `mfaType:'email'`. La casilla "recordar" no se muestra aquí (el dispositivo no se puede registrar desde la Lambda), por lo que siempre pide código.
* Mientras Cognito no devuelva el desafío, **nada cambia** para el usuario.
* Ajustes → Centro de seguridad: fila "Código al iniciar sesión" (solo si ya se pidió un código en este dispositivo) con "Pedir siempre".

## Fuera de alcance / limitaciones
* **Login con Facebook**: federado, Cognito no pide MFA; se confía en Facebook.
* Sesiones ya abiertas siguen válidas hasta que expiren/refresquen (el MFA se exige al iniciar sesión).
* Apps en caché anteriores a `drex-v142` fallarán con un mensaje de error cuando se active el MFA.
* Usuarios en estado `MFA_SETUP` (sin correo ni TOTP configurado) ven "Tu cuenta necesita configurar la verificación en dos pasos. Escribe a soporte." (`auth/mfa-setup-required`).

Pasos de despliegue: `lambda-login-otp/README.md`.
