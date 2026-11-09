#!/usr/bin/env bash
# SOLO LECTURA: muestra cómo está configurado el User Pool antes/después de activar el código por correo.
# No cambia nada. Requiere AWS CLI v2 con permisos de lectura de Cognito (en tu PC o en CloudShell).
# Uso:  bash comprobar-pool.sh
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
POOL="${POOL_ID:-us-east-1_kDSYEBsnY}"
CLIENT="${CLIENT_ID:-7cm12q14tm12u8b3bnn6ksjqni}"

echo "== Plan de Cognito, MFA, correo y seguimiento de dispositivos =="
aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL" \
  --query 'UserPool.{Plan:UserPoolTier,MFA:MfaConfiguration,Correo:EmailConfiguration,Dispositivos:DeviceConfiguration}' --output json

echo; echo "== Métodos de MFA permitidos (TOTP / correo) =="
aws cognito-idp get-user-pool-mfa-config --region "$REGION" --user-pool-id "$POOL" --output json

echo; echo "== App client: flujos permitidos y duración de la sesión del código =="
aws cognito-idp describe-user-pool-client --region "$REGION" --user-pool-id "$POOL" --client-id "$CLIENT" \
  --query 'UserPoolClient.{Flujos:ExplicitAuthFlows,MinutosDeSesion:AuthSessionValidity}' --output json

echo; echo "== Estado de SES (modo de pruebas / producción) =="
aws sesv2 get-account --region "$REGION" --query '{EnvioHabilitado:SendingEnabled,ProduccionAprobada:ProductionAccessEnabled,Cuota24h:SendQuota.Max24HourSend}' --output json

echo; echo "Esperado al terminar la activación:"
echo "  Plan = ESSENTIALS (o PLUS) | MFA = ON | Correo.EmailSendingAccount = DEVELOPER"
echo "  Flujos incluye ALLOW_USER_SRP_AUTH | MinutosDeSesion >= 5 | ProduccionAprobada = true"
