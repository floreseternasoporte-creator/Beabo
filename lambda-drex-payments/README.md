# drex-payments — backend REAL de pagos de Drex Coins

Lambda (Node 20) que conecta la tienda de Drex Coins con **Stripe Checkout**.
Nada simulado: crea sesiones de pago reales y acredita las monedas solo
cuando Stripe confirma el cobro (webhook firmado).

## Endpoints (Function URL, Auth NONE)

| Método | Ruta                     | Uso                                   |
|--------|--------------------------|---------------------------------------|
| POST   | /create-checkout-session | La app pide la sesión de pago         |
| POST   | /webhook                 | Stripe notifica el pago (firmado)     |
| GET    | /health                  | Smoke test: `{ok:true}`               |

## Variables de entorno

| Variable              | Ejemplo / notas                                              |
|-----------------------|--------------------------------------------------------------|
| `DREX_TABLE`          | `drex-kv` (default si se omite)                              |
| `STRIPE_SECRET_KEY`   | `sk_test_…` / `sk_live_…` — **SECRETO**, solo env var        |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` del endpoint registrado en Stripe — **SECRETO**  |
| `COGNITO_USER_POOL_ID` | `us-east-1_kDSYEBsnY`                                       |
| `COGNITO_CLIENT_ID`   | `7cm12q14tm12u8b3bnn6ksjqni` (público; vive en la app)       |
| `ALLOWED_ORIGINS`     | `https://floreseternasoporte-creator.github.io,https://drex.glamworksapps.workers.dev` |
| `RL_MAX`              | `30` (sesiones por IP y ventana; opcional)                   |
| `RL_WINDOW_SEC`       | `600` (ventana en segundos; opcional)                        |

NUNCA pongas las claves en el código, en el repo ni en los logs.

## Seguridad

- `POST /create-checkout-session` exige el **ID token de Cognito** del
  comprador: se verifica la firma RS256 contra el JWKS del user pool
  (`iss`, `aud`, `exp`, `token_use=id`, `sub`). Sin token válido → 401.
- El paquete se valida contra la **lista canónica** embebida (6 paquetes);
  el precio y las monedas acreditadas salen de ahí, nunca del cliente.
- `POST /webhook` verifica la firma con `STRIPE_WEBHOOK_SECRET`
  (`stripe.webhooks.constructEvent`). Firma inválida → 400.
- **Idempotencia**: cada evento de Stripe se registra en
  `pk='stripe_events', sk='<eventId>'` dentro de la misma transacción que
  acredita las monedas. Un reintento de Stripe no abona dos veces.
- **Anti-carrera**: la acreditación es una `TransactWriteItems` con
  `ConditionCheck` sobre la hoja `wallets/<uid>/coins`: si otro escritor
  (un regalo, otra compra) la tocó entre la lectura y la escritura, se
  reintenta con el valor fresco (máx. 3 intentos).
- Rate limiting por IP en la creación de sesiones (ventana fija atómica).
- CORS restringido a `ALLOWED_ORIGINS`.

## Esquema DynamoDB (compatible con drex-cloud.js)

- Billetera: `pk='wallets'`, `sk='<uid>/coins'`, `v='<n>'` (JSON numérico),
  más `sk='<uid>/updatedAt'`.
- Recibo: `pk='transactions'`, `sk='<uid>/<txid>/<campo>'` con los campos
  `txid, type='purchase', amount, currency='coins', balance, ts, meta`
  (lo lee `DrexCoins.history()` en la app).
- Idempotencia: `pk='stripe_events'`, `sk='<eventId>'`.

## Empaquetar

```bash
cd ~/workspace/drex-wave2/lane-pay/lambda-drex-payments
npm install --omit=dev
zip -r ../drex-payments.zip index.mjs package.json node_modules
```

## Desplegar

Ver `deploy.sh` (mismo patrón que `drex-push-sender`) y el checklist paso a
paso en `../DEPLOY-CHECKLIST.md`.

Resumen:

```bash
./deploy.sh   # crea/actualiza la Lambda + Function URL (requiere AWS CLI con credenciales)
```

Después de desplegar:

1. Copia la **Function URL** que imprime el script.
2. En el dashboard de Stripe: Developers → Webhooks → Add endpoint →
   pega `<FUNCTION_URL>/webhook`, elige el evento
   `checkout.session.completed`, y copia el **Signing secret** (`whsec_…`).
3. Pon `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` y el resto de variables
   en la configuración de la Lambda (consola o `deploy.sh`).
4. En la app, pon la Function URL en `DREX_PAYMENTS_ENDPOINT` (index.html)
   para activar los botones "Comprar".

## Probar (modo test de Stripe)

1. `GET <FUNCTION_URL>/health` → `{ok:true}`.
2. En la app (apuntando al endpoint): abre la billetera → Recargar →
   elige el paquete de $0.99 → Comprar. Debes llegar a Stripe Checkout.
3. Paga con la tarjeta de prueba `4242 4242 4242 4242`, cualquier fecha
   futura y cualquier CVC.
4. Stripe redirige a la app con `?coins=success`; en unos segundos el
   saldo sube 100 y el historial muestra "Compra de monedas".
5. Prueba de idempotencia: en el dashboard de Stripe, reenvía el evento
   `checkout.session.completed` → el saldo NO debe subir dos veces.

## Pasar a live

1. En Stripe: cambia a **modo Live**, genera las claves live
   (`sk_live_…`) y registra OTRO endpoint webhook (el mismo path) para
   obtener su `whsec_…` live.
2. Actualiza las variables de entorno de la Lambda con las claves live.
3. Haz una compra real pequeña ($0.99) y verifica el abono y el recibo.
