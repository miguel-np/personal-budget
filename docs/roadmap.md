# Roadmap de implementación

El repositorio está pasando de especificación a código inicial. El seguimiento accionable vive en [GitHub Issues](https://github.com/miguel-np/personal-budget/issues).

## Prioridades

- **P0 — Bloqueante:** bases técnicas, seguridad y cálculos financieros.
- **P1 — MVP sin IA:** registro/importación y consulta de gastos/ahorro desde una interfaz única.
- **P2 — IA local y fiabilidad:** Ollama, MCP, chat, recuperación y validación de seguridad.
- **P3 — Mejoras:** sugerencias de categoría, pagos recurrentes y previsiones.

## Fase 0 — Fundamentos (P0)

- [x] [#2 Workspace TypeScript, scripts y CI](https://github.com/miguel-np/personal-budget/issues/2)
- [ ] [#3 Actual Budget local, persistencia y puertos seguros](https://github.com/miguel-np/personal-budget/issues/3)
- [ ] [#4 Adaptador oficial @actual-app/api](https://github.com/miguel-np/personal-budget/issues/4)
- [x] [#5 Cálculos deterministas y pruebas](https://github.com/miguel-np/personal-budget/issues/5)
- [x] [#6 Backend local y frontera de seguridad](https://github.com/miguel-np/personal-budget/issues/6)

Salida parcial (25-oct-2026): lockfile reproducible, CI verde, núcleo financiero cubierto y backend local protegido. Pendiente completar prueba manual de persistencia en Windows + WSL2 y aceptación live del adaptador contra un presupuesto de Actual; por eso #3 y #4 siguen abiertas.

## Fase 1 — MVP sin IA (P1)

- [ ] [#7 Shell web unificada](https://github.com/miguel-np/personal-budget/issues/7)
- [ ] [#8 Lectura de cuentas, categorías y movimientos](https://github.com/miguel-np/personal-budget/issues/8)
- [ ] [#9 Registro manual con confirmación](https://github.com/miguel-np/personal-budget/issues/9)
- [ ] [#10 Dashboard diario, mensual y anual](https://github.com/miguel-np/personal-budget/issues/10)
- [ ] [#11 Importación y conciliación](https://github.com/miguel-np/personal-budget/issues/11)
- [ ] [#12 Presupuesto frente a gasto por categoría](https://github.com/miguel-np/personal-budget/issues/12)
- [ ] [#18 Ensayo de instalación limpia en WSL2](https://github.com/miguel-np/personal-budget/issues/18)

Salida: importar y registrar movimientos, revisar duplicados y consultar informes contrastados sin depender de IA.

## Fase 2 — IA local y fiabilidad (P2)

- [ ] [#13 Ollama local](https://github.com/miguel-np/personal-budget/issues/13)
- [ ] [#14 Herramientas MCP de solo lectura](https://github.com/miguel-np/personal-budget/issues/14)
- [ ] [#15 Chat financiero integrado](https://github.com/miguel-np/personal-budget/issues/15)
- [ ] [#16 Pruebas de seguridad y end-to-end](https://github.com/miguel-np/personal-budget/issues/16)
- [ ] [#17 Copias de seguridad y restauración](https://github.com/miguel-np/personal-budget/issues/17)

## Fase 3 — Mejoras (P3)

- [ ] [#19 Pagos recurrentes y sugerencias de categoría](https://github.com/miguel-np/personal-budget/issues/19)
- [ ] [#20 Previsiones explicables](https://github.com/miguel-np/personal-budget/issues/20)

## Dependencias

1. #2 establece workspace y CI.
2. #3 prepara Actual; #5 puede desarrollarse con datos sintéticos.
3. #4 conecta Actual; #6 crea la API local.
4. #7/#8 forman la base de interfaz y lectura; #9–#12 completan el MVP.
5. #13/#14 preceden al chat #15.
6. #16/#17 verifican seguridad y recuperación antes de declarar el sistema fiable.

La seguridad y privacidad se comprueban en cada fase. Las pruebas usan datos sintéticos; el modelo no obtiene acceso a shell, SQL libre ni archivos arbitrarios.
