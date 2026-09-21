#!/usr/bin/env bash
# Empaqueta drex-data-export-lambda.zip de forma reproducible.
# Solo lambda_function.py (sin dependencias externas: boto3 viene en el runtime).
set -euo pipefail
cd "$(dirname "$0")"

echo "== py_compile =="
python3 -m py_compile lambda_function.py

echo "== tests =="
python3 tests/test_lambda.py

echo "== zip =="
rm -f drex-data-export-lambda.zip
zip -j -9 drex-data-export-lambda.zip lambda_function.py > /dev/null

echo "== verificación =="
python3 - <<'EOF'
import zipfile, hashlib
z = zipfile.ZipFile('drex-data-export-lambda.zip')
names = z.namelist()
assert names == ['lambda_function.py'], names
blob = z.read('lambda_function.py')
print('contenido :', names)
print('bytes     :', len(blob))
print('sha256    :', hashlib.sha256(blob).hexdigest())
print('ZIP OK')
EOF
