# Estado de implementación

**Estado: base técnica P0 añadida; CI y la integración real siguen pendientes de verificación.**

| Área | Estado | Criterio para considerarla completada |
|---|---|---|
| Workspace TypeScript y scripts | Implementado | Lockfile reproducible e instalación limpia validada |
| Núcleo financiero | Implementado con pruebas unitarias | Cobertura alcanzada y reglas contrastadas con datos sintéticos |
| Adaptador @actual-app/api | Implementado con interfaz inyectable y pruebas simuladas; aceptación live opcional añadida | Ejecutar aceptación live contra un presupuesto local de prueba; CI valida el contenedor, no un presupuesto autenticado |
| API Fastify | Implementada con pruebas de rutas | CI, seguridad y prueba end-to-end validadas |
| Compose de Actual Budget | Configurado con versión fijada y bind a localhost | Arranque y persistencia probados en WSL2 |
| Shell React/Vite | Provisional | Dashboard y secciones de usuario en P1 |
| Registro manual de movimientos | Pendiente | Issue #9 |
| Dashboard e informes completos | Pendiente | Issue #10 |
| Importación desde interfaz | Pendiente | Issue #11; Actual UI sirve de momento para importar manualmente |
| Presupuestos por categoría | Pendiente | Issue #12 |
| Ollama y chat | Pendiente | Issues #13 y #15 |
| MCP | Pendiente | Issue #14 |
| Copia/restauración verificada | Documentada, no ensayada | Issue #17 |
| Instalación limpia en WSL2 | No ensayada | Issue #18 |

No considerar una función completa solo porque exista código. El cierre requiere pruebas verdes, cobertura adecuada e integración apropiada. La cobertura objetivo está configurada en Vitest; CI debe confirmar que se alcanza.
