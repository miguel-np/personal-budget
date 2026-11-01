# Plan de aceptación de P2

Esta guía separa lo que ejecuta la CI reproducible de las comprobaciones que requieren un runtime local. Ninguna prueba usa un presupuesto real.

## 1. CI reproducible

En una rama limpia, la validación estándar es:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
```

El workflow de GitHub añade un smoke test del contenedor Actual y un escaneo de secretos. La CI no descarga modelos de IA ni exige servicios remotos. Un smoke test del contenedor no verifica por sí solo la autenticación/sincronización del adaptador ni que una restauración recupere las cuentas.

## 2. Aceptación de Ollama con datos sintéticos

El test live es opt-in, para que la suite normal no dependa de un modelo, GPU ni Internet. En WSL2, arranca Ollama y selecciona un modelo que ya aparezca en `ollama list`. Después, desde la raíz del repositorio:

```bash
export PERSONAL_BUDGET_RUN_OLLAMA_ACCEPTANCE=1
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL='<nombre-exacto-de-ollama-list>'
npm run test:ollama:acceptance
```

El test usa únicamente categorías e importes inventados. Comprueba disponibilidad del modelo, una generación real y que la narración se devuelve sin cifras ni enlaces. No activa la IA en la aplicación ni envía datos financieros personales. No se debe marcar la aceptación live como completada hasta guardar el resultado del test y el nombre/versión del modelo probado.

## 3. Aceptación de MCP

La suite `services/mcp/tests/protocol.test.ts` lanza el servidor como subproceso y lo comunica mediante stdin/stdout con un cliente de prueba y una API sintética. Incluye inicialización, herramientas read-only, llamada válida, herramienta desconocida, argumentos inválidos, respuesta demasiado grande, timeout y rechazo de endpoints no loopback.

Para probarlo con un cliente de escritorio, configura el comando `node` apuntando a `services/mcp/server.mjs` en el checkout local. Define `PERSONAL_BUDGET_API_URL=http://127.0.0.1:3000`; no uses un endpoint público ni abras un listener de red para MCP. El timeout puede ajustarse entre 100 y 30000 ms mediante `PERSONAL_BUDGET_MCP_API_TIMEOUT_MS` (5000 ms por defecto). La prueba con un cliente de escritorio concreto sigue siendo manual.

## 4. Aceptación de backup y restore

Los tests unitarios cubren checksum, retención, rutas, tipos de archivo, formato versionado y whitelist del estado de aplicación. El backup genera un paquete cifrado autenticado AES-256-GCM con SHA-256 y manifiesto. El ensayo integral de CI restaura el volumen de Actual y los almacenes de Personal Budget usando datos sintéticos.

Para una aceptación manual adicional, prepara un checkout desechable y una instancia de Actual aislada, con volumen y puerto loopback propios y presupuesto sintético. Configura `COMPOSE_FILE`, `ACTUAL_SERVER_DATA_DIR`, `ACTUAL_DATA_DIR`, `BACKUP_DIR` y `BACKUP_ENCRYPTION_KEY_FILE` para rutas exclusivas de prueba. Detén la API local antes de crear/restaurar la copia. No ejecutes la prueba de roundtrip ni la restauración manual sobre tu único presupuesto personal.

1. Arranca la instancia aislada y anota el inventario de prueba.
2. Ejecuta `npm run backup:actual` y confirma que se crea el archivo y su `.sha256` con permisos restringidos.
3. Ejecuta `npm run restore:actual -- <ruta-de-la-copia>`.
4. Comprueba la UI de Actual y compara cuentas, categorías, movimientos y saldos con el inventario.
5. Registra resultado, versión de Actual, fecha y entorno de prueba. Conserva la copia previa hasta verificar todo el inventario.

El checksum demuestra integridad respecto al sidecar, no autenticidad ni cifrado. Cualquier copia fuera del dispositivo debe cifrarse con una clave almacenada por separado.

## 5. Condiciones de cierre de las issues

- **#13:** CI verde y prueba live Ollama completada con modelo local identificado. ✅ Registrado: `qwen3:8b` vía Ollama loopback (mirrored networking WSL2), aceptación live y tool calling estructurado verificados el 25-oct-2026.
- **#14:** suite de protocolo verde y cliente MCP de escritorio elegido validado. ✅ Suite de protocolo + interop con el cliente oficial del SDK MCP (`@modelcontextprotocol/sdk`) contra la API real; la comprobación con un cliente de escritorio concreto queda como verificación opcional adicional del usuario.
- **#15:** chat contrastado contra resultados calculados; inyecciones de prompt probadas. La IA no puede escribir movimientos. Cualquier futuro flujo de escritura requiere propuesta revisable y confirmación explícita en código. ✅ Resumen, categorías y comparativa verificados end-to-end con datos sintéticos; inyección de escritura rechazada; cifras separadas de la narración en UI y API.
- **#16:** CI/escaneo verdes y flujo integrado contrastado contra un presupuesto sintético; documentar límites de los escaneos. ✅ Flujo completo (import con previsualización y commit, dashboard, comparativas de periodos) contra el presupuesto sintético; CORS, loopback y logs saneados verificados; límites de escaneos documentados en SECURITY.md.
- **#17:** backup y restore ejecutados en una instancia aislada; inventario antes/después idéntico. ✅ Ensayo registrado en docs/backup-restore.md: RESTORE_OK con inventario idéntico tras destruir datos y contenedor.
- **#28:** paginación eficiente de movimientos con ventanas mensuales, límite de 100.000 presentados, selección acotada y desempate por ID. ✅ Benchmark reproducible en `services/api/tests/app.test.ts` con datasets repartido/mes denso/multi-cuenta, pico de heap muestreado durante la petición (PR #63, integrada), techos de regresión fijos (mediana < 3 s, heap < 128 MiB) y recorrido completo de páginas sin omisiones ni duplicados con fechas/importes idénticos, splits y filtros. Evaluación de ActualQL y efectos de cambios concurrentes registrados en docs/transactions-and-imports.md.

No cerrar una issue solo por tener pruebas unitarias o un workflow verde si su criterio exige una prueba live o manual. La aceptación sintética de #64 en CI no completa #31: Windows nativo y una distribución WSL2 son entornos diferentes; el último necesita una ejecución manual documentada.
