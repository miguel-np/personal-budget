# Instalación: Windows + WSL2

Esta guía prepara los componentes base para ejecución local. La shell web es provisional; dashboard y registro completo de movimientos se implementarán en P1.

## Requisitos

- Windows con WSL2 y una distribución Linux; Ubuntu recomendado.
- Docker Desktop con integración WSL2 o Docker Engine + Compose en WSL.
- Git.
- Node.js 24.22.1 y npm compatible.
- Ollama solo para la fase de IA opcional (P2).

Desde PowerShell:

~~~powershell
wsl --status
wsl -l -v
~~~

Guarda el repositorio en el filesystem Linux, por ejemplo ~/projects/personal-budget, no en /mnt/c/..., para reducir problemas de rendimiento y permisos.

## 1. Instalar Node.js y dependencias

Instala nvm para Linux siguiendo su documentación oficial. Desde WSL, en la raíz del repositorio:

~~~bash
nvm install
nvm use
node --version
npm --version
npm ci
~~~

Node debe indicar v24.22.1. El archivo package-lock.json está versionado; npm ci instala el grafo bloqueado y falla si manifiesto y lockfile no coinciden.

## 2. Instalar Docker y ejecutar Actual Budget

Instala Docker Desktop y activa la integración WSL2, o instala Docker Engine/Compose en la distribución. Comprueba:

~~~bash
docker --version
docker compose version
~~~

Desde la raíz:

~~~bash
docker compose up -d
docker compose ps
~~~

Compose usa actualbudget/actual-server:26.10.0, publica el servicio en 127.0.0.1:5006 y guarda los datos en .local/actual-server-data. Abre http://localhost:5006 desde Windows y completa el inicio de Actual. No borres el directorio de datos para reparar el contenedor.

Consulta la [guía oficial de instalación de Actual](https://actualbudget.org/docs/install/).

## 3. Configurar la API local

Copia y edita la plantilla:

~~~bash
cp .env.example .env
~~~

Configura ACTUAL_BUDGET_ID con el Sync ID del presupuesto que aparece en los ajustes avanzados de Actual. ACTUAL_SERVER_PASSWORD, si configuras contraseña en el servidor, no es la contraseña del banco. Mantén ACTUAL_SERVER_URL en loopback.

Arranca la API:

~~~bash
npm run dev:api
~~~

En otra terminal:

~~~bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
~~~

/ready indica si hay un presupuesto configurado, pero no sustituye una prueba completa de conectividad con Actual. La API accede al presupuesto mediante @actual-app/api, no mediante rutas REST inventadas.

## 4. Arrancar la shell web

En otra terminal:

~~~bash
npm run dev:web
~~~

Abre http://127.0.0.1:5173. La shell provisional consulta el endpoint local de salud. El resto de pantallas se implementará en P1.

## 5. Validar calidad

~~~bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
~~~

No cierres P0 hasta confirmar que los comandos pasan en un checkout limpio y que el adaptador se ha ensayado con una instancia local de Actual y un presupuesto de prueba.

## 6. IA local (opcional, P2)

La integración con Ollama aún no está conectada a la shell P0. Para prepararla, instala Ollama desde la [web oficial](https://ollama.com/download) y consulta su [API](https://docs.ollama.com/api). La descarga del modelo requiere red; no configures endpoints alojados si el requisito es mantener las consultas en el equipo.


## 7. Prueba de aceptación con un presupuesto local existente (opcional)

Cuando Actual Budget esté iniciado y hayas creado/configurado un presupuesto de prueba, puedes probar el adaptador real en modo solo lectura. Esta prueba consulta cuentas, categorías y movimientos del año configurado, pero no crea ni modifica transacciones.

~~~bash
ACTUAL_SERVER_URL=http://127.0.0.1:5006 \
ACTUAL_BUDGET_ID='<sync-id-de-tu-presupuesto-de-prueba>' \
PERSONAL_BUDGET_RUN_ACTUAL_ACCEPTANCE=1 \
npm test -- services/actual-adapter/tests/actual-live-acceptance.test.ts
~~~

Si el servidor tiene contraseña, añade `ACTUAL_SERVER_PASSWORD` en el entorno antes de ejecutar la prueba; no la pongas en la línea de comandos ni la compartas. Si hay cifrado end-to-end del presupuesto, esta prueba necesitará una ampliación para recibir la contraseña de cifrado. La suite normal omite esta prueba cuando no se activa explícitamente.

## Datos privados

Usa primero un presupuesto de prueba. Nunca añadas extractos, bases de datos, backups, .env ni logs sensibles al repositorio. No introduzcas credenciales bancarias en Actual, Ollama, MCP ni personal-budget.
