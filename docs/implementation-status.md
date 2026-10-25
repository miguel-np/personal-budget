# Estado de implementación

**Base P0/P1:** stack de Actual, adaptador oficial, API y shell financiera están implementados y validados en el entorno objetivo Windows + WSL2. La CI de main está verde. P2: validaciones live completadas el 25-oct-2026 (Ollama, MCP, chat, backup/restore y flujo E2E); pendiente de cierre la PR con los refuerzos de aceptación.

## Aceptación P0/P1 (25-oct-2026)

Ensayo completo desde un checkout limpio en el WSL2 objetivo (DESKTOP-VPKK7A9) con datos sintéticos:

- `docker compose up -d` con imagen fijada `actualbudget/actual-server:26.10.0`; puerto publicado solo en `127.0.0.1` (verificado con `docker inspect`); persistencia confirmada tras `restart` y `--force-recreate`.
- Presupuesto de prueba creado con la API oficial 26.10.0 y sincronizado al servidor local; la suite `actual-live-acceptance.test.ts` (solo lectura, opt-in) pasa contra ese presupuesto.
- Flujo completo verificado: API (cuentas, categorías, movimientos, resumen, import con previsualización y commit, presupuestos GET/PUT), shell web con proxy, MCP de solo lectura por stdio y backup con checksum.
- Dashboard renderizado desde el navegador de Windows con cifras coherentes con la API.
- Bloqueos de instalación limpia corregidos en PR #24: `OLLAMA_MODEL=` vacío impedía arrancar la API, el adaptador fallaba si `ACTUAL_DATA_DIR` no existía y se documentó el problema de permisos de `.local` propiedad de root.

| Área | Estado comprobable | Qué falta para cierre definitivo |
|---|---|---|
| Actual Compose | Imagen fijada, volumen persistente y puerto loopback; persistencia verificada tras recreate | Nada pendiente |
| Adaptador oficial | Implementado sobre @actual-app/api, operaciones serializadas, tests simulados y aceptación live contra un presupuesto sintético real | Nada pendiente |
| Shell financiera | Dashboard, movimientos, importación CSV, presupuestos e informes; ensayo manual WSL2 y render desde Windows | Nada pendiente |
| Backup/restore | Scripts CLI, parada del contenedor, archivo fechado, checksum, retención y restore con copia previa; **restore en instancia aislada verificado con inventario idéntico** (RESTORE_OK, 25-oct-2026) | Nada pendiente |
| Ollama/chat | Opt-in, endpoint loopback, status, timeout, contexto agregado y UI; cifras calculadas por backend; **aceptación live con qwen3:8b**: resumen, categorías, comparativa, tool calling estructurado e inyección rechazada | Nada pendiente |
| MCP | JSON-RPC sobre stdio, allowlist solo lectura, argumentos estrictos, límites y tests sintéticos; **interop validada con el cliente oficial del SDK MCP contra la API real** | Comprobación opcional con un cliente de escritorio concreto en el equipo del usuario |
| Seguridad y CI | Lint, typecheck, build, pruebas, auditoría de dependencias y escaneo de secretos en workflow; flujo E2E verificado (import, dashboard, comparativas), CORS y logs saneados | Los escaneos no prueban ausencia de vulnerabilidades |
| Windows + WSL2 | CI Windows nativa, smoke test de Actual Linux y ensayo manual WSL2 con dashboard operativo, permisos de `.local` corregidos, ciclo completo de parada/recuperación y Ollama de Windows en loopback vía mirrored networking | Nada pendiente |

No cerrar las issues de aceptación manual por tener un workflow verde. No usar extractos ni presupuestos reales como fixtures de CI.
