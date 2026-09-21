# IDV — Checklist de despliegue (Lambda `drex-id-verification`)

**Fecha:** 2026-09-20 · **Rama:** `feature/age-verification` (commit local, sin merge/push)
**ZIP:** `lambda-drex-id-verification/drex-id-verification-lambda.zip`
**SHA-256 del ZIP:** `a67ae3dd416b00d097cea6c741bd7f1a8b1d8cc3d6d9d4c4acf0032c3f5b97f9`
**Tests:** 36/36 OK (`python3 tests/test-id-verification.py`)
**Modo por defecto:** `DREX_IDV_MODE=demo` (NO requiere keys de Veriff; el flujo es simulado).

> ⚠️ Nada aquí contiene credenciales reales. Las keys de Veriff se pegan solo en la
> consola de AWS (variables de entorno) o en Secure Vault, nunca en el repo.

---

## 1. Rol IAM mínimo (crear en consola: IAM → Roles → Create role → Lambda)

Política exacta (reemplaza `<ACCOUNT_ID>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DrexKvReadWrite",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:<ACCOUNT_ID>:table/drex-kv"
    },
    {
      "Sid": "CognitoGetUser",
      "Effect": "Allow",
      "Action": ["cognito-idp:GetUser"],
      "Resource": "*"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:<ACCOUNT_ID>:log-group:/aws/lambda/drex-id-verification:*"
    }
  ]
}
```

Notas:
- `cognito-idp:GetUser` no admite Resource específico de forma fiable en todas las
  regiones (es una acción de nivel de cuenta); por eso `Resource: "*"`.
- No se necesita `dynamodb:Scan` ni `DeleteItem`: la Lambda solo lee/escribe ítems puntuales.

---

## 2. Crear la función (consola Lambda, us-east-1)

1. **Lambda → Create function → Author from scratch**
   - Name: `drex-id-verification`
   - Runtime: **Python 3.12**
   - Architecture: x86_64 (o arm64, ambas funcionan; el ZIP es puro Python)
   - Execution role: el rol del paso 1.
2. **Subir el ZIP:** Code → Upload from → `.zip file` →
   `lambda-drex-id-verification/drex-id-verification-lambda.zip`
   - Handler: `lambda_function.lambda_handler` (viene por defecto).
3. **Configuration → Environment variables** (valores de ejemplo; las keys reales
   SOLO se pegan aquí, en consola):

   | Variable | Valor |
   |---|---|
   | `DREX_IDV_MODE` | `demo` (para probar) / `production` (con Veriff real) |
   | `KV_TABLE` | `drex-kv` |
   | `AWS_REGION` | `us-east-1` |
   | `VERIFF_API_KEY` | *(solo production)* API key pública de Veriff |
   | `VERIFF_SECRET_KEY` | *(solo production)* shared secret de Veriff |
   | `VERIFF_BASE_URL` | `https://stationapi.veriff.com/v1` (opcional) |
   | `IDV_MAX_SESSIONS_PER_USER_DAY` | `5` (opcional) |
   | `IDV_MAX_SESSIONS_PER_IP_DAY` | `20` (opcional) |

4. **Timeout:** 15 s (Configuration → General configuration). Memoria: 128 MB basta.

---

## 3. Function URL con CORS restringido

1. **Configuration → Function URL → Create**
   - Auth type: `NONE` (la autenticación la hace la propia Lambda: Cognito Bearer
     en `/session` y `/status`; HMAC en `/webhook`).
2. **CORS** (Allow origin: lista exacta, sin `*`):

   Orígenes de Drex (ajustar a los que estén vigentes):
   - `https://floreseternasoporte-creator.github.io`
   - `https://getdrex.com` (si ya apunta al sitio)
   - `https://drex.glamworksapps.workers.dev`

   - Allow methods: `GET, POST, OPTIONS`
   - Allow headers: `Authorization, Content-Type, X-HMAC-Signature`
   - Max age: `86400`

3. Anota la Function URL resultante, p. ej.
   `https://<id>.lambda-url.us-east-1.on.aws/` — el ingeniero 2 la necesita para
   `drex-cloud.js` / `index.html`.

---

## 4. Webhook en el portal de Veriff (solo modo production)

1. En el Veriff Customer Portal, en la integración, configura **Webhook decision URL**:
   `https://<id>.lambda-url.us-east-1.on.aws/webhook`
   (la URL debe ser HTTPS con certificado público válido; Veriff solo llama HTTPS).
2. La Lambda verifica la firma con el header `X-HMAC-SIGNATURE`
   (HMAC-SHA256 hex del body crudo con el shared secret).

---

## 5. Pruebas post-despliegue (modo demo primero)

```bash
BASE="https://<id>.lambda-url.us-east-1.on.aws"
TOKEN="<cognito access token de una cuenta de prueba>"

# 1. Crear sesión
curl -s -X POST "$BASE/session" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"country":"CU","documentType":"passport"}'
# -> {"sessionId": "...", "verificationUrl": "$BASE/demo/verify?token=...", ...}

# 2. Abrir verificationUrl en el navegador y pulsar "Simular aprobación"

# 3. Verificar estado
curl -s "$BASE/status" -H "Authorization: Bearer $TOKEN"
# -> {"status":"verified","country":"CU","verifiedAt":...,"method":"id_document","provider":"demo"}

# 4. Sin token -> 401
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/status"   # debe dar 401

# 5. Rate limit: crear 6 sesiones el mismo día -> la 6ª debe dar 429
```

En CloudWatch (`/aws/lambda/drex-id-verification`) confirma que los logs contienen
solo `sessionId` + clase de evento (`session_created`, `decision_applied`, …),
sin PII ni secretos.

## 6. Pasar a production

1. Poner `DREX_IDV_MODE=production` + `VERIFF_API_KEY` / `VERIFF_SECRET_KEY`
   (variables de entorno de la Lambda, en consola).
2. Redeploy (el código no cambia; basta actualizar env vars).
3. Crear una sesión real con una cuenta de prueba y completar el flujo con un
   documento real en el `verificationUrl` de Veriff.
4. Revisar en DynamoDB `drex-kv` el ítem
   `pk='users', sk='<sub>/birthdayVerification'` → `{"status":"verified", ...}`.
5. Revisar que llegó la notificación in-app
   (`pk='notifications', sk='<sub>/<pushId>'`).

## 7. Rollback

- Volver a `DREX_IDV_MODE=demo` deja el flujo simulado sin tocar datos existentes.
- Para deshabilitar por completo: borrar la Function URL (la Lambda deja de ser
  alcanzable) sin borrar la función.
