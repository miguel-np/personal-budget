# Estado de implementación

**Roadmap completo (P0–P3, 25-oct-2026):** stack de Actual, adaptador oficial, API, shell financiera, IA local, MCP, recuperación y mejoras P3 (recurrentes, sugerencias y previsiones) implementados y validados en vivo en el entorno objetivo Windows + WSL2. CI de `main` verde en Linux y Windows.

## Centro de inteligencia financiera (issue #68)

La implementación añade hallazgos versionados y verificables, comparaciones de igual duración, límites explícitos por divisa/ámbito, prioridades explicadas, revisiones persistentes, filtros de fechas/tipo, evidencia, métricas locales de utilidad y explicación cualitativa opcional con IA local. El cierre depende de que CI y E2E confirmen los criterios en la rama; la documentación no afirma una prueba manual de Windows + WSL2 por estos cambios.

## Aceptación P3 (25-oct-2026)

- Detección de pagos recurrentes con señales deterministas en `finance-core` (`recurring.ts`): beneficiario, frecuencia, importe y fechas; candidatos explicados con avisos de falso positivo (reembolsos, fechas desplazadas, importes variables, nombres similares). Validado en vivo: candidato `supermercado` con cadencia mensual de 30 días.
- Sugerencias de categoría por reglas sobre el historial local (`category-suggestions.ts`), sin aprendizaje implícito; confirmación con previsualización vía `POST /api/v1/insights/categorize` (preview no escribe; commit actualiza Actual a través del adaptador). Validado en vivo sobre un movimiento sintético.
- Previsiones explicables (`forecast.ts`): escenarios de reducción por categoría o cambio de ingreso, mediana como base, separación recurrente/extraordinario, supuestos y avisos; determinismo bit a bit verificado en vivo.
- UI: sección Planificación en la shell (candidatos, sugerencias con editar/aplicar/descartar y simulación con tabla mensual).
- Ampliación de issue #37: objetivos de ahorro con progreso/proyección, compromisos manuales recurrentes, calendario/lista, CRUD local, guardas de divisa/ámbito y cálculo determinista en finance-core. La implementación y pruebas están en la rama de la PR; no se considera cerrada hasta que CI y revisión confirmen los criterios de aceptación.

| Área | Estado comprobable | Qué falta para cierre definitivo |
|---|---|---|
| Actual Compose | Imagen fijada, volumen persistente y puerto loopback; persistencia verificada tras recreate | Nada pendiente |
| Adaptador oficial | Implementado sobre @actual-app/api, operaciones serializadas, tests simulados y aceptación live contra un presupuesto sintético real | Nada pendiente |
| Shell financiera | Dashboard, movimientos, importación CSV, presupuestos e informes; ensayo manual WSL2 y render desde Windows | Nada pendiente |
| Backup/restore | Scripts CLI, parada del contenedor, archivo fechado, checksum, retención y restore con copia previa; restore en instancia aislada verificado con inventario idéntico | Nada pendiente |
| Ollama/chat | Opt-in, endpoint loopback, status, timeout, contexto agregado y UI; aceptación live con qwen3:8b, tool calling estructurado e inyección rechazada | Nada pendiente |
| MCP | JSON-RPC sobre stdio, allowlist solo lectura, argumentos estrictos, límites, tests sintéticos e interop con el SDK oficial contra la API real | Comprobación opcional con un cliente de escritorio concreto |
| P3 · Planificación | Recurrentes, sugerencias de categoría y previsiones; issue #37 amplía objetivos de ahorro y compromisos con API, core, UI y pruebas sintéticas en una PR separada | CI/revisión de la ampliación y aceptación de los criterios de issue #37 |
| Seguridad y CI | Lint, typecheck, build, pruebas (93.45% stmts / 81.87% branches), auditorías y escaneo de secretos; CORS, loopback y logs saneados | Los escaneos no prueban ausencia de vulnerabilidades |
| Windows + WSL2 | CI Windows nativa, ensayo manual WSL2 con dashboard operativo, ciclo de recuperación completo y Ollama de Windows en loopback vía mirrored networking | Nada pendiente |

No cerrar las issues de aceptación manual por tener un workflow verde. No usar extractos ni presupuestos reales como fixtures de CI.
