#!/bin/bash
# Despliega drex-payments en AWS (requiere AWS CLI con credenciales válidas).
# Los SECRETOS se leen de variables de entorno o de archivos .txt junto a este
# script (jamás commiteados). Patrón: igual que drex-push-sender.
#
# Uso:
#   STRIPE_SECRET_KEY='sk_test_...' STRIPE_WEBHOOK_SECRET='whsec_...' ./deploy.sh
# o con archivos:
#   echo -n 'sk_test_...' > stripe-secret-key.txt
#   echo -n 'whsec_...'   > stripe-webhook-secret.txt
#   ./deploy.sh
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
TABLE="${DREX_TABLE:-drex-kv}"
FUNC="drex-payments"
DIR="$(cd "$(dirname "$0")" && pwd)"

read_secret() { # $1 = env var name, $2 = file name
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$DIR/$2" ]; then v="$(cat "$DIR/$2")"; fi
  printf '%s' "$v"
}

echo "== 1/5 Verificando identidad =="
aws sts get-caller-identity --region "$REGION" --output table
ACCOUNT_ID=$(aws sts get-caller-identity --region "$REGION" --query Account --output text)

STRIPE_SK="$(read_secret STRIPE_SECRET_KEY stripe-secret-key.txt)"
STRIPE_WS="$(read_secret STRIPE_WEBHOOK_SECRET stripe-webhook-secret.txt)"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_kDSYEBsnY}"
CLIENT_ID="${COGNITO_CLIENT_ID:-7cm12q14tm12u8b3bnn6ksjqni}"
ALLOWED="${ALLOWED_ORIGINS:-https://floreseternasoporte-creator.github.io,https://drex.glamworksapps.workers.dev}"
RL_MAX="${RL_MAX:-30}"
RL_WIN="${RL_WINDOW_SEC:-600}"

if [ -z "$STRIPE_SK" ]; then echo "FALTA STRIPE_SECRET_KEY (env o stripe-secret-key.txt)"; exit 1; fi
if [ -z "$STRIPE_WS" ]; then echo "FALTA STRIPE_WEBHOOK_SECRET (env o stripe-webhook-secret.txt)"; exit 1; fi

echo "== 2/5 Rol IAM para la Lambda =="
ROLE_NAME="drex-payments-role"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --output text >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name drex-kv-payments \
    --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:UpdateItem\",\"dynamodb:TransactWriteItems\"],\"Resource\":\"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE}\"}]}"
  echo "Rol creado, esperando propagación..."
  sleep 12
else
  echo "Rol ya existe."
fi
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "== 3/5 Empaquetando =="
cd "$DIR"
npm install --omit=dev >/dev/null 2>&1
zip -qr "$DIR/drex-payments.zip" index.mjs package.json node_modules

echo "== 4/5 Creando/actualizando función Lambda =="
if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNC" --region "$REGION" \
    --zip-file "fileb://$DIR/drex-payments.zip" --output text >/dev/null
  echo "Código actualizado."
  sleep 5
  aws lambda update-function-configuration --function-name "$FUNC" --region "$REGION" \
    --environment "Variables={DREX_TABLE=${TABLE},STRIPE_SECRET_KEY=${STRIPE_SK},STRIPE_WEBHOOK_SECRET=${STRIPE_WS},COGNITO_USER_POOL_ID=${POOL_ID},COGNITO_CLIENT_ID=${CLIENT_ID},ALLOWED_ORIGINS=${ALLOWED},RL_MAX=${RL_MAX},RL_WINDOW_SEC=${RL_WIN}}" \
    --output text >/dev/null
  echo "Variables actualizadas."
else
  aws lambda create-function --function-name "$FUNC" --region "$REGION" \
    --runtime nodejs20.x --role "$ROLE_ARN" --handler index.handler \
    --zip-file "fileb://$DIR/drex-payments.zip" --timeout 30 --memory-size 256 \
    --environment "Variables={DREX_TABLE=${TABLE},STRIPE_SECRET_KEY=${STRIPE_SK},STRIPE_WEBHOOK_SECRET=${STRIPE_WS},COGNITO_USER_POOL_ID=${POOL_ID},COGNITO_CLIENT_ID=${CLIENT_ID},ALLOWED_ORIGINS=${ALLOWED},RL_MAX=${RL_MAX},RL_WINDOW_SEC=${RL_WIN}}" \
    --output text >/dev/null
  echo "Función creada."
fi

echo "== 5/5 Function URL (Auth NONE; Stripe debe poder llamarla) =="
URL_CFG=$(aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" 2>/dev/null || true)
if [ -z "$URL_CFG" ]; then
  aws lambda create-function-url-config --function-name "$FUNC" --region "$REGION" \
    --auth-type NONE \
    --cors '{"AllowOrigins":["'"$(echo "$ALLOWED" | sed 's/,/","/g')"'"],"AllowMethods":["GET","POST","OPTIONS"],"AllowHeaders":["content-type","stripe-signature"],"MaxAge":86400}' \
    --output text >/dev/null
  echo "Function URL creada."
fi
FUNC_URL=$(aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" --query FunctionUrl --output text)

echo ""
echo "DESPLIEGUE COMPLETO."
echo "Function URL: $FUNC_URL"
echo "Smoke test: curl ${FUNC_URL}health"
echo ""
echo "SIGUIENTE: registra en Stripe (Developers > Webhooks) el endpoint"
echo "  ${FUNC_URL}webhook"
echo "con el evento checkout.session.completed, y pon su signing secret"
echo "(whsec_...) como STRIPE_WEBHOOK_SECRET (re-ejecuta este script)."
echo "Luego activa DREX_PAYMENTS_ENDPOINT en index.html con la Function URL."
