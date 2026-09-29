# C253 — Checklist de despliegue AWS: entrega diferida de recordatorios de en vivos

**ESTADO: PENDIENTE DE DEPLOY.** Nada de este documento se ha ejecutado.
El despliegue lo realiza el agente principal, que es quien gestiona las
credenciales AWS. No hay secretos en este checklist.

## Contexto

La Lambda desplegada `drex-push-sender` (us-east-1) solo reacciona a eventos
`INSERT` del stream de la tabla `notifications` en `drex-kv` e ignora
notificaciones con más de 15 minutos. No tiene entrega diferida: con la app
del anfitrión **completamente cerrada**, un recordatorio de en vivo programado
jamás se dispara hoy.

El parche `docs/C253-LAMBDA-SCHEDREMINDERS.patch` (diff contra
`~/workspace/drex-push/lambda/index.mjs`) añade dos cosas:

1. **Deep-link `live`** en `deepLink()`: `actionType === 'live'` →
   ruta `envivo/<schedId>`. El router de la app ya la soporta
   (`envivo/:id` abre el visor). Entra en vigor al actualizar el código de
   la Lambda (no necesita EventBridge).
2. **`schedulerHandler` exportado**: escanea los tickets
   `liveReminders/<liveId>` (reensamblando las hojas que escribe
   `drex-cloud.js`), reclama atómicamente los vencidos y escribe los ítems
   `notifications/<uid>/<notifId>`; el handler del stream (ya desplegado)
   los convierte en push reales. Respeta el opt-out `fiestas` y traduce el
   mensaje al idioma del destinatario (`userSettings/<uid>/appLanguage`).

El cliente web (`index.html`) ya funciona sin esto mientras la app del
anfitrión se abra alguna vez (checker + catch-up). Este deploy es lo que
cierra el hueco de "app 100% cerrada".

## Verificación previa importante (hacer ANTES de desplegar)

El parche escribe los ítems de notificación como **objeto entero**
(`v` = JSON de la notificación), que es el formato que consume el handler
del stream en la copia del workspace (`JSON.parse(img.v.S) -> n.message`).
`addNotification()` del cliente escribe las notificaciones como **hojas**
(desglosadas por `drex-cloud.js`).

Antes de desplegar, confirmar contra la Lambda **realmente desplegada**
cuál formato produce push (la copia del workspace podría estar
desactualizada respecto a lo que corre en producción). Si la desplegada
maneja hojas, el `PutCommand` del `schedulerHandler` debe escribir las
notificaciones como hojas en vez de objeto entero. No desplegar a ciegas:
un formato equivocado = recordatorios silenciosos.

## Pasos

- [ ] 1. **Aplicar el parche** sobre una copia limpia de
      `~/workspace/drex-push/lambda/index.mjs`:
      `git apply docs/C253-LAMBDA-SCHEDREMINDERS.patch`
      (o `patch -p1 < docs/C253-LAMBDA-SCHEDREMINDERS.patch`).
- [ ] 2. **Empaquetar**: `npm install --omit=dev` y comprimir `index.mjs` +
      `node_modules` + `package.json` en un zip de despliegue.
- [ ] 3. **IAM**: verificar que el rol de ejecución de `drex-push-sender`
      tenga `dynamodb:Query`, `dynamodb:GetItem`, `dynamodb:PutItem`,
      `dynamodb:UpdateItem` y `dynamodb:BatchWriteItem` sobre `drex-kv`
      (el handler del stream ya usa Query/BatchWrite; confirmar los
      nuevos permisos antes de actualizar el código).
- [ ] 4. **Actualizar el código** de la Lambda:
      `aws lambda update-function-code --function-name drex-push-sender
      --zip-file fileb://deploy.zip` (us-east-1).
- [ ] 5. **EventBridge Scheduler**: crear el schedule que invoca el handler
      cada 5 minutos (el handler es idempotente y con claim atómico, así
      que una cadencia de 5 min es segura):
      ```
      aws scheduler create-schedule --name drex-sched-reminders \
        --schedule-expression "rate(5 minutes)" \
        --flexible-time-window '{ "Mode": "OFF" }' \
        --target '{ "Arn": "<lambda-arn>", "RoleArn": "<scheduler-role-arn>",
                     "Input": "{}" }'
      ```
      El target invoca `index.schedulerHandler`. El rol del scheduler
      necesita `lambda:InvokeFunction` sobre `drex-push-sender`.
- [ ] 6. **Variables de entorno**: ninguna nueva. El handler reutiliza las
      existentes (`DREX_TABLE`, `DREX_VAPID_*`). No exponer secretos en
      este checklist.
- [ ] 7. **CloudWatch**: invocar el schedule a mano una vez y confirmar
      `sched-result` en los logs (`{ scanned, fired, skipped }`).
- [ ] 8. **Prueba end-to-end real**: programar un en vivo, CERRAR la app
      por completo, y confirmar que el push llega a un seguidor a la hora
      del recordatorio con el mensaje en su idioma. Luego cancelar otro
      programado y confirmar que NO llega nada.
- [ ] 9. **Idempotencia bajo concurrencia**: con el schedule activo y la
      app abierta, forzar un `remindAt` y confirmar en CloudWatch que el
      recordatorio se envía una sola vez (el claim condicional evita el
      doble envío entre el schedule y el checker del cliente).
- [ ] 10. **Limpieza**: confirmar que al iniciar/cancelar/terminar el live
      el ticket desaparece (el schedule también borra tickets cuyo
      programado ya no esté vigente).

## Rollback

- Borrar el schedule: `aws scheduler delete-schedule --name drex-sched-reminders`.
- Revertir el código de la Lambda con el zip anterior:
  `aws lambda update-function-code --function-name drex-push-sender
  --zip-file fileb://deploy-anterior.zip`.
- Los tickets `liveReminders/` pendientes se pueden borrar a mano si hace
  falta; el checker del cliente los ignora si el programado ya no está vigente.

## Qué sigue siendo verdad después del deploy

- El deep-link `live` funciona para cualquier notificación con
  `actionType: 'live'`, incluidas las que envía el checker del cliente.
- La regla de los 15 minutos del handler del stream no afecta: el
  scheduler escribe notificaciones frescas.
- La app cerrada en el teléfono del **seguidor** no es problema: el push
  viaja por FCM/APNs igual que las notificaciones de chat actuales.
