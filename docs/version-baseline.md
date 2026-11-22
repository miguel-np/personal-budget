# Baseline de versiones y política de seguridad

**Baseline revisada: 22 de noviembre de 2026.** Las dependencias directas están fijadas a versiones exactas para reproducir el entorno. La fecha de esta tabla identifica la revisión de versiones, no garantiza que sigan siendo las últimas disponibles.

## Versiones principales

| Tecnología | Versión fijada | Fuente oficial |
|---|---:|---|
| Node.js Active LTS | 26.13.1 | [Release de seguridad](https://nodejs.org/en/blog/release/v26.13.1) · [Calendario](https://nodejs.org/en/about/previous-releases) |
| npm | 11.20.0 | [Incluido en Node.js 26.13.1](https://nodejs.org/en/download/archive/v26.13.1) |
| Actual Budget server | 26.11.0 | [Release](https://github.com/actualbudget/actual/releases/tag/v26.11.0) |
| @actual-app/api | 26.11.0 | [API oficial](https://actualbudget.org/docs/api/) |
| Fastify | 5.12.8 | [Release](https://github.com/fastify/fastify/releases/tag/v5.12.8) · [Política LTS](https://fastify.dev/docs/latest/Reference/LTS/) |
| @fastify/helmet | 13.2.0 | [NPM](https://www.npmjs.com/package/@fastify/helmet) |
| Zod | 4.6.7 | [NPM](https://www.npmjs.com/package/zod) |
| React / React DOM | 19.3.1 | [Versiones React](https://react.dev/versions) |
| Vite | 8.3.8 | [Release](https://github.com/vitejs/vite/releases/tag/v8.3.8) · [Lanzamientos](https://vite.dev/releases) |
| TypeScript | 6.0.3 | [Release oficial](https://github.com/microsoft/TypeScript/releases) |
| @types/node | 26.6.6 | [NPM](https://www.npmjs.com/package/@types/node) |
| typescript-eslint | 8.72.0 | [Release](https://github.com/typescript-eslint/typescript-eslint/releases) |
| Vitest + coverage | 5.1.1 | [Vitest 5.1](https://vitest.dev/blog/vitest-5-1) · [NPM](https://www.npmjs.com/package/vitest) |
| Playwright Test | 1.65.1 | [Release notes](https://playwright.dev/docs/release-notes) |
| ESLint | 10.13.0 | [Versiones ESLint](https://eslint.org/docs/latest/versions/) |

## Actual Budget 26.11.0

- El servidor y `@actual-app/api` se actualizan conjuntamente a 26.11.0. La versión corrige actualizaciones parciales de categorías/grupos que omitían `name`, preserva la categoría en transferencias entre cuentas on-budget/off-budget y conserva el importe y categoría de hijos de movimientos divididos en actualizaciones parciales. También corrige el guardado seguro del presupuesto y mejora el uso de memoria con presupuestos grandes. [Notas oficiales](https://actualbudget.org/blog/release-26.11.0/).
- La release restringe los puentes SimpleFIN privados mediante una allowlist administrativa para mitigar SSRF. Este proyecto no configura un puente SimpleFIN privado ni inicia sincronización bancaria; no se habilita una excepción de allowlist.
- `compose.yaml` mantiene 26.10.0 como origen predeterminado para impedir que un `docker compose up` omita el preflight y el backup cifrado. `scripts/safe-update.ts` fija `ACTUAL_IMAGE=26.11.0` en `.env` solo después de crear y verificar el backup.
- La transición 26.10.0 → 26.11.0 está verificada por CI en PR #139 (run 712, 22-nov-2026): upgrade sintético, inventario, transferencias, splits, edición de categorías, restauración explícita del backup y recuperación tras un fallo inyectado. La evidencia queda registrada en `docs/update-compatibility.json`.

## Actualizaciones de seguridad de noviembre de 2026

- **Node.js 26.13.1** es una publicación de seguridad del 11 de noviembre de 2026 con varias correcciones de severidad alta. Node.js 26 pasó a Active LTS el 28 de octubre de 2026 y recibe soporte previsto hasta abril de 2029. Node.js 26.13.1 incluye npm 11.20.0. [Release](https://nodejs.org/en/blog/release/v26.13.1) · [Calendario](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) · [Archivo](https://nodejs.org/en/download/archive/v26.13.1).
- **Fastify 5.12.8** corrige [GHSA-3qgw-9275-xf8w](https://github.com/fastify/fastify/security/advisories/GHSA-3qgw-9275-xf8w). El aviso requiere la combinación de `handlerTimeout` distinto de cero y respuestas de streaming; no se encontró esa configuración en el runtime auditado. Se actualiza igualmente para incorporar la versión corregida.
- **Vite 8.3.8** incorpora la corrección para [GHSA-p4f5-76q4-ffq7](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7), que afecta a Vite 8.3.0–8.3.6 cuando el servidor de desarrollo está expuesto a la red. El script de desarrollo de este repositorio lo enlaza a `127.0.0.1`; la actualización elimina igualmente el uso de la versión afectada.

Se selecciona TypeScript 6.0.3, no la versión 7.0.2, porque la versión estable de typescript-eslint fijada en este proyecto declara compatibilidad de TypeScript menor que 6.1.0. Evitamos forzar peer dependencies incompatibles.

## Controles

- `.nvmrc` fija Node.js 26.13.1; `package.json` exige Node `>=26.13.1 <27` y npm `>=11.20.0`.
- `@types/node` se alinea en 26.6.6; su dependencia `undici-types` queda fijada en 8.9.0 en el lockfile.
- Las GitHub Actions de checkout y setup-node están fijadas por SHA completo.
- CI ejecuta `npm audit --audit-level=moderate`, lint, typecheck, pruebas con cobertura, build y auditoría de dependencias de producción.
- Ejecutar auditorías semanalmente y antes de cada release.
- Actualizar dependencias de forma deliberada, revisar lockfile y ejecutar pruebas.
- No aplicar `npm audit fix --force` sin evaluar cambios de major.
- Actual Budget se fija en Compose a una versión explícita; actualizaciones requieren backup y pruebas.

## Sobre “libre de vulnerabilidades”

No puede garantizarse ausencia de vulnerabilidades para siempre. Las bases de avisos pueden retrasarse, pueden existir fallos aún sin CVE y las dependencias indirectas también cuentan. Un `npm audit` sin hallazgos refleja únicamente los avisos conocidos del árbol de paquetes y el umbral elegido en el momento del análisis. Consulta [SECURITY.md](../SECURITY.md) para evidencias fechadas y límites.
