# Configuración en GitHub (sin programar)

Haz esto una sola vez y luego todo se despliega desde GitHub automáticamente.

## 1) Subir el proyecto a GitHub
- Asegúrate de que este repo esté en tu GitHub.

## 2) En tu repo de GitHub abre: Settings → Secrets and variables → Actions

### En **Secrets** crea estos 4 secretos:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

### En **Variables** crea estas 2 variables:
- `AWS_BUCKET` = `drexmmm`
- `AWS_REGION` = `us-east-2`

## 3) Ejecutar deploy
- Ve a **Actions**
- Abre workflow: **Deploy Cloudflare (Community API)**
- Clic en **Run workflow**

Listo. Desde ahí se publica directo sin tocar código.

---

## Importante de seguridad
Como compartiste tu clave aquí en el chat, te recomiendo **rotarla** en AWS por seguridad.
