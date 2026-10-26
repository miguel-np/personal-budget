# Instalación: Windows + WSL2

Esta guía describe una instalación local reproducible. La shell web incorpora resumen financiero, consulta y filtrado de movimientos, registro manual, importación CSV con previsualización, informes comparativos y seguimiento de presupuestos. Las escrituras pasan por la API local y requieren una acción explícita.

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

Desde la raíz, crea primero los directorios de datos con tu usuario para que Docker no los deje propiedad de root:

~~~bash
mkdir -p .local/actual-server-data .local/actual-api .local/backups
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

Abre http://127.0.0.1:5173. La aplicación usa solo la API local: Resumen, Movimientos, Informes, Presupuestos y Configuración. El Asistente aparece como no conectado y no envía movimientos a ningún modelo. Para registrar movimientos e importar extractos, revisa la previsualización y confirma la operación; el CSV se procesa en el navegador y la conciliación final la realiza Actual Budget.

## 5. IA local, MCP y recuperación

Para activar IA opcional, instala Ollama local, descarga el modelo elegido y configura AI_ENABLED=true y OLLAMA_MODEL en .env. Solo se permiten endpoints loopback; si la IA no está disponible la gestión financiera sigue funcionando.

MCP se lanza por stdio con npm run mcp:serve después de arrancar la API. No abre un puerto de red y sus herramientas son de solo lectura.

Antes de actualizaciones o importaciones masivas, ejecuta npm run backup:actual. Para restaurar, ejecuta npm run restore:actual -- <ruta-de-copia>. Compara cuentas, categorías y movimientos en una instancia aislada; la integridad del archivo no demuestra por sí sola que la restauración sea funcional.

## 6. Validar calidad

~~~bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:runtime:lifecycle
npm run audit
npm run audit:production
~~~

El comando `npm run test:runtime:lifecycle` necesita que los puertos 3000 y 4173 estén libres. Detén antes cualquier instancia de desarrollo o de uso diario; la prueba utiliza un presupuesto no configurado y un directorio temporal, sin conectar con Actual ni modificar datos financieros.

La CI ejecuta los controles en Linux y en Windows nativo. Para cerrar la validación de instalación también hay que ejecutar estos comandos en un checkout limpio de WSL2 y completar la prueba opcional de aceptación con un presupuesto de prueba de Actual. Un workflow Windows verde no prueba por sí solo la integración WSL2 ni el acceso a un servidor Actual real.


## 7. Matriz de aceptación: Windows nativo y WSL2

### Windows nativo

Desde PowerShell, en un checkout limpio del repositorio, ejecuta:

~~~powershell
node --version
npm --version
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
~~~

La versión esperada de Node es v24.22.1. El workflow `windows-quality` ejecuta esta instalación y los mismos controles en un runner `windows-latest`; comprueba que su ejecución asociada a la PR haya terminado en verde.

### WSL2

Comprueba desde PowerShell:

~~~powershell
wsl --status
wsl -l -v
~~~

La distribución usada debe indicar versión 2. Guarda el checkout en el filesystem Linux de la distribución (por ejemplo, `~/projects/personal-budget`) y, desde su raíz, ejecuta:

~~~bash
nvm install
nvm use
node --version
npm --version
npm ci
docker compose config --quiet
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:runtime:lifecycle
npm run audit
npm run audit:production
~~~

Antes del smoke de runtime, detén otras instancias de la aplicación y comprueba que los puertos 3000 y 4173 estén libres. La prueba arranca/parada la aplicación dos veces con un presupuesto sintético no configurado y un directorio temporal; no debe conectarse a una cuenta de Actual ni modificar datos financieros reales.

Después, valida el contenedor y la API con las secciones anteriores. Registra las pruebas manuales con un presupuesto exclusivamente sintético; no uses datos financieros reales para una importación de validación.

**Estado de validación:** la CI automatizada crea un servidor Actual aislado con contraseña exclusiva de CI y un presupuesto sintético; verifica la cuenta, las categorías, los identificadores, las fechas y los importes de las transacciones después de parar y volver a arrancar el contenedor, además de cubrir actualización y recuperación. Esto prueba la persistencia en el entorno de aceptación automatizado, pero no demuestra que la instalación se haya ejecutado en una distribución WSL2 concreta ni valida una instancia de Actual local del usuario. La aceptación manual de Windows + WSL2 sigue pendiente hasta ejecutar y registrar el flujo en ese entorno; no marques la issue de instalación como terminada antes de hacerlo.

## 7. Resolución de problemas

### Puertos ocupados

Los procesos usan estos puertos por defecto: Actual `5006`, API `3000`, Vite `5173` y Vite preview `4173`. En WSL, identifica el proceso que escucha antes de detenerlo:

~~~bash
ss -ltnp | grep -E ':(3000|4173|5006|5173)\\b' || true
docker compose ps
docker compose logs --tail=100 actual
~~~

En PowerShell puedes inspeccionar puertos con:

~~~powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3000,4173,5006,5173 }
~~~

Vite usa `strictPort`: si 5173/4173 está ocupado, no elige otro puerto automáticamente. Libera el puerto o actualiza el puerto y los orígenes permitidos de forma coherente. Conserva los servicios ligados a `127.0.0.1`; no los publiques en `0.0.0.0` ni abras puertos al LAN.

### Docker, memoria y Actual

Si Actual no inicia, consulta `docker compose ps` y `docker compose logs --tail=100 actual`. Comprueba que Docker Desktop tiene integración con la distribución WSL2 correcta y suficiente memoria asignada para el contenedor. No borres `.local/actual-server-data` como método de reparación: contiene los datos persistentes de Actual. Para reiniciar el servicio, usa `docker compose restart actual` y vuelve a comprobar la interfaz en `http://127.0.0.1:5006`.

### Permisos y dependencias

Guarda el checkout en el filesystem Linux y ejecuta los comandos de Node con tu usuario normal; evita `sudo npm ci`, que puede crear archivos propiedad de root. Si aparece `EACCES`, inspecciona primero `ls -ld . .local` y corrige únicamente los archivos del proyecto afectados. Tras modificar dependencias, usa `npm ci` para respetar el lockfile y vuelve a ejecutar los controles de calidad.

### Ollama opcional

La aplicación financiera no necesita Ollama: `AI_ENABLED=false` y `MCP_ENABLED=false` son los valores de plantilla. Si en el futuro habilitas la IA local, consulta `ollama --version`, `ollama list` y `curl http://127.0.0.1:11434/api/tags`; configura el modelo solo después de revisar sus requisitos de memoria y almacenamiento. Mantén el endpoint en loopback y no uses un endpoint remoto para el requisito local-first.

## 8. IA local (opcional, P2)

La integración con Ollama aún no está conectada a la shell P0. Para prepararla, instala Ollama desde la [web oficial](https://ollama.com/download) y consulta su [API](https://docs.ollama.com/api). La descarga del modelo requiere red; no configures endpoints alojados si el requisito es mantener las consultas en el equipo.


## 9. Prueba de aceptación con un presupuesto local existente (opcional)

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


## Modo diario y diagnóstico

Tras completar la configuración inicial, utiliza el siguiente flujo en WSL2:

~~~bash
npm ci
npm run doctor
npm run start:local
~~~

Abre `http://127.0.0.1:4173`. El comando compila la aplicación, inicia la API y sirve el frontend de producción. Ctrl+C realiza el apagado coordinado. Si Actual aún no está listo o falta el presupuesto, la shell presenta un estado accionable sin inventar datos; Ollama es opcional.

`npm run doctor` revisa la baseline de Node/npm, la configuración, Docker/Actual y la disponibilidad de API, web y asistente. Identifica variables que necesitan corrección sin imprimir valores sensibles. Consulta [Operación local](operations.md) para comprobar readiness, recuperación tras reiniciar WSL2 y procedimientos de parada.
