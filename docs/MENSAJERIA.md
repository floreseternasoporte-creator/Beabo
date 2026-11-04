# Mensajería: solicitudes, respuestas, edición y búsqueda

Todo el código vive en `index.html` (bloque de chat) y reutiliza los nodos de datos que ya existían.
**No se añadieron campos ni colecciones nuevas.**

## Nodos usados

| Nodo | Campos relevantes | Uso |
|---|---|---|
| `userConversations/{uid}/{conv}` | `req` (1 = solicitud), `lastMessage`, `updatedAt`, `lastSenderId` | Bandeja y solicitudes. `req` lo escribe quien envía al destinatario cuando no lo sigue. |
| `conversations/{conv}` | `lastMessage` | Vista previa compartida del DM (se actualiza al editar el último mensaje). |
| `conversationMessages/{conv}/{msg}` | `text`, `editedAt`, `deletedForAll`, `replyTo{msgId,senderName,text,image,files}` | Mensajes. `editedAt` → marca "Editado"; `deletedForAll` → "Eliminaste este mensaje"/"Mensaje eliminado". |
| `typing/{conv}/{uid}` | timestamp | "escribiendo…". Se ignora si tiene más de 5 s (y el indicador caduca solo). |
| `followers/{objetivo}/{seguidor}` | `true` | Regla de solicitudes: el DM es solicitud si el **destinatario no sigue al remitente** (`followers/{remitente}/{destinatario}` no existe) y su `dmPermission` es `all`. |
| `blocks/{uid}/{objetivo}`, `chatMutes/{uid}/{otro}` | — | Bloquear y silenciar desde el menú de la cabecera (funciones ya existentes). |

## Cambios de comportamiento

- **Regla de solicitudes**: antes solo eran solicitud los DMs de usuarios sin seguimiento *mutuo*; ahora lo son los de usuarios **a los que el destinatario no sigue**. Si se prefiere la regla antigua, basta cambiar la consulta en `drexAntesalaShouldRequestFor`.
- **Aceptar / Ignorar**: `drexAntesalaAccept(convId)` borra `userConversations/{yo}/{conv}/req`; `drexAntesalaDecline({convId})` borra la conversación del usuario y su `chatUnread` (el remitente no se entera). Ambas funcionan desde la lista de solicitudes o desde la sala.
- **Reportar** reutiliza `drexReportOpen("user", {uid})`.
- **Eliminar para todos** deja una marca local en vez de hacer desaparecer el mensaje.

## Pendiente / requiere backend

- Las reglas de seguridad deben permitir que el destinatario escriba/borre su propio `userConversations/{yo}/{conv}/req` (ya se hacía para aceptar).
- "escribiendo…" en la fila de la bandeja no está implementado (requeriría suscribirse a `typing/*` por conversación o un agregado en servidor).
- La edición actualiza `lastMessage` en `userConversations` y `conversations` del lado del cliente; si el servidor lo recalcula, conviene replicar ahí la lógica.

## "escribiendo…" en la bandeja

Reutiliza `typing/{conv}/{uid}` (timestamp) que ya escribe la sala; no hay datos nuevos.
- Un listener `typing/{conv}` por conversación visible, **máximo 20** (las primeras de la lista; las solicitudes no cuentan) y **solo mientras la bandeja está visible**: se sueltan al abrir una sala y se retoman al volver.
- Un valor cuenta si tiene menos de 5 s; además un temporizador restaura la vista previa a los ~5 s aunque no llegue otro evento (el indicador no puede quedarse pegado).
- Solo se parchea la línea de vista previa de la fila afectada (no se re-renderiza la lista). DM: "escribiendo..."; grupo: "Alguien está escribiendo...".
- Coste: lecturas adicionales de RTDB/DrexCloud limitadas a esas ≤20 rutas, y solo cambian cuando alguien escribe.

## Vista previa de enlaces

- Cada mensaje de texto con una URL `http(s)` pública muestra una tarjeta bajo el texto (imagen, título, descripción, dominio). Se ignoran `javascript:`/`data:`, `localhost`, IPs, hosts `.local`, credenciales en la URL y URLs de más de 2048 caracteres. No se generan en mensajes de "ver una vez", temporales ni eliminados.
- Todo lo que viene del servidor se sanea (`drexLpSanitize`: tipos, longitudes, imagen solo `https`) y se escapa al pintar; el enlace usa `target="_blank" rel="noopener noreferrer nofollow"`; la imagen se carga `lazy` y `referrerpolicy="no-referrer"`.
- Carga perezosa con `IntersectionObserver`, una sola petición en curso por URL y caché en `localStorage` (`drexLinkPreviews:v1`, 7 días, 1 h para fallos, máx. 120 entradas).
- **El navegador no puede leer el HTML de otros sitios (CORS).** En el repo no existía un endpoint de metadatos (los Lambda URL actuales son login por usuario, pagos, verificación, exportación y páginas públicas de posts), así que se añade `lambda-link-preview/` (Node 20, sin dependencias ni APIs de pago) y se lee `window.DREX_LINK_PREVIEW_URL` (vacío por defecto).
- **Sin endpoint configurado = sin ninguna petición de red**: se muestra una tarjeta de dominio (host + ruta). Con endpoint, la tarjeta se mejora con imagen/título.
- Privacidad: con endpoint, la URL del enlace se envía a ese Lambda (no a terceros); la imagen OG la descarga el dispositivo directamente del sitio enlazado (puede ver la IP del usuario). Si se quiere evitarlo hay que proxear/cachear imágenes (CloudFront/S3), no incluido.
