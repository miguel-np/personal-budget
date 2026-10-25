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

Los tests automatizados cubren checksum, retención, rutas y rechazo de enlaces y tipos especiales en los miembros del archivo. El script genera archivos con permisos `0600`, pero solo una restauración real puede verificar el contenido de Actual.

Antes de la prueba, prepara una instancia de Actual aislada, con volumen y puerto loopback propios, y crea en ella un presupuesto sintético cuyo inventario puedas anotar (cuentas, categorías, movimientos y saldos). Configura `COMPOSE_FILE` para que los comandos Docker del script usen ese Compose aislado, `ACTUAL_SERVER_DATA_DIR` para el directorio montado por ese Compose y `BACKUP_DIR` para una carpeta de pruebas. No ejecutes la prueba sobre tu único presupuesto personal.

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

No cerrar una issue solo por tener pruebas unitarias o un workflow verde si su criterio exige una prueba live o manual.
