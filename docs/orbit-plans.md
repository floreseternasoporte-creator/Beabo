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

## Estado de extremo a extremo (verificado 2026-10-01 contra la Lambda real)

`POST /create-subscription-session` (endpoint `DREX_PAYMENTS_ENDPOINT`):

| Plan (id)   | Precio   | Respuesta del backend hoy | UI del cliente (carril 3) |
|-------------|----------|---------------------------|---------------------------|
| `monthly`   | $4.99    | pasa validación → crea Checkout (requiere `STRIPE_PRICE_ORBIT_MONTHLY`) | Suscribirme activo |
| `quarterly` | $12.99   | pasa validación → crea Checkout (price_data inline, sin env var) | Suscribirme activo |
| `semiannual`| $24.99   | pasa validación → crea Checkout (price_data inline, sin env var) | Suscribirme activo |
| `yearly`    | $49.99   | pasa validación → crea Checkout (requiere `STRIPE_PRICE_ORBIT_YEARLY`) | Suscribirme activo |
| `weekly`    | $1.99    | **400 `invalid_plan`** (la Lambda no conoce este id) | tarjeta deshabilitada · `plan-coming-soon` · etiqueta `orbit_coming_soon` ("Próximamente") |
| `biennial`  | $89.99   | **400 `invalid_plan`** ← causa raíz del error del usuario | igual que weekly |
| `lifetime`  | $149.99  | **400 `invalid_plan`** (además requiere `mode:'payment'` en el backend) | igual que weekly |

Causa raíz del error "Error al iniciar el pago. Inténtalo de nuevo." (usuario
tocó $89.99/2 años): el cliente ofrecía "Suscribirme" para un plan que la
Lambda `drex-payments` no conoce → 400 `invalid_plan` → el catch caía al
mensaje genérico. Corregido en el cliente: `ORBIT_BACKEND_PLANS` (lista de
lo que el backend acepta hoy), tarjetas `data-plan-id` + `plan-coming-soon`
+ `data-unavailable="true"` sin botón de pago, etiqueta i18n
`orbit_coming_soon` ("Próximamente"/"Coming soon"/"即将上线"/"Em breve") y
toasts específicos (red / servidor / plan no disponible). Verificación
completa de compra (Stripe Checkout → webhook → entitlement) aún pendiente
en iPhone del usuario; Stripe sigue en modo TEST por su orden.

## Price IDs de Stripe — configuración

El frontend NO lleva price IDs (test `test-orbit-plans.js` lo verifica).
Viven en env vars de la Lambda `drex-payments`. Estado real:

| Plan       | Env var                                   | Estado hoy |
|------------|-------------------------------------------|------------|
| weekly     | `STRIPE_PRICE_ORBIT_WEEKLY`               | pendiente — y la Lambda ni siquiera conoce el id (400 `invalid_plan`) |
| monthly    | `STRIPE_PRICE_ORBIT_MONTHLY`              | existente |
| quarterly  | *(ninguna: usa `price_data` inline en la Lambda)* | funciona sin configurar |
| semiannual | *(ninguna: usa `price_data` inline en la Lambda)* | funciona sin configurar |
| yearly     | `STRIPE_PRICE_ORBIT_YEARLY`               | existente |
| biennial   | `STRIPE_PRICE_ORBIT_BIENNIAL`             | pendiente — id desconocido por la Lambda |
| lifetime   | `STRIPE_PRICE_ORBIT_LIFETIME`             | pendiente — id desconocido + falta rama `mode:'payment'` |

### ⏳ Paso pendiente (solo lo puede hacer el usuario)
1. En el dashboard de Stripe (**modo TEST**, no activar live): Products →
   crear el producto "Drex Orbit" con los precios que falten:
   - $1.99/semana (recurrente)
   - $89.99 cada 2 años (recurrente; en Stripe: intervalo `year`, `interval_count: 2`)
   - $149.99 pago único
   (monthly $4.99, quarterly $12.99, semiannual $24.99 y yearly $49.99 ya
   existen o no necesitan precio: quarterly/semiannual van con `price_data`
   inline desde la Lambda.)
2. Copiar cada `price_…` TEST y pegarlo en las env vars de la Lambda
   (`STRIPE_PRICE_ORBIT_WEEKLY`, `STRIPE_PRICE_ORBIT_BIENNIAL`,
   `STRIPE_PRICE_ORBIT_LIFETIME`) o pasarlo al desplegar con `deploy.sh`
   (que hoy ni siquiera exporta las 7 vars — ver "Cambios requeridos").
3. Pedir al carril backend que amplíe `lambda-drex-payments/index.js`
   (sección "Cambios requeridos" abajo) y redesplegar; recién entonces
   agregar los ids a `ORBIT_BACKEND_PLANS` en el frontend.
4. QA en su iPhone: compra de prueba con tarjeta test
   `4242 4242 4242 4242` para mensual y anual (pendiente).

## Cambios requeridos en la Lambda (carril backend — NO tocada aquí)

`lambda-drex-payments/index.js` necesita, antes de que los planes nuevos
vendan de verdad:
1. `ORBIT_PLANS`: agregar `weekly`, `biennial`, `lifetime` (y el
   `price_data` inline o price ID por env var de cada uno). Nota: el
   webhook `handleKoroneCheckoutCompleted` hoy rechaza todo plan que no
   sea `monthly`/`yearly` con `bad_metadata` — **hay que ampliar la
   validación a los 7 ids** o los cobros de `quarterly`/`semiannual`
   (que ya venden) nunca activarían el entitlement.
2. `lifetime`: sesión Checkout `mode: 'payment'` + rama en el webhook
   para `checkout.session.completed` con `mode: 'payment'` y metadata
   `drex_orbit_plan: 'lifetime'` que escriba el estado permanente.
3. `orbitConfigured()`: incluir las nuevas env vars (hoy solo mira
   MONTHLY/YEARLY; el cliente activa puertas con `configured:true`).
4. `deploy.sh`: hoy ni siquiera exporta `STRIPE_PRICE_ORBIT_MONTHLY` /
   `_YEARLY` a la Lambda — agregar las 7 vars al
   `update-function-configuration`.
5. `DEPLOY-CHECKLIST.md`: checklist de crear los 7 precios en Stripe.

Contrato con el frontend (carril 3, 2026-10-01): el cliente solo muestra
"Suscribirme" para los ids de `ORBIT_BACKEND_PLANS` en `index.html`
(hoy: monthly, quarterly, semiannual, yearly). Cuando el backend acepte
un id nuevo, agregarlo ahí en el mismo push que el redespliegue de la
Lambda; si no, el plan queda en "Próximamente" por diseño.

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
- `tests/test-orbit-plans-availability.js` (nuevo, carril 3): planes sin
  precio en el backend (weekly/biennial/lifetime) → tarjeta con
  `data-plan-id` + clase `plan-coming-soon` + `data-unavailable="true"`,
  sin botón `orbitSubscribe`, con la etiqueta `orbit_coming_soon`;
  planes soportados → botón activo; `orbitSubscribe` rechaza planes no
  disponibles sin tocar red; paridad i18n de las 4 claves nuevas en
  ES/EN/ZH/PT; toasts específicos por tipo de fallo.
- `tests/test-drex-orbit-frontend.js`: 62 ok (sin regresiones).
