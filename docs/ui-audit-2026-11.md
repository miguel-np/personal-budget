# Informe de auditoría de UI — 2026-11-05

## Alcance y método

Revisión transversal de las doce rutas principales: Resumen, Movimientos, Cuentas, Patrimonio y documentos, Informes, Presupuestos, Planificación, Inteligencia financiera, Revisión financiera, Objetivos, Asistente y Configuración.

El análisis combina inspección estática de React/CSS/Playwright y regresiones automatizadas añadidas a la suite. Los datos E2E se limitan a fixtures sintéticos. No se conecta a Actual Budget real ni se leen sus almacenes.

## Hallazgos y correcciones

| Severidad | Área | Evidencia estática | Corrección |
|---|---|---|---|
| Media | Iconografía y navegación | La navegación compartida utilizaba glifos Unicode y una barra horizontal podía dejar el destino activo fuera del área visible. | Sustitución por SVG inline accesibles; el SVG queda oculto al árbol de accesibilidad y el enlace conserva su nombre visible. El destino activo se desplaza a la vista al cambiar de ruta. |
| Media | Estados dinámicos | La búsqueda web tenía errores anunciados, pero no un estado accesible explícito para espera y finalización. | aria-busy y región role=status anuncian progreso y cantidad de fuentes, sin exponer contenido adicional. |
| Media | Tablas y teclado | La tabla de proyección de Planificación tenía scroll horizontal sin región etiquetada y enfocable, a diferencia de las regiones de movimientos y presupuestos. | Se añade role=region, nombre accesible y tabIndex=0. |
| Media | Objetivos táctiles | Una regla específica de Inteligencia financiera reducía la altura de sus botones por debajo del objetivo compartido. | Se fija una altura mínima de 44 CSS px para esas acciones y se añade cobertura transversal por ruta. |
| Baja | Legibilidad | Etiquetas de formularios y texto tabular esencial usaban tamaños compactos de 10–11 px. | Se elevan etiquetas de campo a 12 px, encabezados tabulares a 11 px y celdas de importes a 11–12 px; se mantiene el tamaño compacto solo en metadata secundaria. |
| Media | Cobertura de regresión | Las pruebas cubrían ocho rutas, tres anchos para reflow y contraste limitado al tema oscuro del Resumen. | Se amplía a las doce rutas, seis anchos y ambos temas para los textos financieros priorizados. Se revisan etiquetas, objetivos táctiles, foco, regiones desplazables y movimiento reducido. |

## Verificación automatizada añadida

- Todas las doce rutas se comprueban en 320, 375, 390, 768, 1024 y 1440 CSS px para detectar overflow global.
- Los textos financieros priorizados se comprueban en ambos temas con composición de fondos transparentes y umbrales AA de 4,5:1 para texto normal y 3:1 para texto grande.
- Los campos visibles se comprueban en las doce rutas para identificar controles sin etiqueta programática.
- Los objetivos de navegación y acciones principales se comprueban en móvil en las doce rutas.
- Se comprueba el enlace de salto, el foco del encabezado al navegar, la visibilidad del enlace activo en navegación horizontal, el foco de regiones de tabla y la preferencia de movimiento reducido.
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
