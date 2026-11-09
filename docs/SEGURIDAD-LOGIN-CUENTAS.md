# Registro, login y recuperación: que nadie pueda saber quién tiene cuenta

Este documento explica **qué cambió en la app** para cerrar la "fuga de cuentas" y **qué paso falta en AWS** (lo tiene que hacer una persona con acceso a la consola; no se puede hacer desde el código).

## 1. El problema (en palabras simples)

Antes, cualquiera podía escribir el correo (o el usuario) de otra persona en la pantalla de login, o en "Crear cuenta", y la app le contestaba cosas que delataban si esa cuenta existía:

| Dónde | Qué delataba |
|---|---|
| Login, paso de la contraseña | Mostraba la **foto y el nombre** de la cuenta (la app leía `userEmails/<correo>`, `usernames/<usuario>` y `users/<uid>` **sin haber iniciado sesión**). |
| Login por usuario | "No se encontró ninguna cuenta con ese nombre de usuario." |
| Crear cuenta | "Este correo ya está registrado" y "Ya habías empezado este registro antes…" (delata también los registros a medias). |
| Código de verificación | Una cuenta ya confirmada contestaba distinto que una inexistente. |
| "¿Olvidaste tu contraseña?" / reenviar código | Para cuentas sin verificar o inexistentes mostraba "El correo no es válido" o un error distinto. |

Con eso se podía armar una lista de correos/usuarios reales para phishing, spam o ataques de contraseñas.

## 2. Qué cambió en la app (este PR)

- **Login:** el paso de la contraseña ya **no muestra foto ni nombre**, solo lo que la persona escribió. La app **ya no lee** `users`, `userEmails` ni `usernames` como invitado en el login. El login por usuario sigue funcionando porque se resuelve en la Lambda `drex-username-resolve`.
- **Errores de login:** siempre "Correo o contraseña incorrectos." / "Nombre de usuario o contraseña incorrectos." (también cuando la cuenta no existe).
- **Crear cuenta:** un correo nuevo, un registro a medias y una cuenta ya confirmada llevan **a la misma pantalla del código, con el mismo mensaje**: *"Si este correo puede registrarse, te enviamos un código. Si ya tienes una cuenta, inicia sesión o recupera tu contraseña."*
  - La persona real **sigue pudiendo terminar su registro**: si lo dejó a medias, recibe el código; si ya tenía cuenta y escribe su contraseña de siempre, la app la deja entrar.
  - Si el código es incorrecto en una cuenta que no se pudo comprobar, el mensaje es siempre el mismo: *"El código no es válido o venció. Revísalo, pide uno nuevo o inicia sesión."*
- **Reenviar código** y **¿Olvidaste tu contraseña?:** siempre avanzan con un texto neutro ("Si existe una cuenta con ese correo, te enviamos un código…"). Solo se muestran los errores reales que no dependen de la cuenta: demasiados intentos y falta de conexión.
- Se corrigió el comentario viejo de `drex-cloud.js` (y `drex-cloud.v3.js`) que decía que el User Pool no exigía verificar el correo; sí la exige.

## 3. Paso en AWS que le toca a Darel

> Región **us-east-1**. Es seguro y reversible; no requiere tocar código.

### 3.1 Activar "Prevent user existence errors" (lo más importante)

1. *Amazon Cognito → User pools →* `us-east-1_kDSYEBsnY`.
2. *App integration → App clients and analytics →* abrir el app client `7cm12q14tm12u8b3bnn6ksjqni`.
3. *Edit* → buscar **"Prevent user existence errors"** → marcar **Enabled** → *Save changes*.

Qué hace: Cognito deja de contestar "usuario no existe" en el login (SRP) y en "olvidé mi contraseña": responde igual exista o no la cuenta. La app ya está preparada para ambos casos, así que **no se rompe nada**.

Cómo comprobarlo: en la app, intentar entrar con un correo que no existe y con uno real con contraseña mala: ambos deben decir "Correo o contraseña incorrectos." Y "¿Olvidaste tu contraseña?" con un correo inventado debe avanzar a la pantalla del código igual que con uno real.

### 3.2 Quitar la lectura de invitados sobre `users`, `usernames` y `userEmails`

Hoy el rol **no autenticado (invitado)** del Identity Pool `92871635-d775-42e5-b161-8de1171d271a` puede hacer `GetItem` sobre esas colecciones (ver `docs/SEGURIDAD-DYNAMODB.md` §5-C). Con este PR el login ya no las necesita.

1. Antes de quitarlo, comprobar que nada más las usa sin sesión: activar *data events* de DynamoDB para `drex-kv` unos días y revisar los `GetItem` con el rol invitado (ver `docs/SEGURIDAD-DYNAMODB.md` §8, paso 9).
2. *IAM → Roles →* rol no autenticado del Identity Pool → en la política de §5-C, **quitar** `users`, `usernames` y `userEmails` de `dynamodb:LeadingKeys` (dejar solo lo que de verdad use un invitado, p. ej. `_health`). Hacerlo como política *inline* nueva y no editar las existentes, para poder revertir.
3. Probar: abrir la app sin sesión, ir al login (por correo y por usuario), crear una cuenta de prueba y recuperar contraseña.

Si algo sin sesión dejara de funcionar (p. ej. un enlace público a un perfil), volver a añadir solo esa colección.

### 3.3 Opcional: Lambda "Pre sign-up"

Aun con 3.1 activado, Cognito **no oculta** que un correo ya existe cuando se llama directamente a la API `SignUp` (no a través de la app). Para cerrarlo del todo hace falta un *trigger* **Pre sign-up** en el User Pool (una Lambda que rechace o normalice el alta de correos ya registrados). Es opcional y de mayor esfuerzo; la app ya no muestra esa información a las personas, pero un atacante que llame a la API de Cognito por su cuenta aún podría verla.

## 4. Límites que siguen existiendo (a propósito)

- **Disponibilidad del nombre de usuario** durante el registro ("@usuario ya está en uso"): es parte de elegir un nombre y ocurre ya con la sesión iniciada. Es normal en redes sociales.
- **Bloqueo por intentos de login**: se guarda en el navegador (no es una defensa contra un atacante que no use la app). Cognito ya limita intentos por su cuenta.
- **Cambio de correo** (Ajustes): avisa "Ese correo ya está en uso" a una persona que ya inició sesión y confirmó su contraseña; no se cambió en este PR.
