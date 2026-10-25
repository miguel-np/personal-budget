# Baseline de versiones y política de seguridad

**Baseline revisada: 25 de octubre de 2026.** Las dependencias directas están fijadas a versiones exactas para reproducir el entorno.

## Versiones principales

| Tecnología | Versión fijada | Fuente oficial |
|---|---:|---|
| Node.js Active LTS | 24.22.1 | [Release](https://nodejs.org/en/blog/release/v24.22.1) |
| Actual Budget server | 26.10.0 | [Release](https://github.com/actualbudget/actual/releases/tag/v26.10.0) |
| @actual-app/api | 26.10.0 | [API oficial](https://actualbudget.org/docs/api/) |
| Fastify | 5.12.7 | [Política LTS](https://fastify.dev/docs/latest/Reference/LTS/) |
| @fastify/helmet | 13.2.0 | [NPM](https://www.npmjs.com/package/@fastify/helmet) |
| Zod | 4.6.7 | [NPM](https://www.npmjs.com/package/zod) |
| React / React DOM | 19.3.1 | [Versiones React](https://react.dev/versions) |
| Vite | 8.3.5 | [Lanzamientos](https://vite.dev/releases) |
| TypeScript | 6.0.3 | [Release oficial](https://github.com/microsoft/TypeScript/releases) |
| typescript-eslint | 8.72.0 | [Release](https://github.com/typescript-eslint/typescript-eslint/releases) |
| Vitest + coverage | 5.0.5 | [Vitest](https://www.npmjs.com/package/vitest) |
| ESLint | 10.13.0 | [Versiones ESLint](https://eslint.org/docs/latest/versions/) |

Se selecciona TypeScript 6.0.3, no la versión 7.0.2, porque la versión estable de typescript-eslint fijada en este proyecto declara compatibilidad de TypeScript menor que 6.1.0. Evitamos forzar peer dependencies incompatibles.

## Controles

- .nvmrc fija Node.js 24.22.1.
- Las GitHub Actions de checkout y setup-node están fijadas por SHA completo.
- CI ejecuta npm audit --audit-level=high, lint, typecheck, pruebas con cobertura, build y auditoría de dependencias de producción.
- Ejecutar auditorías semanalmente y antes de cada release.
- Actualizar dependencias de forma deliberada, revisar lockfile y ejecutar pruebas.
- No aplicar npm audit fix --force sin evaluar cambios de major.
- Actual Budget se fija en Compose a una versión explícita; actualizaciones requieren backup y pruebas.

## Sobre “libre de vulnerabilidades”

No puede garantizarse ausencia de vulnerabilidades para siempre. Las bases de avisos pueden retrasarse, pueden existir fallos aún sin CVE y las dependencias indirectas también cuentan. Un npm audit sin hallazgos refleja únicamente los avisos conocidos del árbol de paquetes y el umbral elegido en el momento del análisis. CI debe revisarse antes de cerrar P0.
