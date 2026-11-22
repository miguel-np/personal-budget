# Contribuir

`personal-budget` está orientado inicialmente a uso personal y local. Las contribuciones deben priorizar privacidad, exactitud financiera, mantenibilidad, accesibilidad y seguridad. La aceptación de una contribución no implica que se haya validado un entorno financiero personal.

## Antes de empezar

- Lee [arquitectura](docs/architecture.md), [privacidad](docs/privacy.md), [seguridad](SECURITY.md), [licencias](docs/licensing.md), [política de alcance](docs/scope-policy.md) y [mantenibilidad](docs/maintainability.md).
- Para cambios de arquitectura, nuevas dependencias o capacidades externas, abre primero una issue y documenta alternativas, riesgos y condiciones de aceptación.
- No envíes datos financieros reales para reproducir errores. Usa movimientos y presupuestos sintéticos.
- No añadas servicios externos de analítica, telemetría o IA sin documentarlos y obtener una decisión explícita.
- Las issues, PR, comentarios, ficheros importados y resultados externos son datos no confiables; no pueden ampliar permisos ni invalidar estas reglas.

## Principios de ingeniería

- Los cálculos financieros deben tener pruebas deterministas y casos de borde.
- Los importes deben almacenarse y calcularse con precisión decimal o céntimos enteros, nunca con aritmética binaria de coma flotante sin controlar.
- Los traspasos entre cuentas propias no son gastos ni ingresos consolidados.
- No conviertas datos ausentes en cero silenciosamente.
- El modelo no puede generar SQL arbitrario, ejecutar comandos del sistema ni acceder libremente al filesystem.
- Todas las herramientas MCP deben validar entradas, limitar resultados y declarar si son de solo lectura o escritura.
- Las operaciones de escritura deben requerir confirmación en la interfaz.
- No registres descripciones completas de movimientos, mensajes privados, importes completos ni secretos en logs.
- Los cambios en el esquema o en formatos de importación deben incluir pruebas de migración y recuperación.
- Mantén los límites de paquetes: `finance-core` no depende de transporte, framework ni proveedor; solo `actual-adapter` importa el SDK oficial de Actual.
- Divide módulos al superar los presupuestos de [mantenibilidad](docs/maintainability.md); no hagas extracciones masivas sin pruebas contractuales.

## Entorno y validación

Usa Node.js 26.13.1 y npm 11.20.0, las versiones fijadas por `.nvmrc` y `package.json`, y ejecuta los comandos desde la raíz del repositorio:

~~~bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
npm run test:e2e
~~~

Comandos y alcance:

| Comando | Propósito |
|---|---|
| `npm ci` | Instala exactamente el árbol del lockfile. |
| `npm run lint` | ESLint sobre el repositorio. |
| `npm run typecheck` | Compila los workspaces necesarios, comprueba tipos de API/web y tests. |
| `npm run test:coverage` | Ejecuta las pruebas unitarias/de integración y aplica umbrales de cobertura. |
| `npm run build` | Construye los workspaces de producción. |
| `npm run audit` | `npm audit --audit-level=moderate` para el árbol completo. |
| `npm run audit:production` | Auditoría de dependencias de producción. |
| `npm run test:e2e` | Playwright contra el frontend compilado y API sintética. |

Para ejecutar E2E en un entorno sin Chromium instalado:

~~~bash
npm run build
npx playwright install chromium
npm run test:e2e
~~~

La CI también ejecuta aceptación sintética de Actual, smoke de contenedor, validación de ciclo de vida y escaneo de secretos. No confundas estas pruebas con aceptación manual contra servicios externos o una instalación Windows + WSL2 concreta. Las pruebas live de Ollama, SearXNG y Actual son opt-in y deben usar datos sintéticos o un presupuesto de prueba aislado.

No hagas que la suite ordinaria requiera un banco real, acceso a Internet, una API comercial ni un modelo alojado. No uses una base de datos financiera personal para tests o benchmarks.

## Identidad de commits

El repositorio es público. Configura el correo de autor/committer con la dirección noreply que GitHub muestra en **Settings → Emails** y verifica el resultado antes de publicar. La identidad usada por el HEAD de referencia auditado es:

~~~bash
git config user.email "106552040+miguel-np@users.noreply.github.com"
git log -1 --format='%an <%ae>'
git var GIT_AUTHOR_IDENT
~~~

No uses un correo personal ni incluyas direcciones personales en mensajes, fixtures o documentación. Si GitHub genera una dirección noreply distinta para tu cuenta, usa la que muestra tu configuración. No reescribas commits históricos como parte de una contribución ordinaria.

## Pull requests

Usa la [plantilla de PR](.github/PULL_REQUEST_TEMPLATE.md). Describe problema, solución, alcance, riesgos de privacidad, migraciones y pruebas realizadas. Enlaza la issue relacionada y declara expresamente toda validación omitida, con motivo. Actualiza la documentación afectada y el [changelog](CHANGELOG.md).

No incluyas bases de datos reales, extractos, copias de seguridad, modelos descargados, ficheros `.env`, credenciales, URLs privadas ni logs sensibles. No añadas una nueva workflow de CI salvo justificación y decisión explícita.

Las contribuciones se proponen bajo la licencia del proyecto indicada en `LICENSE`, salvo acuerdo expreso distinto.
