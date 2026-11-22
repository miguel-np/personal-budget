# Baseline de versiones y política de seguridad

**Baseline revisada: 22 de noviembre de 2026.** Las dependencias directas están fijadas a versiones exactas para reproducir el entorno. La fecha de esta tabla identifica la revisión de versiones, no garantiza que sigan siendo las últimas disponibles.

## Versiones principales

| Tecnología | Versión fijada | Fuente oficial |
|---|---:|---|
| Node.js Maintenance LTS | 24.22.3 | [Release](https://nodejs.org/en/blog/release/v24.22.3) |
| Actual Budget server | 26.10.0 | [Release](https://github.com/actualbudget/actual/releases/tag/v26.10.0) |
| @actual-app/api | 26.10.0 | [API oficial](https://actualbudget.org/docs/api/) |
| Fastify | 5.12.8 | [Release](https://github.com/fastify/fastify/releases/tag/v5.12.8) · [Política LTS](https://fastify.dev/docs/latest/Reference/LTS/) |
| @fastify/helmet | 13.2.0 | [NPM](https://www.npmjs.com/package/@fastify/helmet) |
| Zod | 4.6.7 | [NPM](https://www.npmjs.com/package/zod) |
| React / React DOM | 19.3.1 | [Versiones React](https://react.dev/versions) |
| Vite | 8.3.8 | [Release](https://github.com/vitejs/vite/releases/tag/v8.3.8) · [Lanzamientos](https://vite.dev/releases) |
| TypeScript | 6.0.3 | [Release oficial](https://github.com/microsoft/TypeScript/releases) |
| typescript-eslint | 8.72.0 | [Release](https://github.com/typescript-eslint/typescript-eslint/releases) |
| Vitest + coverage | 5.0.5 | [Vitest](https://www.npmjs.com/package/vitest) |
| ESLint | 10.13.0 | [Versiones ESLint](https://eslint.org/docs/latest/versions/) |

## Actualizaciones de seguridad de noviembre de 2026

- **Node.js 24.22.3** incorpora las correcciones de seguridad publicadas el 11 de noviembre de 2026. Node.js 24 pasó a Maintenance LTS el 20 de octubre de 2026; se mantiene la línea 24 por compatibilidad declarada del proyecto.
- **Fastify 5.12.8** corrige [GHSA-3qgw-9275-xf8w](https://github.com/fastify/fastify/security/advisories/GHSA-3qgw-9275-xf8w). El aviso requiere la combinación de `handlerTimeout` distinto de cero y respuestas de streaming; no se encontró esa configuración en el runtime auditado. Se actualiza igualmente para incorporar la versión corregida.
- **Vite 8.3.8** incorpora la corrección para [GHSA-p4f5-76q4-ffq7](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7), que afecta a Vite 8.3.0–8.3.6 cuando el servidor de desarrollo está expuesto a la red. El script de desarrollo de este repositorio lo enlaza a `127.0.0.1`; la actualización elimina igualmente el uso de la versión afectada.

Se selecciona TypeScript 6.0.3, no la versión 7.0.2, porque la versión estable de typescript-eslint fijada en este proyecto declara compatibilidad de TypeScript menor que 6.1.0. Evitamos forzar peer dependencies incompatibles.

## Controles

- `.nvmrc` fija Node.js 24.22.3.
- Las GitHub Actions de checkout y setup-node están fijadas por SHA completo.
- CI ejecuta `npm audit --audit-level=moderate`, lint, typecheck, pruebas con cobertura, build y auditoría de dependencias de producción.
- Ejecutar auditorías semanalmente y antes de cada release.
- Actualizar dependencias de forma deliberada, revisar lockfile y ejecutar pruebas.
- No aplicar `npm audit fix --force` sin evaluar cambios de major.
- Actual Budget se fija en Compose a una versión explícita; actualizaciones requieren backup y pruebas.

## Sobre “libre de vulnerabilidades”

No puede garantizarse ausencia de vulnerabilidades para siempre. Las bases de avisos pueden retrasarse, pueden existir fallos aún sin CVE y las dependencias indirectas también cuentan. Un `npm audit` sin hallazgos refleja únicamente los avisos conocidos del árbol de paquetes y el umbral elegido en el momento del análisis. Consulta [SECURITY.md](../SECURITY.md) para evidencias fechadas y límites.
