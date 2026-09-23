# DEPLOY — drex-error-ingest (Lambda + Function URL)

Cierra el circuito de la telemetría del cliente web: `DrexCloud.reliability`
envía los errores muestreados (10 %) a `window.DREX_ERROR_INGEST_URL`.
Sin esta Lambda, los errores solo quedan en el localStorage del navegador.

## 1. Crear la función (consola AWS, us-east-1)

1. Lambda → Crear función → "Crear desde cero".
   - Nombre: `drex-error-ingest`
   - Runtime: Python 3.12 (o superior con boto3 preinstalado)
   - Arquitectura: x86_64
2. Pegar `lambda_function.py` como código fuente. Handler: `lambda_function.lambda_handler`.
3. Variables de entorno (opcional, tienen defaults sanos):
   - `DREX_TABLE=drex-kv`, `RL_MAX=60`, `RL_WINDOW=60`.

## 2. Permisos (rol de ejecución)

Política mínima sobre la tabla `drex-kv`:
- `dynamodb:PutItem`, `dynamodb:UpdateItem`

## 3. Function URL

1. Configuración → Function URL → Crear.
   - Tipo de autenticación: **NONE** (el cliente web no firma; la protección
     es validación estricta + rate limit por IP + muestreo del cliente).
   - CORS: no hace falta configurarlo aquí (la Lambda responde los
     headers CORS ella misma, igual que `drex-username-resolve`).
2. Copiar la URL (formato `https://<id>.lambda-url.us-east-1.on.aws/`).

## 4. Conectar el cliente

En `index.html`, justo después del `<script src="...drex-cloud.js">` del
`<head>`, agregar:

```html
<script>window.DREX_ERROR_INGEST_URL='https://<id>.lambda-url.us-east-1.on.aws/';</script>
```

Y pushear `index.html` + `404.html` (paridad byte-idéntica).

## 5. Verificación

```bash
curl -s -X POST 'https://<id>.lambda-url.us-east-1.on.aws/' \
  -H 'Content-Type: application/json' \
  -d '{"app":"drex-web","v":1,"batch":[{"v":1,"ts":'$(date +%s)',"kind":"deploy-test","msg":"ping","stack":"","url":"","line":null,"col":null,"sig":"ping"}]}'
# → {"ok": true}
```

Luego en DynamoDB → Explorar elementos → tabla `drex-kv` →
`pk = 'clientErrors'` debe mostrar el ítem de prueba.

## 6. Limpieza automática (opcional, recomendado)

Habilitar TTL en `drex-kv` sobre el atributo `ttl` para que los eventos
expiren a los 7 días. Sin TTL, los ítems se acumulan (cada uno < 3 KB).

## 7. Lectura de errores

DynamoDB → tabla `drex-kv` → filtrar `pk = 'clientErrors'`, ordenar por
`sk` (empieza con `AAAAMMDD/`). Los `kind` actuales: `login`,
`login-social`, `publish`, `feed-load`, más los globales del colector
(`window.onerror` / `unhandledrejection`).
