# Roadmap de implementación

El roadmap del proyecto se ha completado (25-oct-2026): P0, P1, P2 y P3 están implementados, validados en vivo en el entorno objetivo Windows + WSL2 y cerrados. El seguimiento accionable vive en [GitHub Issues](https://github.com/miguel-np/personal-budget/issues).

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
