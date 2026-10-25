# Estado de implementación

**Estado: implementación de la base P0 con CI verde; la integración live contra un presupuesto de Actual sigue pendiente.**

| Área | Estado | Criterio para considerarla completada |
|---|---|---|
| Workspace TypeScript y scripts | Implementado; CI verde | Lockfile reproducible, instalación limpia, lint, typecheck, build y auditoría validados |
| Núcleo financiero | Implementado con pruebas unitarias; 40 tests del conjunto pasan | Cobertura global CI: 94,5 % statements, 86,02 % branches, 94,64 % functions, 96,1 % lines |
| Adaptador @actual-app/api | Implementado con interfaz inyectable y pruebas simuladas; aceptación live opcional añadida | Ejecutar aceptación live contra un presupuesto local de prueba; CI valida el contenedor, no un presupuesto autenticado |
| API Fastify | Implementada con pruebas de rutas; CI verde | Configuración loopback, control Origin, límites, errores saneados, typecheck y pruebas pasan |
| Compose de Actual Budget | Configurado; smoke test en CI verde | Arranque en localhost validado en runner Linux; falta verificar persistencia de un presupuesto real en Windows + WSL2 |
| Shell React/Vite | Provisional | Dashboard y secciones de usuario en P1 |
| Registro manual de movimientos | Pendiente | Issue #9 |
| Dashboard e informes completos | Pendiente | Issue #10 |
| Importación desde interfaz | Pendiente | Issue #11; Actual UI sirve de momento para importar manualmente |
| Presupuestos por categoría | Pendiente | Issue #12 |
| Ollama y chat | Pendiente | Issues #13 y #15 |
| MCP | Pendiente | Issue #14 |
| Copia/restauración verificada | Documentada, no ensayada | Issue #17 |
| Instalación limpia en WSL2 | No ensayada | Issue #18 |

No considerar una función completa solo porque exista código. El cierre requiere pruebas verdes, cobertura adecuada e integración apropiada. La cobertura objetivo está configurada en Vitest y la CI verde confirma que se alcanza. La ausencia de hallazgos de auditoría es temporal y no garantiza que nunca existan vulnerabilidades.
