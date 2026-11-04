# drex-link-preview

Lambda (Node 20, sin dependencias, sin APIs de pago) que devuelve metadatos Open Graph de una URL para las **tarjetas de enlace del chat**. El navegador no puede leer el HTML de otros sitios por CORS, por eso hace falta este paso en servidor.

```
GET <function-url>?url=https://ejemplo.com/articulo
-> {"url","host","title","description","image","siteName"}
```

## Despliegue (no hecho en este PR)
1. Crear la función Node 20 con `index.js` + `package.json` (`"type":"module"`), handler `index.handler`, timeout 8 s, memoria 128 MB.
2. Function URL con auth `NONE`. Recomendado: *reserved concurrency* (p. ej. 5–10) como freno de costes/abuso y `ALLOWED_ORIGINS` con el origen de la app.
3. En `index.html` fijar `window.DREX_LINK_PREVIEW_URL="https://<id>.lambda-url.us-east-1.on.aws/"`.

Sin esa URL la app muestra la tarjeta de dominio (sin red).

## Seguridad
Solo http/https en 80/443, sin credenciales; rechaza IPs privadas/loopback/link-local/metadata (IPv4/IPv6) y conecta a la IP ya validada (anti DNS-rebinding); máx. 3 redirecciones validadas; solo `text/html`, 600 KB, 4 s; la imagen solo si es https. Respuestas con `Cache-Control: public, max-age=86400` (se puede poner CloudFront delante para cachear).

Tests: `npm test`.
