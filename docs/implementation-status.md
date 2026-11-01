# Estado de implementación

**Baseline de producto (1-nov-2026):** están implementadas las capacidades principales de la shell local, finanzas, movimientos, presupuestos, informes, planificación, centro de inteligencia, IA local opcional, MCP de solo lectura y operación del runtime. Este inventario describe código disponible; no convierte automáticamente los criterios de aceptación operativa en aceptados. La validación automatizada, la aceptación local real y la disponibilidad de recuperación se registran por separado.

## Consolidación — fase 1

| Issue | Estado verificable | Bloqueo / siguiente criterio |
|---|---|---|
| #64 · Backup unificado | **Cerrada e integrada** mediante PR #89 (d2c9911): backup cifrado/versionado, manifiesto, Actual + seis almacenes JSON propios y roundtrip sintético completo | Mantener la whitelist y el ensayo actualizados cuando se añadan almacenes persistentes. La aceptación manual de la instalación WSL2 sigue separada en #31 |
| #72 · Revisión financiera periódica | **Cerrada e integrada** mediante PR #82 (commit `32caf07`): revisión semanal/mensual, decisiones metadata-only, identidad estable entre periodos, huellas de evidencia y compatibilidad v1 | Seis checks verdes en el SHA final: quality/cobertura, Windows, E2E, Actual smoke, Actual update/restore y Security; `periodic-reviews.json` está incluido en el backup unificado de #64 |
| #31 · Aceptación operativa | Runtime diario, diagnóstico y pruebas automatizadas del ciclo de vida implementados; la dependencia de recuperación #64 está satisfecha | Sigue pendiente ejecutar y registrar la aceptación manual en Windows + WSL2 con presupuesto sintético. CI Linux/Windows nativa no demuestra esa instalación |
| #28 · Paginación eficiente de movimientos | **Cerrada el 1-nov-2026** con evidencia registrada en la issue: segmentación por mes natural, límite de 100.000 movimientos presentados, selección acotada offset+limit con desempate por ID, benchmark con pico de heap muestreado durante la petición (PR #63 integrada) y recorrido completo de páginas sin omisiones ni duplicados | Evaluación de ActualQL, consistencia entre páginas y benchmark de mes denso/multi-cuenta documentados en docs/transactions-and-imports.md |

## Centro de inteligencia financiera (issue #68)

La implementación añade hallazgos versionados y verificables, comparaciones de igual duración, límites explícitos por divisa/ámbito, prioridades explicadas, revisiones persistentes, filtros de fechas/tipo, evidencia, métricas locales de utilidad y explicación cualitativa opcional con IA local. La aceptación de cada cambio depende de que CI y E2E confirmen los criterios en la rama; no se afirma una prueba manual de Windows + WSL2 por estos cambios.

## Aceptación P3 (25-oct-2026)

- Detección de pagos recurrentes con señales deterministas en finance-core (recurring.ts): beneficiario, frecuencia, importe y fechas; candidatos explicados con avisos de falsos positivos.
- Sugerencias de categoría por reglas sobre el historial local (category-suggestions.ts), sin aprendizaje implícito; confirmación con previsualización vía POST /api/v1/insights/categorize.
- Previsiones explicables (forecast.ts): escenarios por categoría o cambio de ingreso, mediana como base, separación recurrente/extraordinario, supuestos y avisos.
- UI de planificación: candidatos, sugerencias con editar/aplicar/descartar y simulación.
- Objetivos de ahorro y compromisos futuros: API/core/UI y pruebas sintéticas en la rama correspondiente; verificar PR y criterios de aceptación antes de considerar cerrada su ampliación.
- #65 · Endurecer contratos financieros independientes del proveedor: abierta (P3, preventiva). Auditoría de dependencias del SDK fuera del adaptador, contratos de dominio y suite de conformidad reutilizable pendientes; no bloquea #31 ni #28.

## Matriz de operación y recuperación

| Área | Estado comprobable | Qué falta para cierre definitivo |
|---|---|---|
| Actual Compose | Imagen fijada, volumen persistente y puerto loopback; CI arranca el contenedor | Aceptación manual con presupuesto sintético en el entorno Windows + WSL2 objetivo |
| Adaptador oficial | Implementado sobre @actual-app/api, serialización de operaciones y pruebas automatizadas; CI de aceptación sintética existente | Conservar el registro de aceptación del entorno instalado si se usa como gate manual |
| Shell financiera | Dashboard, movimientos, importación CSV/OFX, presupuestos e informes | Repetir arranque y acceso desde navegador Windows dentro de la aceptación #31 |
| Backup/restore | Backup unificado cifrado AES-GCM con manifiesto v1, Actual + seis almacenes inventariados; roundtrip sintético integrado en CI mediante PR #89 | Mantener los nuevos almacenes en whitelist/tests. Antes de depender de un backup personal, realizar un ensayo aislado con clave conservada por separado |
| Ollama/chat | Opt-in, loopback, timeouts y contexto agregado; pruebas sintéticas/live opcionales | Validar en la máquina de uso cualquier modelo o endpoint configurado |
| MCP | JSON-RPC sobre stdio, allowlist solo lectura, argumentos estrictos y tests sintéticos | Prueba opcional con un cliente de escritorio concreto |
| Seguridad y CI | Lint, typecheck, build, tests, auditoría de dependencias, escaneo de secretos y CI Windows nativa | Los escaneos y runners no prueban ausencia total de vulnerabilidades ni sustituyen la aceptación manual WSL2 |
| Windows + WSL2 (#31) | CI Windows nativa y smoke Linux automatizado | Pendiente ejecutar y registrar la matriz manual completa de la instalación objetivo |

## Evidencia y límites de #31

La CI disponible ha cubierto dos ciclos de inicio/parada del runtime sintético, señales SIGINT/SIGTERM, liberación de puertos locales, limpieza del frontend si la API no arranca, pruebas de navegador, contenedor Actual aislado y aceptación de actualización/restauración sintética. Esto es evidencia automatizada reproducible, no evidencia de que la máquina del usuario haya ejecutado Windows + WSL2, ni de que el presupuesto local del usuario sobreviva a un reinicio.

Para cerrar #31 falta registrar, en un checkout limpio de la distribución WSL2 usada:

1. Versiones de Windows, distribución y versión WSL2, Node/npm, Docker Desktop/Engine, Compose y Actual.
2. npm ci, npm run doctor, npm run start:local, acceso a la UI desde navegador Windows y estado correcto de API/Actual.
3. Una prueba con un presupuesto exclusivamente sintético: inventario antes, reinicio de Actual/WSL2, inventario después y comparación de cuentas, categorías, movimientos, IDs, fechas e importes.
4. Un error intencional no destructivo y su diagnóstico, parada con Ctrl+C, nuevo arranque y comprobación de que no quedan procesos/puertos huérfanos.
5. Comandos ejecutados, resultado y logs saneados sin credenciales ni información financiera personal.

### Ensayo ejecutado el 1-nov-2026 en la distribución objetivo (WSL2)

Ejecutado directamente en la distribución Ubuntu 24.04.5 del entorno Windows + WSL2 del usuario, en un checkout limpio de `main` (`660a878`) y con un contenedor Actual **aislado** (volumen `pb31-acceptance-actual-data`, loopback `127.0.0.1:5008`, bootstrap con password de aceptación) para no tocar la instancia real del usuario.

| Punto | Resultado |
|---|---|
| Versiones | Windows 11 Home 10.0.26300 build 26300 · WSL 2.7.14.0 · kernel 6.18.33.2-microsoft-standard-WSL2 · Ubuntu 24.04.5 · Node v24.22.1 (nvm, `.nvmrc`) · npm 11.19.1 · Docker 29.9.2 · Compose v5.6.1 · `actualbudget/actual-server:26.10.0` |
| Instalación limpia | `npm ci` correcto; `npm run doctor` → **0 errores**, 3 avisos explicados (Actual arrancado fuera de compose por aislamiento; API/frontend apagados antes del arranque) |
| Presupuesto sintético | Sembrado con `scripts/actual-update-acceptance.ts seed`: 1 cuenta, 2 categorías, 3 movimientos; fixture de inventario (Sync ID, IDs, fechas, importes) |
| Persistencia tras reinicio | `docker restart` del contenedor Actual → `verify` → `SYNTHETIC_INVENTORY_OK`: cuenta, categorías, IDs/fechas/importes y saldo derivado idénticos |
| Arranque diario | `npm run start:local` → API 127.0.0.1:3000 y frontend 127.0.0.1:4173; `/health` 200, `/ready` configured, UI 200; `/api/v1/accounts` y `/api/v1/transactions` devuelven exactamente el inventario sintético |
| Error intencional no destructivo | Contenedor aislado detenido → API 502 `UPSTREAM_FAILURE` saneado sin detalles internos; `doctor` avisa «Servidor Actual: no responde»; tras `docker start` la API vuelve a 200 con los mismos 3 movimientos |
| Parada limpia | SIGINT → puertos 3000/4173 liberados, sin procesos huérfanos, SDK cerrado con gracia; segundo arranque limpio verificado (health/UI 200) |

Quedan dos pasos estrictamente manuales, no ejecutables desde dentro del propio WSL2:

1. **Confirmación visual** del navegador de Windows en http://127.0.0.1:4173 (el ensayo abrió el navegador y verificó el HTTP por loopback; la persona confirma la interfaz).
2. **Reinicio completo de WSL2** (`wsl --shutdown` y reapertura de la distribución) repitiendo el inventario antes/después; el reinicio del motor de persistencia de Actual ya quedó cubierto con el `docker restart` del punto anterior.

No cerrar #31 por un workflow verde. No registrar ni subir extractos, bases de datos, copias de seguridad o logs con datos personales a Git/CI.


## Inteligencia financiera útil — fase 2 (integrada en `main`)

**Estado de integración:** las funcionalidades de #73, #83 y #74 están integradas en `main` mediante el commit `9164741` (1-nov-2026) y la CI de Linux y Windows pasó sus criterios.

| Issue | Implementación integrada | Nota de límites |
|---|---|---|
| #73 · Saldo estimado y flujo de caja | Motor diario determinista, horizontes 7/30/90, movimientos futuros de Actual, compromisos activos, reserva de ámbito, detección conservadora de duplicados y escenario efímero. Los estados de conciliación de movimientos se muestran solo cuando Actual los proporciona. | La semántica de `balance_current` sigue siendo saldo actual de Actual, no saldo bancario disponible. |
| #83 · Propuestas de mejora | Línea base de periodos completos, clasificación de categorías elegida por el usuario, propuestas solo para flexibles/revisables, simulación combinada y decisiones/escenarios locales. | La primera versión no usa IA para crear propuestas ni aplica cambios a presupuestos. |
| #74 · Alertas presupuestarias | Reglas por categoría para consumo/restante/exceso, deduplicación por regla-categoría-mes, silencio/aplazamiento y funcionamiento sin IA. | Solo avisos in-app. |

El nuevo almacén `financial-actions.json` se añadió a la whitelist del backup unificado. Su presencia debe mantenerse sincronizada entre el esquema versionado, pruebas de roundtrip, `docs/backup-restore.md` y `scripts/backup-restore.ts`.
