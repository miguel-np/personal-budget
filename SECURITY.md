# Política de seguridad

## Alcance y límites de la evidencia

Esta política define requisitos de diseño y operación. **No certifica que una versión esté libre de vulnerabilidades.** El carácter local-first reduce ciertas exposiciones, pero no protege frente a malware local, acceso al sistema operativo, dependencias comprometidas, pérdida de backups o errores de configuración.

## Evidencia automatizada de referencia

**Ejecución auditada:** 15-nov-2026, commit [`98bdbb270101116f1fb5fe032101e78558c63035`](https://github.com/miguel-np/personal-budget/commit/98bdbb270101116f1fb5fe032101e78558c63035), antes de esta intervención documental.

- [CI, run 43718412265](https://github.com/miguel-np/personal-budget/actions/runs/43718412265): `quality`, `browser-e2e`, `actual-container-smoke`, `windows-quality` y `actual-update-acceptance` completados correctamente.
- [Security, run 43718412220](https://github.com/miguel-np/personal-budget/actions/runs/43718412220): `dependency-and-secret-scan` completado correctamente.
- `npm audit --audit-level=moderate`: 0 vulnerabilidades conocidas reportadas por la base de avisos consultada en esa ejecución.
- `npm audit --omit=dev --audit-level=moderate`: 0 vulnerabilidades conocidas reportadas para dependencias de producción en esa ejecución.
- Gitleaks: el escaneo de los cambios incluidos en el commit de referencia no encontró secretos. El workflow analiza el rango entrante; no equivale a auditar de nuevo todo el historial Git.
- Cobertura Vitest V8 reportada en el job `quality`:

| Métrica | Resultado observado | Umbral configurado |
|---|---:|---:|
| Statements | 86,59 % | 80 % |
| Branches | 76,67 % | 75 % |
| Functions | 90,50 % | 80 % |
| Lines | 90,73 % | 80 % |

Los umbrales están definidos en `vitest.config.ts`; el alcance de instrumentación incluye `packages/finance-core/src`, `services/actual-adapter/src` y `services/api/src`, excluyendo los entrypoints `index.ts` y `main.ts`. La cobertura mide ejecución de código, no probabilidad de ausencia de vulnerabilidades ni suficiencia de pruebas de seguridad.

Estas métricas describen una ejecución y un SHA concretos. No se deben copiar como métricas actuales de otro commit: consulta el workflow correspondiente al HEAD que se vaya a integrar.

## Revisiones manuales y aceptación

La documentación previa registra verificaciones manuales del entorno objetivo WSL2: binding de servicios a `127.0.0.1`, rechazo CORS de orígenes no permitidos, saneamiento de errores y exclusión de prompts/detalles de movimientos de logs. Es evidencia de esa sesión, no una comprobación repetida por cada CI.

Las pruebas sintéticas de prompt injection, herramientas MCP desconocidas, confirmación de escrituras y aislamiento de datos son controles de regresión. No sustituyen pruebas de penetración, revisión independiente ni aceptación manual de una instalación concreta.

## Informar una vulnerabilidad

No publiques detalles explotables, extractos financieros, archivos de presupuesto ni credenciales en issues públicas. Utiliza la función de comunicación privada de vulnerabilidades de GitHub si está habilitada. En otro caso, acuerda un canal privado con el propietario antes de compartir detalles.

## Requisitos de seguridad

- Mantener la aplicación accesible solo desde `localhost` por defecto.
- No publicar los puertos de Actual Budget, Ollama, backend o MCP en interfaces de red externas.
- No exponer herramientas para ejecutar shell, SQL arbitrario, código o rutas de archivo controladas por el modelo.
- Utilizar una lista permitida explícita de herramientas MCP.
- Validar y limitar entradas, fechas, importes, tamaño de archivos, número de resultados y duración de peticiones.
- Tratar CSV, OFX, QIF, QFX y CAMT como datos no confiables; validar estructura, codificación, tamaño y campos antes de procesarlos.
- Mantener secretos en archivos locales excluidos de Git. No incluir contraseñas bancarias.
- Enmascarar secretos en logs y errores. Evitar registrar descripciones y contenido íntegro de transacciones.
- Mantener dependencias actualizadas y ejecutar auditorías antes de integrar o publicar cambios.
- Respaldar los datos y probar la restauración. Las copias contienen información financiera sensible.
- Mantener los permisos de CI en mínimo privilegio y fijar las Actions de terceros a SHA completo.

## Modelo de amenazas mínimo

Las amenazas incluyen acceso desde otro dispositivo en la red, malware local, extensión de navegador maliciosa, dependencia comprometida, prompt injection en descripciones de movimientos, acceso excesivo del modelo a herramientas, pérdida o robo de copias y errores de importación que dupliquen movimientos.

El carácter local no protege frente a alguien que ya tenga acceso a la cuenta de Windows/WSL o a archivos sin cifrar. Utiliza cifrado de disco, una cuenta del sistema protegida y copias cifradas.
