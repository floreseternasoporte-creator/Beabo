# Drex Orbit — escalera de planes (2026-10-01)

Catálogo canónico del lado cliente: `ORBIT_PLANS` en `index.html`
(nombre, precio, intervalo visible; los price IDs de Stripe viven SOLO en
la Lambda `drex-payments`, nunca en el frontend).

## La escalera

| Plan (id)   | Precio   | Intervalo visible | Tipo              | $/mes equiv. | Insignia UI   |
|-------------|----------|-------------------|-------------------|--------------|---------------|
| `weekly`    | $1.99    | a la semana       | recurrente semanal| $8.62        | —             |
| `monthly`   | $4.99    | al mes            | recurrente mensual| $4.99        | —             |
| `quarterly` | $12.99   | al trimestre      | recurrente c/3 m  | $4.33        | Ahorra 13%    |
| `semiannual`| $24.99   | al semestre       | recurrente c/6 m  | $4.17        | Ahorra 17%    |
| `yearly`    | $49.99   | al año            | recurrente anual  | $4.17        | Ahorra 2 meses · **Recomendado** |
| `biennial`  | $89.99   | cada 2 años       | recurrente c/2 años| $3.75       | Ahorra 25%    |
| `lifetime`  | $149.99  | pago único        | **pago único**    | —            | Para siempre  |

Ahorros calculados contra el mensual ($4.99/mes). El semanal es la puerta
de entrada (compromiso mínimo), no un ahorro: sale más caro por mes.

### Decisión: "2 años" es recurrente cada 2 años
Stripe soporta `recurring: {interval: 'year', interval_count: 2}`. Se
mantiene como suscripción (cancelable, portal de Stripe, webhooks de
renovación) en vez de pago único: el descuento es el ciclo largo, no la
permanencia. Documentado también en el comentario de `ORBIT_PLANS`.

### Decisión: "De por vida" es pago único (no suscripción)
- El cliente pide el checkout con `plan: 'lifetime'` al mismo endpoint
  (`POST /create-subscription-session`); la Lambda debe crear la sesión en
  `mode: 'payment'` (no `'subscription'`).
- El gating es fail-closed: el webhook debe escribir
  `users/<sub>/orbit = {status: 'active', plan: 'lifetime',
  currentPeriodEnd: null, ...}` (sin fecha de vencimiento =
  `orbitIsActive()` lo considera activo permanente). Ante cualquier duda,
  sin registro firmado no hay acceso.
- La UI muestra "Comprar" (no "Suscribirme") y "Sin renovaciones: tuyo
  para siempre."

## Price IDs de Stripe — configuración

El frontend NO lleva price IDs (test `test-orbit-plans.js` lo verifica).
Viven en env vars de la Lambda `drex-payments`:

| Plan       | Env var (propuesta)              | Estado            |
|------------|----------------------------------|-------------------|
| weekly     | `STRIPE_PRICE_ORBIT_WEEKLY`      | pendiente         |
| monthly    | `STRIPE_PRICE_ORBIT_MONTHLY`     | existente         |
| quarterly  | `STRIPE_PRICE_ORBIT_QUARTERLY`   | pendiente         |
| semiannual | `STRIPE_PRICE_ORBIT_SEMIANNUAL`  | pendiente         |
| yearly     | `STRIPE_PRICE_ORBIT_YEARLY`      | existente         |
| biennial   | `STRIPE_PRICE_ORBIT_BIENNIAL`    | pendiente         |
| lifetime   | `STRIPE_PRICE_ORBIT_LIFETIME`    | pendiente         |

### ⏳ Paso pendiente (solo lo puede hacer el usuario)
La clave TEST de Stripe **no es accesible desde este servidor** (sin
`STRIPE_SECRET_KEY` en env ni archivos de config; verificado 2026-10-01),
así que los productos/precios NO se crearon por API. Pasos:
1. En el dashboard de Stripe (modo TEST): Products → crear un producto
   "Drex Orbit" con 7 precios: $1.99/semana, $4.99/mes, $12.99 cada
   3 meses, $24.99 cada 6 meses, $49.99/año, $89.99 cada 2 años
   (recurrentes) y $149.99 pago único.
2. Copiar cada `price_…` y pegarlo en las env vars de la Lambda
   (`STRIPE_PRICE_ORBIT_*`), o pasarlo al desplegar con `deploy.sh`.
3. Stripe sigue en modo TEST por orden del usuario: no activar live.

## Cambios requeridos en la Lambda (carril backend — NO tocada aquí)

`lambda-drex-payments/index.js` necesita, antes de que los planes nuevos
vendan de verdad:
1. `ORBIT_PLANS`: agregar `weekly`, `biennial`, `lifetime` (y el
   `price_data` inline o price ID por env var de cada uno). Nota: el
   webhook `handleKoroneCheckoutCompleted` hoy rechaza todo plan que no
   sea `monthly`/`yearly` con `bad_metadata` — **hay que ampliar la
   validación a los 7 ids** o los cobros de `quarterly`/`semiannual`
   (que el catálogo ya ofrece) nunca activarían el entitlement.
2. `lifetime`: sesión Checkout `mode: 'payment'` + rama en el webhook
   para `checkout.session.completed` con `mode: 'payment'` y metadata
   `drex_orbit_plan: 'lifetime'` que escriba el estado permanente.
3. `orbitConfigured()`: incluir las nuevas env vars (hoy solo mira
   MONTHLY/YEARLY; el cliente activa puertas con `configured:true`).
4. `deploy.sh`: hoy ni siquiera exporta `STRIPE_PRICE_ORBIT_MONTHLY` /
   `_YEARLY` a la Lambda — agregar las 7 vars al
   `update-function-configuration`.
5. `DEPLOY-CHECKLIST.md`: checklist de crear los 7 precios en Stripe.

## i18n
Claves nuevas en `drex_orbit_i18n.py` (lista autoritativa) → `drex-i18n.js`
(EN/ZH/PT): Semanal, semana, mes, trimestre, semestre, año, al, 2 años,
cada 2 años, De por vida, pago único, Recomendado, Ahorra 13%/17%/25%,
Para siempre, "Sin renovaciones: tuyo para siempre.", Desde.
Ojo: el marcador de cierre del diccionario PT en `drex_orbit_i18n.py` se
corrigió a `var APP_CHINESE_ATTRS = {` (el viejo abarcaba
`APP_CHINESE_ATTRS` y las claves caían en el diccionario chino).

## Tests
- `tests/test-orbit-plans.js` (nuevo, 113 aserciones): catálogo válido,
  precios > 0, planes históricos intactos, intervalos coherentes, un solo
  `one_time`, escalera ascendente, UI renderiza los 7, paridad i18n,
  sin price IDs en frontend, fail-closed.
- `tests/test-drex-orbit-frontend.js`: 62 ok (sin regresiones).
