# Roadmap de implementación

Las capacidades base P0–P3 tienen una implementación amplia. En la consolidación de fase 1, la recuperación integral (#64) y la revisión financiera periódica (#72) ya están integradas; la aceptación operativa completa Windows + WSL2 (#31) requiere todavía una ejecución manual en la distribución objetivo. La CI Linux/Windows aporta evidencia automatizada, pero no sustituye esa prueba manual. El seguimiento accionable vive en [GitHub Issues](https://github.com/miguel-np/personal-budget/issues).

## Prioridades

- **P0 — Bloqueante:** bases técnicas, seguridad y cálculos financieros.
- **P1 — MVP sin IA:** registro/importación y consulta de gastos/ahorro desde una interfaz única.
- **P2 — IA local y fiabilidad:** Ollama, MCP, chat, recuperación y validación de seguridad.
- **P3 — Mejoras:** sugerencias de categoría, pagos recurrentes y previsiones.

## Fase 0 — Fundamentos (P0)

- [x] [#2 Workspace TypeScript, scripts y CI](https://github.com/miguel-np/personal-budget/issues/2)
- [x] [#3 Actual Budget local, persistencia y puertos seguros](https://github.com/miguel-np/personal-budget/issues/3)
- [x] [#4 Adaptador oficial @actual-app/api](https://github.com/miguel-np/personal-budget/issues/4)
- [x] [#5 Cálculos deterministas y pruebas](https://github.com/miguel-np/personal-budget/issues/5)
- [x] [#6 Backend local y frontera de seguridad](https://github.com/miguel-np/personal-budget/issues/6)

## Fase 1 — MVP sin IA (P1)

- [x] [#7 Shell web unificada](https://github.com/miguel-np/personal-budget/issues/7)
- [x] [#8 Lectura de cuentas, categorías y movimientos](https://github.com/miguel-np/personal-budget/issues/8)
- [x] [#9 Registro manual con confirmación](https://github.com/miguel-np/personal-budget/issues/9)
- [x] [#10 Dashboard diario, mensual y anual](https://github.com/miguel-np/personal-budget/issues/10)
- [x] [#11 Importación y conciliación](https://github.com/miguel-np/personal-budget/issues/11)
- [x] [#12 Presupuesto frente a gasto por categoría](https://github.com/miguel-np/personal-budget/issues/12)
- [x] [#18 Ensayo de instalación limpia en WSL2](https://github.com/miguel-np/personal-budget/issues/18)

## Fase 2 — IA local y fiabilidad (P2)

- [x] [#13 Ollama local](https://github.com/miguel-np/personal-budget/issues/13)
- [x] [#14 Herramientas MCP de solo lectura](https://github.com/miguel-np/personal-budget/issues/14)
- [x] [#15 Chat financiero integrado](https://github.com/miguel-np/personal-budget/issues/15)
- [x] [#16 Pruebas de seguridad y end-to-end](https://github.com/miguel-np/personal-budget/issues/16)
- [x] [#17 Copias de seguridad y restauración](https://github.com/miguel-np/personal-budget/issues/17)

## Fase 3 — Mejoras (P3)

- [x] [#19 Pagos recurrentes y sugerencias de categoría](https://github.com/miguel-np/personal-budget/issues/19)
- [x] [#20 Previsiones explicables](https://github.com/miguel-np/personal-budget/issues/20)

## Resultados registrados (25-oct-2026)

- P0/P1: instalación limpia ensayada en WSL2, dashboard operativo desde Windows, persistencia verificada tras `restart` y `--force-recreate`, y aceptación live del adaptador contra un presupuesto sintético.
- P2: aceptación live de Ollama con `qwen3:8b` en loopback (tool calling estructurado), interop MCP con el cliente oficial del SDK, chat end-to-end con inyección rechazada, flujo E2E de seguridad y backup/restore en instancia aislada con inventario idéntico (`RESTORE_OK`).
- P3: pagos recurrentes y sugerencias de categoría con señales deterministas (candidatos explicados, confirmación con previsualización) y previsiones reproducibles marcadas como estimaciones, verificadas en vivo contra el presupuesto sintético.
- Calidad: cobertura 93.45% statements / 81.87% branches, CI verde en Linux y Windows, auditorías de dependencias sin vulnerabilidades conocidas.

La seguridad y privacidad se comprueban en cada fase. Las pruebas usan datos sintéticos; el modelo no obtiene acceso a shell, SQL libre ni archivos arbitrarios.


## Consolidación — fase 1 (1-nov-2026)

- [x] [#64 — Backup y restauración unificados de Actual + estado propio de Personal Budget](https://github.com/miguel-np/personal-budget/issues/64): integrada mediante PR #89 (commit `d2c9911`). Backup cifrado/versionado de Actual y seis almacenes propios; CI validó el roundtrip sintético completo, incluida la recuperación de `periodic-reviews.json`.
- [x] [#72 — Revisión financiera periódica y guiada](https://github.com/miguel-np/personal-budget/issues/72): integrada mediante PR #82 (commit `32caf07`). Se validaron comparación histórica por identidad estable, huellas de evidencia, límites IANA, expiración de aplazamientos y compatibilidad de historiales v1; los seis checks de CI/Security pasaron.
- [ ] [#31 — Aceptación operativa Windows + WSL2](https://github.com/miguel-np/personal-budget/issues/31): runtime, diagnóstico y CI automática cubiertos; la dependencia de recuperación #64 está resuelta. Sigue pendiente ejecutar y registrar el ensayo manual en la distribución WSL2 objetivo con un presupuesto exclusivamente sintético.


## Fase 2 — Inteligencia financiera útil (integrada el 1-nov-2026)

La implementación de #73, #83 y #74 se integró en `main` mediante el commit `9164741`, con CI verde en Linux y Windows; las tres issues quedaron cerradas con la integración.

- [x] [#73 — Saldo disponible estimado y flujo de caja](https://github.com/miguel-np/personal-budget/issues/73): proyección diaria 7/30/90 días, fuentes separadas, saldo desconocido explícito, reserva y escenarios efímeros.
- [x] [#83 — Propuestas personalizadas de mejora presupuestaria](https://github.com/miguel-np/personal-budget/issues/83): diagnóstico de periodos completos, prioridades elegidas por la persona, propuestas/simulaciones deterministas y escenarios locales.
- [x] [#74 — Alertas presupuestarias locales configurables](https://github.com/miguel-np/personal-budget/issues/74): umbrales por categoría, deduplicación, silencio/aplazamiento y panel in-app.

El almacén adicional `financial-actions.json` forma parte de la whitelist del backup cifrado unificado. El saldo de apertura usa el dato que Actual expone como saldo actual de cuenta; no se presenta como dinero bancario disponible cuando el origen no proporciona esa semántica. Los candidatos recurrentes no confirmados no se suman al flujo base. Las categorías esenciales/protegidas no reciben propuestas de recorte.

## Consolidación — paginación y endurecimiento (1-nov-2026)

- [x] [#28 — Paginación y filtrado eficiente de movimientos](https://github.com/miguel-np/personal-budget/issues/28): cerrada el 1-nov-2026. Ventanas mensuales, límite de 100.000 presentados, selección acotada offset+limit con desempate por ID y pico de heap muestreado durante la petición (PR #63 integrada). Benchmark con mes denso y multi-cuenta, recorrido completo de páginas sin omisiones/duplicados, evaluación de ActualQL y efectos de cambios concurrentes documentados en docs/transactions-and-imports.md; la evidencia quedó registrada en la issue.
- [ ] [#65 — Endurecer los contratos financieros independientes del proveedor](https://github.com/miguel-np/personal-budget/issues/65): preventiva P3. Auditoría de referencias al SDK fuera del adaptador, contratos de dominio obligatorios/opcionales y suite de conformidad reutilizable pendientes.
