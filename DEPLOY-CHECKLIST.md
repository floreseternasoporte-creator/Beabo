# DEPLOY CHECKLIST — drex-payments (Stripe + Drex Coins)

Backend REAL de pagos. Nada simulado: sin completar estos pasos, la tienda
sigue mostrando "Próximamente" con honestidad.

**Estado actual (2026-09-28):** código de la Lambda + cliente + i18n
terminados y probados (16/16 tests). **NO desplegado**: este servidor no
tiene AWS CLI ni credenciales, y faltan las claves de Stripe (las debe dar
Darel por la página segura de captura). El deploy lo ejecuta quien tenga
las credenciales AWS siguiendo esta guía.

---

## FASE 0 — Cuenta de Stripe (la hace Darel o quien tenga acceso)

- [ ] Crear la cuenta en https://dashboard.stripe.com (si no existe).
- [ ] Quedarse en **modo Test** (toggle "Test mode" activado).
- [ ] Developers → API keys → copiar la **Secret key** (`sk_test_…`).
      ⚠️ SOLO por la página segura de captura. Jamás por chat, jamás en el repo.
- [ ] (El `whsec_…` se genera en la FASE 2.)

## FASE 1 — Desplegar la Lambda en AWS

Requiere AWS CLI configurado con acceso a la cuenta donde vive `drex-kv`
(región `us-east-1`). En una máquina con credenciales:

```bash
cd ~/workspace/drex-wave2/lane-pay/lambda-drex-payments
chmod +x deploy.sh
STRIPE_SECRET_KEY='sk_test_...' STRIPE_WEBHOOK_SECRET='whsec_...' ./deploy.sh
```

El script hace todo: rol IAM (`drex-payments-role` con
`dynamodb:GetItem,UpdateItem,TransactWriteItems` sobre `drex-kv`), crea o
actualiza la función `drex-payments` (nodejs20.x, handler `index.handler`),
configura las variables de entorno y crea la **Function URL** (Auth NONE).

- [ ] El script imprime la Function URL. Anotarla:
      `https://<id>.lambda-url.us-east-1.on.aws/`
- [ ] Smoke test: `curl https://<id>.lambda-url.us-east-1.on.aws/health`
      → `{"ok":true,"service":"drex-payments",...}`

Variables que configura el script (verificables en la consola Lambda →
Configuration → Environment variables):

| Variable | Valor |
|---|---|
| DREX_TABLE | drex-kv |
| STRIPE_SECRET_KEY | sk_test_… (pegar la real) |
| STRIPE_WEBHOOK_SECRET | whsec_… (se completa en FASE 2; re-ejecutar deploy.sh) |
| COGNITO_USER_POOL_ID | us-east-1_kDSYEBsnY |
| COGNITO_CLIENT_ID | 7cm12q14tm12u8b3bnn6ksjqni |
| ALLOWED_ORIGINS | https://floreseternasoporte-creator.github.io,https://drex.glamworksapps.workers.dev |

## FASE 2 — Registrar el webhook en Stripe

1. En el dashboard de Stripe (modo **Test**): **Developers → Webhooks →
   Add endpoint**.
2. URL del endpoint: `<FUNCTION_URL>/webhook`
   (ej. `https://abc123.lambda-url.us-east-1.on.aws/webhook`).
3. Events to send: selecciona **`checkout.session.completed`**.
4. Add endpoint → abre el endpoint → **Signing secret** → Reveal →
   copiar el `whsec_…`.
5. Ponerlo como `STRIPE_WEBHOOK_SECRET` en la Lambda y **re-ejecutar**
   `deploy.sh` (o editar la variable en la consola y listo).

- [ ] Webhook registrado y `whsec_…` configurado en la Lambda.

## FASE 3 — Activar en la app

En `index.html` (coordinador: integrar el diff de este carril):

```js
var DREX_PAYMENTS_ENDPOINT = 'https://<id>.lambda-url.us-east-1.on.aws';
```

- [ ] Publicar (push + rebuild de Pages, como los demás carriles).
- [ ] Verificar en el teléfono: Billetera → Recargar → los 6 paquetes
      muestran **Comprar** (ya no "Próximamente").

## FASE 4 — Prueba end-to-end (modo test)

- [ ] Comprar el paquete de **$0.99** en la app → debe abrir Stripe Checkout.
- [ ] Pagar con `4242 4242 4242 4242`, fecha futura, cualquier CVC.
- [ ] Stripe redirige a la app con `?coins=success`; el toast dice
      "Pago recibido. Tus monedas se acreditarán en unos segundos."
- [ ] En ≤30 s el saldo sube **+100** y el historial muestra
      "Compra de monedas".
- [ ] **Idempotencia**: en Stripe → Developers → Webhooks → el evento
      `checkout.session.completed` → "…" → **Resend** → el saldo NO sube
      dos veces.
- [ ] Cancelar un pago (botón atrás en Checkout) → la app dice
      "Pago cancelado. No se realizó ningún cargo." y el saldo no cambia.
- [ ] CloudWatch Logs de `drex-payments`: `coins credited { pkg: 'coins_100', … }`.

## FASE 5 — Pasar a LIVE (dinero real)

⚠️ Solo cuando la FASE 4 esté verde.

- [ ] En Stripe, salir del modo test (**modo Live**).
- [ ] Developers → API keys (live) → nueva **Secret key** `sk_live_…`.
- [ ] Registrar **otro** endpoint webhook (misma URL `/webhook`) en modo
      live → nuevo `whsec_…` live.
- [ ] Actualizar `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` en la Lambda
      con los valores **live** (re-ejecutar `deploy.sh`).
- [ ] Compra real de **$0.99**: verificar abono de 100 monedas + recibo en
      el historial + evento `checkout.session.completed` en el dashboard.

## Rollback

- Vaciar `DREX_PAYMENTS_ENDPOINT` en la app → la tienda vuelve al estado
  honesto "Próximamente". Las monedas ya acreditadas no se tocan.

## Costos operativos (referencia)

- Lambda: ~invocaciones insignificantes (solo en compras).
- DynamoDB: unas pocas escrituras por compra.
- Stripe: 2.9% + $0.30 USD por cargo exitoso (tarifas estándar EE. UU.;
  verificar en stripe.com/pricing para la cuenta real).

## Qué pedirle a Darel (mensaje exacto al final del reporte del carril)

Las **claves de Stripe en modo test** (`sk_test_…`) entregadas por la
**página segura de captura** (él pega, nadie las ve en el chat). Sin eso,
el carril queda en código + checklist, que es el estado actual correcto.
