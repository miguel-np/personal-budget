# Desarrollo para principiantes

Esta guía explica cómo orientarte en el repositorio y ejecutar el proyecto en modo desarrollo. Si solo quieres utilizar Personal Budget, sigue [Instalación](installation.md) y no necesitas estos comandos.

## 1. Preparar el entorno

Entorno objetivo: Windows + WSL2 con Ubuntu, Node.js 26.13.1, npm 11.20.0, Git y Docker/Compose.

Mantén el checkout dentro del filesystem Linux de WSL, por ejemplo `~/projects/personal-budget`. No uses datos financieros reales en pruebas, fixtures, capturas ni logs.

## 2. Entender las carpetas

```text
personal-budget/
├── apps/
│   └── web/                 # Interfaz React + Vite
├── services/
│   ├── api/                 # API local Fastify
│   ├── actual-adapter/      # Integración oficial con Actual
│   └── mcp/                 # Servidor MCP por stdio
├── packages/
│   └── finance-core/        # Dominio financiero y cálculos puros
├── scripts/                 # Diagnóstico, runtime, backup y actualización
├── docs/                    # Documentación funcional y técnica
├── compose.yaml             # Servicio Actual Budget
├── package.json             # Workspaces y comandos raíz
└── package-lock.json        # Árbol reproducible de dependencias
```

### Qué hace cada workspace

| Workspace | Responsabilidad | Qué no debe hacer |
|---|---|---|
| `packages/finance-core` | Tipos neutrales, contratos financieros, validaciones y cálculos deterministas. | Depender de React, Fastify o del SDK de Actual. |
| `services/actual-adapter` | Encapsular `@actual-app/api`, mapear datos y errores de Actual. | Propagar tipos crudos del SDK a la web o al núcleo. |
| `services/api` | Exponer endpoints Fastify, validar entradas, aplicar ámbito y coordinar dominio/adaptador. | Acceder directamente a SQLite de Actual o permitir herramientas arbitrarias a modelos. |
| `apps/web` | Interfaz React/Vite y consumo de la API local. | Conectarse directamente al almacén financiero o a proveedores externos. |
| `services/mcp` | Publicar herramientas y prompts MCP acotados sobre la API local. | Ofrecer shell, SQL libre, filesystem o escrituras no autorizadas. |

Para entender dependencias y flujos, lee [Arquitectura](architecture.md) y [Contratos del proveedor](provider-contracts.md).

## 3. Instalar dependencias

```bash
nvm install
nvm use
npm ci
```

## 4. Ejecutar en modo desarrollo

Para desarrollar la interfaz y la API, utiliza una sola terminal desde la raíz:

```bash
npm run dev
```

Este comando inicia `dev:api` y `dev:web` en paralelo. La API compila primero `finance-core` y `actual-adapter`; después arranca Fastify con recarga de cambios. Vite sirve la interfaz con recarga en caliente.

Abre http://127.0.0.1:5173. La API utiliza http://127.0.0.1:3000.

Si necesitas datos de Actual Budget, inicia el contenedor en otra terminal antes o durante el desarrollo:

```bash
docker compose up -d actual
```

Actual no se inicia automáticamente con `npm run dev`, porque es un servicio persistente y puede contener datos financieros. Si API o Vite terminan inesperadamente, el supervisor detiene el otro servicio. Pulsa `Ctrl+C` para cerrar ambos. El comando conserva el comportamiento en Windows, WSL2 y Linux.

También puedes iniciar cada parte por separado con `npm run dev:api` y `npm run dev:web`. Para el uso cotidiano sin recarga en caliente, utiliza `npm run start:local`, que compila y sirve el runtime local de producción en el puerto 4173.

## 5. Comandos del proyecto

| Comando | Qué hace |
|---|---|
| `npm ci` | Instala las dependencias exactas del lockfile. |
| `npm run doctor` | Diagnostica requisitos, configuración y servicios. |
| `npm run dev` | Inicia API y frontend en paralelo desde una sola terminal. |
| `npm run dev:api` | Compila las dependencias internas e inicia Fastify en desarrollo. |
| `npm run dev:web` | Inicia Vite con recarga en caliente. |
| `npm run start:local` | Compila y arranca el runtime local de uso diario. |
| `npm run start:built` | Arranca el runtime ya compilado, sin reconstruir. |
| `npm run lint` | Ejecuta ESLint. |
| `npm run typecheck` | Comprueba tipos de API, web y tests y construye dependencias internas. |
| `npm run test` | Ejecuta Vitest. |
| `npm run test:coverage` | Ejecuta Vitest con cobertura y umbrales configurados. |
| `npm run check` | Agrupa lint, typecheck y tests con cobertura. |
| `npm run build` | Construye los workspaces de producción. |
| `npm run audit` | Audita dependencias con umbral moderate. |
| `npm run audit:production` | Audita solo dependencias de producción. |
| `npm run setup:e2e` | Instala Chromium para Playwright en el entorno actual. |
| `npm run test:e2e` | Ejecuta Playwright contra el frontend compilado y API sintética. |
| `npm run validate` | Ejecuta check, build, auditorías y E2E en secuencia. |
| `npm run benchmark:api` | Ejecuta benchmark sintético de API; no usar datos reales. |
| `npm run mcp:serve` | Inicia el servidor MCP por stdio; requiere API local. |

Backup, restauración y actualización de Actual tienen efectos sobre datos persistentes. No los ejecutes como comandos de desarrollo sin leer sus guías específicas.

## 6. Validación antes de proponer cambios

Desde la raíz del repositorio, prepara las dependencias y el navegador una vez por entorno:

```bash
npm ci
npm run setup:e2e
```

Durante el desarrollo, valida los cambios con:

```bash
npm run check
```

`check` ejecuta ESLint, la comprobación de tipos y Vitest con cobertura. Antes de abrir una PR, ejecuta la validación completa:

```bash
npm run validate
```

`validate` vuelve a ejecutar `check` y añade el build de producción, las auditorías de dependencias y Playwright E2E. La repetición es intencionada: proporciona un único control completo y reproducible antes de publicar cambios.

`setup:e2e` instala Chromium explícitamente; no forma parte de `validate` para evitar descargas implícitas o cambios del entorno durante una validación. Si Chromium ya está instalado, no necesitas repetirlo.

La suite ordinaria usa datos sintéticos y no necesita una cuenta bancaria, un presupuesto personal ni un modelo Ollama real. Las pruebas live contra Actual, Ollama o SearXNG son optativas y deben utilizar entornos aislados y datos sintéticos.

El alcance exacto de cobertura de líneas, las exclusiones y la diferencia entre Vitest, `node:test` y Playwright están documentados en [Cobertura de pruebas](test-coverage.md). No interpretes el porcentaje global como cobertura de componentes visuales ni como certificación de seguridad.

## 7. Cómo abordar un cambio pequeño

1. Identifica la funcionalidad y lee su documentación.
2. Localiza el componente web, ruta API o contrato de dominio correspondiente.
3. Comprueba si la lógica pertenece a `finance-core`, al adaptador, a la API o a la web.
4. Añade primero una prueba que reproduzca el comportamiento esperado o el defecto.
5. Implementa el cambio mínimo dentro de la responsabilidad correcta.
6. Ejecuta las pruebas relevantes y los controles generales.
7. Revisa el diff para detectar archivos accidentales, secretos o datos reales.
8. Actualiza la documentación y el changelog cuando cambie el comportamiento visible.

## 8. Reglas que no debes romper

- Actual Budget sigue siendo la fuente de verdad financiera.
- No accedas directamente a SQLite ni a los ficheros internos de Actual.
- No importes `@actual-app/api` fuera de `services/actual-adapter` y las excepciones operativas documentadas.
- No envíes movimientos, saldos ni datos financieros a proveedores externos.
- No registres datos sensibles en logs ni fixtures.
- No permitas que un modelo ejecute código, shell o SQL arbitrario.
- Toda escritura debe validar entradas y conservar previsualización/confirmación cuando corresponda.
- Mantén los cálculos monetarios exactos y distingue los datos desconocidos de cero.
- Añade pruebas para límites, fallos y casos de divisas/transferencias.
- No añadas dependencias ni workflows de CI sin justificar y aprobar su necesidad.

Consulta [CONTRIBUTING](../CONTRIBUTING.md), [Privacidad](privacy.md), [Seguridad](../SECURITY.md) y [Mantenibilidad](maintainability.md) antes de abrir una PR.


## Gates de arquitectura y documentación

Antes de abrir una PR, ejecuta:

```bash
npm run quality:repo:test
npm run quality:repo
```

Estas comprobaciones verifican límites entre workspaces, rutas Markdown locales, comandos npm documentados y presupuestos de tamaño para ficheros nuevos o modificados. En CI, la comparación de tamaño utiliza el commit base del PR. No acceden a Actual Budget ni requieren credenciales o datos financieros.
