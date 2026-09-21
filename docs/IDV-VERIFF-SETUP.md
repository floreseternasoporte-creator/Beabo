# IDV — Guía para el dueño: cuenta de Veriff y puesta en producción

> Esta guía es para cuando quieras activar la verificación de identidad **real**
> (documentos de verdad revisados por Veriff). Hoy la app corre en **modo demo**:
> todo el flujo funciona, pero la "revisión" se simula con un botón.

---

## 1. Crear la cuenta en Veriff

1. Entra a **veriff.com** y busca el botón de registro / "Get started" (también
   puedes escribir a su equipo de ventas desde la misma página).
2. Regístrate como empresa/proyecto (Drex). Te pedirán datos básicos del negocio.
3. Veriff te da acceso a su **portal de cliente** (Customer Portal), donde se
   gestiona la integración.

⚠️ No te doy URLs internas del portal (p. ej. "stationapi.veriff.com/dashboard/…")
porque cambian y no las verifiqué hoy; una vez dentro del portal verás el menú
real. La documentación pública para desarrolladores está en
**devdocs.veriff.com** (verificada el 2026-09-20).

## 2. Dónde obtener la API key y el secret

Dentro del portal de Veriff, en la sección de tu **integración / API settings**,
encontrarás dos valores:

| Valor | Para qué lo usa Drex |
|---|---|
| **API key** (clave pública, header `X-AUTH-CLIENT`) | Crear sesiones de verificación (`POST /sessions`) |
| **Shared secret** (clave secreta) | Firmar peticiones y **verificar la firma** de los webhooks (`X-HMAC-SIGNATURE`) |

Veriff suele darte un entorno de **pruebas (sandbox)** primero y el de
**producción** después de validar tu cuenta. Usa el de pruebas para el paso 5.

## 3. Dónde poner las keys (NUNCA en el repo ni en el chat)

Opción A — **variables de entorno de la Lambda** (recomendado):
1. Consola de AWS → Lambda → `drex-id-verification` → Configuration →
   Environment variables → Edit.
2. Pega `VERIFF_API_KEY` y `VERIFF_SECRET_KEY`.
3. Cambia `DREX_IDV_MODE` de `demo` a `production`.

Opción B — **Secure Vault**: si prefieres no pegarlas ni siquiera en la consola,
guárdalas en el vault y pídeme que las configure yo en el despliegue.

## 4. Cómo cambiar a modo producción

1. Keys cargadas (paso 3).
2. `DREX_IDV_MODE=production` en las variables de entorno de la Lambda.
3. En el portal de Veriff, configura el **Webhook decision URL** con:
   `https://<tu-function-url>/webhook`
   (el checklist de despliegue trae el paso exacto).
4. Listo: las nuevas sesiones se crean en Veriff de verdad y el resultado llega
   por webhook firmado.

Para volver a demo en cualquier momento: cambia `DREX_IDV_MODE` a `demo`.

## 5. Cómo probar con un documento real

1. Con el modo production activo y una **cuenta de prueba** de Drex, crea una
   sesión desde la app (sección de verificación de edad).
2. Abre el `verificationUrl` que devuelve la API: es la página oficial de Veriff.
3. Sigue el flujo: elige el país, el tipo de documento (pasaporte, cédula o
   licencia — Veriff soporta Cuba, EE. UU., Canadá, México y Brasil), toma las
   fotos y el selfie.
4. Veriff revisa el documento (automático + revisión humana; tarda de segundos
   a minutos) y avisa a nuestra Lambda por webhook.
5. En la app, el estado pasa a **verificado** y te llega una notificación in-app.

Tip: en el portal de Veriff (entorno de pruebas) puedes **forzar el resultado**
de una sesión a `approved`/`declined` para probar sin usar un documento real.

## 6. Costos / plan a revisar

- Veriff cobra **por verificación** (no hay un plan gratuito permanente para
  producción). El precio exacto depende del volumen y del país; lo verás en su
  página de precios o con su equipo de ventas al crear la cuenta.
- Mientras decides, el modo demo cuesta **$0** y permite probar todo el flujo.
- Recomendación: activa producción cuando el volumen lo justifique; cada
  verificación aprobada queda guardada en tu base de datos (`drex-kv`) y no hay
  que pagar dos veces por el mismo usuario.

## 7. Qué datos ve Veriff (privacidad)

- Veriff recibe las **fotos del documento y el selfie** que el usuario sube en su
  página: es necesario para verificar la identidad, igual que cualquier KYC.
- Drex **no guarda** fotos del documento ni números de documento en `drex-kv`:
  solo guardamos el resultado (`verified`/`rejected`), el país, la fecha y el
  proveedor. Los logs de la Lambda tampoco contienen datos del documento.

## 8. Preguntas frecuentes

- **¿Puedo cambiar de proveedor después?** Sí. El código usa un adaptador
  (`IdentityProvider` con `VeriffProvider` y `DemoProvider`): cambiar de
  proveedor es crear una clase nueva, no reescribir la Lambda.
- **¿Qué pasa si un usuario pierde su documento?** Puede crear una sesión nueva
  (límite: 5 por día por usuario) y el último resultado válido es el que cuenta.
- **¿Funciona con documentos de Cuba?** Sí: Veriff soporta pasaporte, cédula de
  identidad y licencia de conducción de Cuba, además de EE. UU., Canadá, México
  y Brasil.
