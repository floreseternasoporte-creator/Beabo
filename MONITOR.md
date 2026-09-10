# Monitor automático

Cada 4 horas un monitor revisa este código, corrige bugs reales, valida
(sintaxis JS, handlers huérfanos, IDs inexistentes, YAML de AWS) y sube los
arreglos a `main` con el prefijo `Monitor:` en el mensaje.

No cambia colores, logo, identidad ni textos visibles sin necesidad.
