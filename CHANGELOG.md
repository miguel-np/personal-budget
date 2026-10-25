# Changelog

## Unreleased

- Añadido workspace npm/TypeScript con núcleo financiero, adaptador de Actual Budget, API local y shell web.
- Añadido núcleo financiero determinista con importes en unidades menores, validación de fechas, exclusión de transferencias y normalización de transacciones divididas.
- Añadido adaptador inyectable para la API oficial de Actual, operaciones serializadas y dry-run por defecto para importaciones.
- Añadida API Fastify local con validación de configuración, host loopback, controles de Origin, respuestas saneadas y endpoints de lectura.
- Añadida shell React/Vite que comprueba el estado del backend; el dashboard completo queda pendiente.
- Añadido Compose con versión fijada de Actual Budget y puerto limitado a localhost.
- Añadidas pruebas unitarias y de API, política de cobertura y CI para auditoría, lint, typecheck y build.
- Añadido smoke test de Docker para validar la configuración y el arranque del servidor Actual Budget 26.10.0 en localhost.
- CI verde: 40 pruebas aprobadas, 1 prueba live opcional omitida, cobertura global del 94,5 % de sentencias, 86,02 % de ramas y 96,1 % de líneas; `npm audit` y auditoría de dependencias de producción reportan cero vulnerabilidades conocidas.
- Añadido lockfile npm inicial por CI.
- Pendiente: validar resultados de CI, probar adaptador contra Actual local y completar funciones del producto en P1.
