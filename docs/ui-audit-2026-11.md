# Informe de auditoría de UI — 2026-11-05

## Alcance y método

Revisión transversal de las doce rutas principales: Resumen, Movimientos, Cuentas, Patrimonio y documentos, Informes, Presupuestos, Planificación, Inteligencia financiera, Revisión financiera, Objetivos, Asistente y Configuración.

El análisis combina inspección estática de React/CSS/Playwright y regresiones automatizadas añadidas a la suite. Los datos E2E se limitan a fixtures sintéticos. No se conecta a Actual Budget real ni se leen sus almacenes.

## Hallazgos y correcciones

| Severidad | Área | Evidencia estática | Corrección |
|---|---|---|---|
| Media | Iconografía y navegación | La navegación compartida y los estados vacíos utilizaban glifos Unicode; los encabezados ordenables exponían flechas como texto plano. La barra horizontal podía dejar el destino activo fuera del área visible. | Sustitución de la iconografía de navegación y ordenación por SVG decorativos; los estados vacíos usan una forma CSS. Los encabezados anuncian `aria-sort` y el destino activo se desplaza a la vista al cambiar de ruta. |
| Media | Estados dinámicos | La búsqueda web tenía errores anunciados, pero no un estado accesible explícito para espera y finalización. | aria-busy y región role=status anuncian progreso y cantidad de fuentes, sin exponer contenido adicional. |
| Media | Tablas y teclado | La tabla de proyección de Planificación tenía scroll horizontal sin región etiquetada y enfocable, a diferencia de las regiones de movimientos y presupuestos. | Se añade role=region, nombre accesible y tabIndex=0. |
| Media | Objetivos táctiles | Una regla específica de Inteligencia financiera reducía la altura de sus botones por debajo del objetivo compartido. | Se fija una altura mínima de 44 CSS px para esas acciones y se añade cobertura transversal por ruta. |
| Baja | Legibilidad | Etiquetas de formularios y texto tabular esencial usaban tamaños compactos de 10–11 px. | Se elevan etiquetas de campo a 12 px, encabezados tabulares a 11 px y celdas de importes a 11–12 px; se mantiene el tamaño compacto solo en metadata secundaria. |
| Media | Cobertura de regresión | Las pruebas cubrían ocho rutas, tres anchos para reflow y contraste limitado al tema oscuro del Resumen. | Se amplía a las doce rutas, seis anchos y ambos temas para los textos financieros priorizados. Se revisan etiquetas, objetivos táctiles, foco, regiones desplazables y movimiento reducido. |

## Verificación automatizada añadida

- Todas las doce rutas se comprueban en ambos temas y en 320, 375, 390, 768, 1024 y 1440 CSS px para detectar overflow global.
- Los textos financieros priorizados se comprueban en ambos temas con composición de fondos transparentes y umbrales AA de 4,5:1 para texto normal y 3:1 para texto grande.
- Los campos visibles se comprueban en las doce rutas para identificar controles sin etiqueta programática.
- Los objetivos de navegación y acciones principales se comprueban en ambos temas y en 320, 375 y 390 CSS px en las doce rutas.
- Se comprueba el enlace de salto, el foco del encabezado al navegar, la visibilidad del enlace activo en navegación horizontal, `aria-sort` al ordenar movimientos, el foco de las regiones de movimientos, presupuestos y proyección mensual de Planificación, y la preferencia de movimiento reducido.
- La investigación web anuncia su espera y finalización mediante una región de estado.

Estas pruebas son controles de regresión específicos; no equivalen a una auditoría WCAG completa ni prueban todos los estados de cada funcionalidad.

## Límites y comprobaciones manuales pendientes

No se ha dispuesto en esta sesión de un checkout ejecutable del repositorio ni de un navegador conectado a los cambios. Por tanto, no se declaran ejecutados localmente npm ci, lint, typecheck, cobertura, build, auditorías npm ni Playwright. Deben validarse en GitHub Actions sobre el último SHA de la PR.

Siguen pendientes de ejecución humana sobre la aplicación construida:

1. Recorrido completo con teclado en flujos representativos, incluida entrada/salida de diálogos, filtros, tablas y confirmaciones financieras.
2. Confirmación de foco no oculto con scroll real y zoom/reflow al 200 % y 400 %.
3. Inspección del árbol de accesibilidad y lector de pantalla (al menos NVDA o VoiceOver) para tablas, gráficos, estados dinámicos y formularios.
4. Confirmación visual de contraste en estados hover, focus, disabled, error y empty, además de los textos muestreados por Playwright.
5. Confirmación de que prefers-reduced-motion conserva el feedback funcional en cada flujo animado.

No se certifica conformidad WCAG 2.2 AA completa mientras estas comprobaciones manuales no se realicen y documenten.

## Límites de alcance y privacidad

No se modifican contratos API, cálculos financieros, persistencia, semántica de importes ni procesos de confirmación. No se introducen librerías de iconos, dependencias de auditoría, telemetría ni datos reales. La issue #84 permanece aparcada y la PR #123 queda fuera de esta intervención.


## Seguimiento de integración — 2026-11-15

La intervención automatizada descrita en este informe se integró mediante la [PR #125](https://github.com/miguel-np/personal-budget/pull/125), fusionada el 14 de noviembre de 2026 en `main`. Su commit de cambios de UI es `928c4062a3267733b7de036f97315675e8038b52`. Los diez archivos modificados por esa PR se verificaron con los mismos SHA tanto en `main` como en la rama de origen; no se requiere volver a integrar esa rama.

Evidencia de GitHub Actions asociada al commit de la PR:

- CI run [678](https://github.com/miguel-np/personal-budget/actions/runs/41985096656): cinco trabajos completados con éxito (`quality`, `actual-container-smoke`, `actual-update-acceptance`, `windows-quality` y `browser-e2e`).
- Playwright Chromium: 42/42 pruebas superadas en ese commit.
- Security run [611](https://github.com/miguel-np/personal-budget/actions/runs/41985096765): auditoría de dependencias y escaneo de secretos superados.

Esta evidencia corresponde al commit indicado y no demuestra que se hayan ejecutado comprobaciones manuales ni equivale a una ejecución de esos checks sobre commits posteriores de `main`. La issue #36 está cerrada; el seguimiento de las verificaciones manuales restantes corresponde a la issue [#124](https://github.com/miguel-np/personal-budget/issues/124).

El seguimiento adicional de #124 eleva a 12 px el tamaño base de las celdas de la proyección mensual de objetivos y conserva encabezados compactos de 11 px. Añade regresiones Playwright para comprobar esos tamaños renderizados y para abrir/cerrar el editor de movimientos mediante teclado, incluyendo el retorno del foco al control que lo abrió. Estas pruebas siguen siendo controles automatizados de regresión: no verifican NVDA/VoiceOver, zoom real del navegador ni contraste de todos los estados interactivos.


## Seguimiento adicional — 2026-11-22

### Defectos reproducibles y correcciones

- **Media — foco fuera del viewport tras navegación:** la shell enfocaba el encabezado de la nueva ruta con `preventScroll: true` sin desplazar después el documento. Si la persona navegaba desde el final de una página larga, el foco podía quedar fuera de pantalla. La shell conserva el foco programático y desplaza explícitamente el encabezado al inicio de la zona visible.
- **Baja — movimiento residual con preferencia reducida:** el estado `:active` de los botones aplicaba una traslación vertical de 1 px aunque se hubiera solicitado movimiento reducido. Se elimina esa transformación en `prefers-reduced-motion: reduce` y se conserva el feedback de color.

### Regresiones automatizadas añadidas

- Cambio de ruta con foco de teclado desde una página desplazada, en 320, 768 y 1440 CSS px y en ambos temas; se comprueba que el encabezado enfocado está dentro del viewport y mantiene el indicador visible.
- Contraste del indicador de foco de teclado en ambos temas, con mínimo 3:1 frente a la superficie adyacente y un contorno visible de al menos 2 CSS px.
- Movimiento reducido: se comprueba que desaparece la traslación de botones activos, que el feedback de hover permanece y que las transiciones/scroll se reducen.

La revisión manual continúa pendiente y no se declara conformidad WCAG 2.2 AA completa. Estas pruebas no sustituyen la inspección visual real de zoom de navegador al 200 % y 400 %, árbol de accesibilidad y NVDA/VoiceOver, ni la revisión humana de todos los estados hover/focus/disabled/error/empty y de cada flujo con scroll real. La PR y los checks CI deberán asociarse al SHA definitivo antes de considerar estas regresiones validadas.
