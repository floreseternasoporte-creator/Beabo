# drex-id-verification — dependencias

El runtime Python 3.12 de AWS Lambda ya incluye `boto3`/`botocore`.
El código solo usa la stdlib además de boto3, así que el ZIP contiene
únicamente `lambda_function.py`. No hay que empaquetar nada más.

Despliegue: ver docs/IDV-DEPLOYMENT-CHECKLIST.md
