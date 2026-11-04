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
