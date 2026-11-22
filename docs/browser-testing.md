# Pruebas E2E de navegador

## Alcance

La suite Playwright se ejecuta contra el frontend construido por `npm run build` y servido en modo preview, no contra Vite dev. Un servidor de fixtures aislado atiende la API en loopback y usa exclusivamente cuentas, categorías, movimientos e importes ficticios. No importa .env, datos del directorio `.local`, backups ni presupuestos Actual. No necesita una instancia de Actual ni un modelo Ollama.

## Ejecución

~~~bash
npm ci
npm run build
npm run setup:e2e
npm run test:e2e
~~~

La suite levanta y detiene sus servidores automáticamente. `npm run setup:e2e` instala Chromium por separado de lint, tests unitarios e integración para facilitar el diagnóstico y evitar descargas implícitas en `npm run validate`. CI instala también las dependencias de sistema del navegador. Para ejecutar el ciclo local completo antes de abrir una PR, utiliza `npm run validate` después de preparar Chromium.

## Cobertura

- Dashboard y periodo; navegación entre secciones, filtros y paginación.
- Flujo de caja 7/30/90, separación de movimientos/compromisos/escenarios y simulación no persistente.
- Propuestas de mejora: clasificación explícita, simulación combinada y guardado local de escenario sin escrituras financieras.
- Alertas de presupuesto: creación/edición de regla, exceso relativo, deduplicación, aplazamiento y ausencia de escrituras.
- Informes y presupuestos con datos sintéticos.
- Importación CSV mediante previsualización, confirmación explícita y comprobación de escritura sintética.
- Sugerencias de categoría: previsualizar, cancelar, confirmar y descartar.
- Actual sin configurar y asistente desactivado.
- Viewports de escritorio, tablet y móvil; overflow horizontal.
- Los artefactos solo se guardan en fallos y contienen fixtures sintéticos.

La suite incluye fixtures OFX sintéticos y preferencias de divisa locales. Los escenarios concretos deben leerse en apps/web/e2e/acceptance.spec.ts; no se simula una instancia real de Actual Budget ni se reutilizan presupuestos, backups o datos financieros del usuario.

### Accesibilidad y reflujo

La suite recorre las doce secciones de navegación. Comprueba el enlace de salto, el foco del título tras navegar incluso cuando el documento está desplazado, la visibilidad del destino activo en la navegación horizontal, contraste 3:1 del indicador de foco en ambos temas, etiquetas programáticas, regiones de tablas desplazables con foco de teclado y movimiento reducido (incluida la eliminación del desplazamiento vertical de botones activos sin perder el feedback de color). La comprobación de contraste evalúa textos financieros prioritarios en tema claro y oscuro, componiendo los fondos transparentes con las superficies ancestrales. La regresión responsive comprueba que el documento no desborde en ambos temas y en 320, 375, 390, 768, 1024 y 1440 CSS px; los objetivos principales se verifican en las doce secciones, los dos temas y 320, 375 y 390 CSS px frente al objetivo de diseño de 44 × 44 CSS px.

Estas comprobaciones no sustituyen una auditoría manual. La implementación automatizada inicial de #36 está cerrada; las comprobaciones manuales pendientes se siguen en #124. Antes de cerrar #124 hay que recorrer los flujos esenciales con teclado y lector de pantalla/árbol de accesibilidad, comprobar foco no oculto, zoom y movimiento reducido, y registrar las limitaciones conocidas. El E2E del editor de movimientos comprueba activación por teclado, contención de Tab/Mayús+Tab, cierre con Escape y restauración del foco, pero no sustituye la inspección con tecnología asistiva.
