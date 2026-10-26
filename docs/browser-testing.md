# Pruebas E2E de navegador

## Alcance

La suite Playwright se ejecuta contra el frontend construido por `npm run build` y servido en modo preview, no contra Vite dev. Un servidor de fixtures aislado atiende la API en loopback y usa exclusivamente cuentas, categorías, movimientos e importes ficticios. No importa .env, datos del directorio `.local`, backups ni presupuestos Actual. No necesita una instancia de Actual ni un modelo Ollama.

## Ejecución

~~~bash
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
~~~

La suite levanta y detiene sus servidores automáticamente. Chromium se instala por separado de lint/unit/integration para facilitar el diagnóstico. CI instala también las dependencias de sistema del navegador.

## Cobertura

- Dashboard y periodo; navegación entre secciones, filtros y paginación.
- Informes y presupuestos con datos sintéticos.
- Importación CSV mediante previsualización, confirmación explícita y comprobación de escritura sintética.
- Sugerencias de categoría: previsualizar, cancelar, confirmar y descartar.
- Actual sin configurar y asistente desactivado.
- Viewports de escritorio, tablet y móvil; overflow horizontal.
- Los artefactos solo se guardan en fallos y contienen fixtures sintéticos.

No se simulan OFX, cambio de divisa ni selección consolidada de varias cuentas hasta que esas funciones existan.
