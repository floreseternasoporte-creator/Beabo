# Pagos de Drex Coins — Stripe (backend real)

La tienda de Drex Coins cobra de verdad con **Stripe Checkout** a través de
la Lambda **`drex-payments`** (código en `lane-pay/lambda-drex-payments/`).

## Cómo funciona

1. El usuario toca **Comprar** en un paquete.
2. La app pide `POST <DREX_PAYMENTS_ENDPOINT>/create-checkout-session`
   con `{packageId, idToken, returnUrl}`. El backend valida el ID token de
   Cognito, valida el paquete contra la lista canónica y crea la sesión en
   Stripe.
3. El navegador va a **Stripe Checkout**; el usuario paga con tarjeta.
4. Stripe redirige a la app con `?coins=success` (o `?coins=cancelled`).
5. Stripe llama a `POST <DREX_PAYMENTS_ENDPOINT>/webhook`
   (`checkout.session.completed`, firma verificada con el webhook secret).
   La Lambda **acredita las monedas en DynamoDB** de forma transaccional e
   idempotente (un evento nunca abona dos veces).

El cliente **nunca** se auto-acredita monedas por una compra.

## Sin backend configurado (estado honesto)

Si `DREX_PAYMENTS_ENDPOINT` está vacío (valor por defecto), la tienda
muestra los paquetes con el botón **"Próximamente"** (deshabilitado) y el
aviso: *"Pagos no disponibles todavía"* / *"Drex Coins no tienen valor en
dinero…"*. Ningún botón cobra nada y no se acredita ninguna moneda.

## Variables de entorno de la Lambda

| Variable                | Descripción                                              |
|-------------------------|----------------------------------------------------------|
| `STRIPE_SECRET_KEY`     | `sk_test_…` / `sk_live_…` (**secreto**)                  |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` del endpoint en el dashboard de Stripe (**secreto**) |
| `DREX_TABLE`            | Tabla DynamoDB (default `drex-kv`)                       |
| `COGNITO_USER_POOL_ID`  | `us-east-1_kDSYEBsnY`                                    |
| `COGNITO_CLIENT_ID`     | `7cm12q14tm12u8b3bnn6ksjqni` (público)                    |
| `ALLOWED_ORIGINS`       | Orígenes permitidos, coma-separados                      |
| `RL_MAX` / `RL_WINDOW_SEC` | Rate limiting de creación de sesiones (opcional)      |

Las claves **solo** viven como variables de entorno de la Lambda (o en la
página segura de captura): jamás en el repo, jamás en memoria del agente,
jamás en logs.

## Paquetes canónicos (precio y monedas)

Deben coincidir entre la app (`DREX_COIN_PACKAGES`) y la Lambda (`PACKAGES`):

| id            | monedas | USD   |
|---------------|---------|-------|
| coins_100     | 100     | 0.99  |
| coins_550     | 550     | 4.99  |
| coins_1200    | 1200    | 9.99  |
| coins_3250    | 3250    | 24.99 |
| coins_7000    | 7000    | 49.99 |
| coins_15000   | 15000   | 99.99 |

## Esquema DynamoDB

- Billetera: `pk='wallets'`, `sk='<uid>/coins|diamonds|updatedAt'`, `v` = JSON.
- Libro: `pk='transactions'`, `sk='<uid>/<txid>/<campo>'` (lo lee el historial).
- Idempotencia: `pk='stripe_events'`, `sk='<eventId>'`.

## Activar en la app

Tras desplegar la Lambda, pon su Function URL en `index.html`:

```js
var DREX_PAYMENTS_ENDPOINT = 'https://xxxxxx.lambda-url.us-east-1.on.aws';
```

## Checklist de despliegue

Ver `lane-pay/DEPLOY-CHECKLIST.md` (paso a paso: Lambda, webhook en
Stripe, modo test, paso a live).
