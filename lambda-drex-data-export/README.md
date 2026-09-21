# Lambda `drex-data-export` — backend durable de "Descargar mis datos"

Backend servidor para el flujo asíncrono estilo Meta: solicitar → preparar
(minutos a días, sobrevive al cierre de la pestaña) → notificar in-app →
descargar vía URL pre-firmada S3.

Diseño: `../docs/EXPORT-BACKEND-DESIGN.md` · Mapa de datos: `../docs/DATA-SCHEMA.md`

## Contenido

| Archivo | Qué es |
|---|---|
| `lambda_function.py` | Toda la Lambda (único archivo del ZIP). Acciones `request` y `download-url` por Function URL; `worker` y `sweep` internos. |
| `build-zip.sh` | `py_compile` + tests + empaquetado reproducible → `drex-data-export-lambda.zip`. |
| `drex-data-export-lambda.zip` | Artefacto listo para subir (se genera con `build-zip.sh`). |
| `tests/test_lambda.py` | Harness local con dobles de DynamoDB/S3/Cognito/Lambda (no toca AWS). |

## Variables de entorno (configurar al crear la función)

| Variable | Valor |
|---|---|
| `DREX_TABLE` | `drex-kv` |
| `DREX_SUPPORT_TABLE` | `drex-support-tickets` |
| `EXPORT_BUCKET` | `drex-exports-002493750027` |
| `COGNITO_USER_POOL_ID` | `us-east-1_kDSYEBsnY` |
| `AWS_REGION` | `us-east-1` |
| `RL_EXPORT_USER_MAX` / `RL_EXPORT_USER_WINDOW` | `3` / `3600` (3 solicitudes/hora por usuario) |
| `RL_EXPORT_IP_MAX` / `RL_EXPORT_IP_WINDOW` | `100` / `3600` |
| `RL_DL_USER_MAX` / `RL_DL_USER_WINDOW` | `30` / `3600` (30 descargas/hora por usuario) |
| `CORS_ORIGINS` | (opcional) sobreescribe la allowlist por defecto |

Config de la función: runtime **Python 3.12**, handler `lambda_function.lambda_handler`,
memoria **512 MB**, timeout **15 min** (900 s).

## Contrato rápido

- `POST /` `{"action":"request","format":"json"|"html","browserSnapshot"?,"lang"?}`
  con `Authorization: Bearer <accessToken>` → `200 {jobId, status:"requested", ...}`
  (idempotente: si hay un job activo devuelve el existente con `alreadyActive:true`).
- `POST /` `{"action":"download-url","jobId"}` → `200 {url, expiresIn:900, filename, sha256, size}`.
- Errores genéricos: `400 bad_action|bad_snapshot|snapshot_too_large`,
  `401 invalid_token`, `404 not_found` (también para jobs ajenos),
  `409 not_ready`, `410 expired`, `429 too_many_requests`.

## Notas de seguridad

- El `sub` sale **solo** del token verificado con `cognito-idp:GetUser`.
- El worker valida `workerToken` con `hmac.compare_digest` antes de continuar.
- En CloudWatch **nunca** se registra PII: solo `jobId`, sección y clase de error
  (verificar con `grep` antes de cada despliegue).
- Las 27 secciones aplican las exclusiones de `DATA-SCHEMA.md` + `strip_secrets_deep()`.
