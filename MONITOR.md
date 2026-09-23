# Monitoreo del repositorio

Este repo se vigila de dos formas (ninguna modifica el código por sí sola):

1. **CI en cada push/PR a `main`** (`.github/workflows/validate.yml`):
   sintaxis JS de `drex-cloud.js`, `server.js`, `sw.js` y de los bloques
   `<script>` inline de `index.html`; detecta handlers inline huérfanos,
   referencias a IDs inexistentes, restos de UI (`TODO`, `lorem`) y
   controla el peso de la página.

2. **Monitor local**: revisa `main` en el remoto, valida la sintaxis JS de
   los archivos clave y avisa si algo falla o cambia. Solo observa y
   alerta; no corrige ni sube cambios automáticamente.

Los arreglos los hace el equipo de ingeniería con commits pequeños y
verificados (ver `~/workspace/goals/monitoreo-del-repositorio-beabo/hidden_files/engineering-team-log.md`).

No se cambian colores, logo, identidad ni textos visibles sin necesidad.
