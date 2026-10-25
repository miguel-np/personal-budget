# Contribuir

`personal-budget` está orientado inicialmente a uso personal y local. Si se aceptan contribuciones externas, deben priorizar la privacidad, exactitud financiera, mantenibilidad y seguridad.

## Antes de empezar

- Lee [arquitectura](docs/architecture.md), [privacidad](docs/privacy.md), [seguridad](SECURITY.md) y [licencias](docs/licensing.md).
- Para cambios de arquitectura, abre primero una discusión o issue.
- No envíes datos financieros reales para reproducir errores. Usa movimientos sintéticos.
- No añadas servicios externos de analítica, telemetría o IA sin documentarlos y obtener una decisión explícita.

## Principios de ingeniería

- Los cálculos financieros deben tener pruebas deterministas y casos de borde.
- Los importes deben almacenarse y calcularse con precisión decimal o céntimos enteros, nunca con aritmética binaria de coma flotante sin controlar.
- Los traspasos entre cuentas propias no son gastos ni ingresos consolidados.
- No conviertas datos ausentes en cero silenciosamente.
- El modelo no puede generar SQL arbitrario, ejecutar comandos del sistema ni acceder libremente al filesystem.
- Todas las herramientas MCP deben validar entradas, limitar resultados y declarar si son de solo lectura o escritura.
- Las operaciones de escritura deben requerir confirmación en la interfaz.
- No registres descripciones completas de movimientos, mensajes privados, importes completos ni secretos en logs.
- Los cambios en el esquema o en formatos de importación deben incluir pruebas de migración y recuperación.

## Validación propuesta

Cuando exista el código y se hayan definido los scripts del proyecto, la guía de desarrollo especificará los comandos exactos. Como mínimo, cada cambio deberá ejecutar lint, comprobación de tipos, pruebas unitarias, pruebas de integración con servicios simulados y build de producción.

No hagas que la suite normal requiera un banco real, acceso a Internet, una API comercial ni un modelo alojado. Las pruebas de aceptación con Ollama pueden ser opcionales y usar datos sintéticos.

## Pull requests

Describe el problema, el diseño, los riesgos de privacidad, las migraciones y las pruebas realizadas. Actualiza la documentación afectada y `CHANGELOG.md`. No incluyas bases de datos reales, extractos, copias de seguridad, modelos descargados, ficheros `.env` ni credenciales.

Las contribuciones se proponen bajo la licencia del proyecto indicada en `LICENSE`, salvo acuerdo expreso distinto.
