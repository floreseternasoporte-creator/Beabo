#!/usr/bin/env bash
set -euo pipefail

# Uso:
#   ./setup_aws.sh <AWS_ACCESS_KEY_ID> <AWS_SECRET_ACCESS_KEY> [AWS_BUCKET] [AWS_REGION]
# Ejemplo:
#   ./setup_aws.sh AKIA... abcd... drexmmm us-east-2

ACCESS_KEY_ID="${1:-}"
SECRET_ACCESS_KEY="${2:-}"
BUCKET="${3:-drexmmm}"
REGION="${4:-us-east-2}"

if [[ -z "$ACCESS_KEY_ID" || -z "$SECRET_ACCESS_KEY" ]]; then
  echo "Uso: ./setup_aws.sh <AWS_ACCESS_KEY_ID> <AWS_SECRET_ACCESS_KEY> [AWS_BUCKET] [AWS_REGION]" >&2
  exit 1
fi

if ! command -v wrangler >/dev/null 2>&1; then
  echo "Error: wrangler no está instalado en este entorno." >&2
  echo "Instálalo con: npm i -g wrangler" >&2
  exit 1
fi

# Configura vars no sensibles en wrangler.toml
if [[ -f wrangler.toml ]]; then
  python - <<PY
from pathlib import Path
p = Path('wrangler.toml')
text = p.read_text()
lines = text.splitlines()

# Ensure [vars] exists
if '[vars]' not in text:
    lines.append('')
    lines.append('[vars]')

# normalize simple replacement/add for AWS_REGION/AWS_BUCKET
content = '\n'.join(lines) + '\n'
import re

def upsert(key, value, s):
    pat = re.compile(rf'^{key}\s*=\s*".*"\s*$', re.MULTILINE)
    repl = f'{key} = "{value}"'
    if pat.search(s):
        return pat.sub(repl, s)
    idx = s.find('[vars]')
    if idx == -1:
        return s + f'\n[vars]\n{repl}\n'
    insert_at = s.find('\n', idx)
    return s[:insert_at+1] + repl + '\n' + s[insert_at+1:]

content = upsert('AWS_REGION', '${REGION}', content)
content = upsert('AWS_BUCKET', '${BUCKET}', content)
p.write_text(content)
PY
fi

echo -n "$ACCESS_KEY_ID" | wrangler secret put AWS_ACCESS_KEY_ID

echo -n "$SECRET_ACCESS_KEY" | wrangler secret put AWS_SECRET_ACCESS_KEY

echo "✅ Secrets cargados correctamente en Cloudflare Pages/Workers."
echo "✅ Bucket: $BUCKET"
echo "✅ Región: $REGION"
