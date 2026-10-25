# Roadmap de implementación

El repositorio está en fase de documentación y diseño inicial; la implementación de la aplicación aún está pendiente. El seguimiento accionable vive en GitHub Issues.

## Prioridades

- **P0 — Bloqueante:** fundamentos técnicos y financieros.
- **P1 — MVP sin IA:** registro/importación de movimientos e informes fiables.
- **P2 — IA local y fiabilidad:** Ollama, MCP, chat, seguridad y recuperación.
- **P3 — Mejoras:** sugerencias de categorías, pagos recurrentes y previsiones.

## Fase 0 — Fundamentos (P0)

- [ ] [#2 Workspace TypeScript, scripts de calidad y CI](https://github.com/miguel-np/personal-budget/issues/2)
- [ ] [#3 Stack local de Actual Budget con persistencia y puertos seguros](https://github.com/miguel-np/personal-budget/issues/3)
- [ ] [#4 Adaptador oficial `@actual-app/api`](https://github.com/miguel-np/personal-budget/issues/4)
- [ ] [#5 Núcleo de cálculos financieros deterministas](https://github.com/miguel-np/personal-budget/issues/5)
- [ ] [#6 Backend local y frontera de seguridad](https://github.com/miguel-np/personal-budget/issues/6)

**Criterio de salida:** instalación reproducible; Actual disponible localmente; adaptador probado con presupuesto sintético; reglas monetarias cubiertas por tests; API local con validación y logs saneados.

## Fase 1 — MVP sin IA (P1)

- [ ] [#7 Shell web unificada](https://github.com/miguel-np/personal-budget/issues/7)
- [ ] [#8 Lectura de cuentas, categorías y movimientos](https://github.com/miguel-np/personal-budget/issues/8)
- [ ] [#9 Registro manual de movimientos con confirmación](https://github.com/miguel-np/personal-budget/issues/9)
- [ ] [#10 Dashboard diario, mensual y anual](https://github.com/miguel-np/personal-budget/issues/10)
- [ ] [#11 Importación de extractos y conciliación](https://github.com/miguel-np/personal-budget/issues/11)
- [ ] [#12 Presupuestos y desviaciones por categoría](https://github.com/miguel-np/personal-budget/issues/12)
- [ ] [#18 Validar instalación limpia en Windows + WSL2](https://github.com/miguel-np/personal-budget/issues/18)

**Criterio de salida:** el usuario registra/importa movimientos desde el flujo previsto y revisa gastos y ahorro desde una única interfaz; el sistema funciona sin Ollama y los resultados se contrastan contra un dataset sintético.

## Fase 2 — IA local y fiabilidad (P2)

- [ ] [#13 Integración local con Ollama](https://github.com/miguel-np/personal-budget/issues/13)
- [ ] [#14 Herramientas MCP limitadas y de solo lectura](https://github.com/miguel-np/personal-budget/issues/14)
- [ ] [#15 Chat financiero integrado con confirmación de cambios](https://github.com/miguel-np/personal-budget/issues/15)
- [ ] [#16 Pruebas de seguridad, privacidad y end-to-end](https://github.com/miguel-np/personal-budget/issues/16)
- [ ] [#17 Copia de seguridad y restauración verificadas](https://github.com/miguel-np/personal-budget/issues/17)

**Criterio de salida:** el chat utiliza herramientas aprobadas y resultados verificables; Ollama puede fallar sin inutilizar el gestor; hay evidencia de restauración y pruebas de privacidad.

## Fase 3 — Mejoras (P3)

- [ ] [#19 Detección de pagos recurrentes y sugerencias de categoría](https://github.com/miguel-np/personal-budget/issues/19)
- [ ] [#20 Previsiones de ahorro y simulaciones explicables](https://github.com/miguel-np/personal-budget/issues/20)

## Dependencias principales

1. #2 prepara el workspace. #3 y #5 pueden avanzar en paralelo.
2. #4 requiere el workspace y el entorno Actual; #6 necesita el backend/adaptador.
3. #7 y #8 construyen la interfaz y lectura de datos; #9, #10, #11 y #12 completan el MVP sin IA.
4. #13 y #14 habilitan el chat de #15. #16 y #17 verifican seguridad y recuperación.
5. #19 y #20 no deben adelantarse al núcleo financiero y la conciliación.

## Principios que no se deben relajar

- Cálculos financieros deterministas; precisión monetaria y reglas explícitas para traspasos, reembolsos, splits, periodos y divisas.
- Actual Budget continúa siendo la fuente de verdad; la app no debe editar archivos internos del presupuesto.
- Importaciones y operaciones de escritura siempre tienen validación y resultados comprobables.
- IA local por defecto; herramientas MCP limitadas; nada de shell ni SQL arbitrario.
- Usar datos sintéticos en pruebas y no subir extractos, presupuestos, logs sensibles o credenciales a Git.
- No exponer servicios a la LAN por defecto; copias fuera del dispositivo deben cifrarse y documentarse como una salida de datos del entorno local.

## Roadmap de GitHub

La [issue #1](https://github.com/miguel-np/personal-budget/issues/1) es el índice de seguimiento general. Cada issue contiene alcance, criterios de aceptación, dependencias y riesgos.