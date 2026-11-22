# Instalación paso a paso: Windows + WSL2

Esta guía está escrita para alguien que instala Personal Budget por primera vez. Sigue el orden indicado y no omitas la configuración de las copias de seguridad.

Personal Budget se ejecuta en tu equipo. Actual Budget almacena los datos financieros y Personal Budget añade una interfaz y funciones de análisis.

## Antes de empezar

Necesitas:

- Un equipo con Windows 11 y WSL2. Ubuntu es la distribución recomendada.
- Docker Desktop con integración WSL2 activada, o Docker Engine y Compose instalados dentro de Ubuntu.
- Git.
- Node.js 26.13.1 y npm 11.20.0.
- Conexión a Internet para descargar dependencias e imágenes durante la instalación.

Ollama, SearXNG y un cliente MCP son opcionales. No los instales para empezar: la aplicación financiera básica no los necesita.

Consulta la [baseline de versiones](version-baseline.md) para conocer las versiones fijadas.

## 1. Preparar WSL2

Abre PowerShell en Windows y comprueba WSL:

```powershell
wsl --status
wsl -l -v
```

Si todavía no tienes WSL, sigue la [guía oficial de instalación de WSL](https://learn.microsoft.com/windows/wsl/install). Instala Ubuntu y vuelve a comprobar que la distribución utiliza la versión 2.

Abre Ubuntu desde el menú Inicio. Los comandos siguientes se ejecutan en esa terminal, salvo que se indique expresamente PowerShell.

## 2. Instalar herramientas en Ubuntu

Instala Git y las herramientas básicas con el gestor de paquetes de tu distribución. En Ubuntu:

```bash
sudo apt update
sudo apt install -y git curl build-essential
```

Instala nvm siguiendo sus [instrucciones oficiales](https://github.com/nvm-sh/nvm#installing-and-updating). Cierra y vuelve a abrir la terminal si el instalador lo solicita.

Comprueba que nvm responde:

```bash
command -v nvm
```

## 3. Descargar el proyecto

Guarda el repositorio dentro del filesystem Linux de WSL, no en `/mnt/c`. Por ejemplo:

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/miguel-np/personal-budget.git
cd personal-budget
```

Comprueba que estás en la raíz del repositorio:

```bash
pwd
ls
```

Deberías ver, entre otros, `package.json`, `compose.yaml`, `.nvmrc`, `apps`, `services`, `packages` y `docs`.

## 4. Instalar Node.js y dependencias

Desde la raíz del repositorio:

```bash
nvm install
nvm use
node --version
npm --version
npm ci
```

Resultados esperados:

- Node: `v26.13.1`.
- npm: `11.20.0`.

Si las versiones no coinciden, no continúes: comprueba que nvm está activo y que estás dentro de la carpeta del proyecto. `npm ci` instala exactamente las dependencias del lockfile; no lo sustituyas por `npm install` para una instalación reproducible.

## 5. Instalar y arrancar Actual Budget

Instala Docker Desktop y activa la integración con tu distribución Ubuntu, o configura Docker Engine/Compose en WSL. Sigue la [documentación oficial de Docker Desktop con WSL](https://docs.docker.com/desktop/features/wsl/).

Comprueba Docker:

```bash
docker --version
docker compose version
docker info
```

Si `docker info` falla, revisa la integración WSL2 o el servicio Docker antes de continuar.

Crea los directorios persistentes antes del primer arranque:

```bash
mkdir -p .local/actual-server-data .local/actual-api .local/backups
```

Inicia únicamente el servicio Actual:

```bash
docker compose up -d actual
docker compose ps
```

Abre **http://localhost:5006** en el navegador de Windows. Completa la configuración inicial de Actual y crea un presupuesto de prueba o el presupuesto que quieras utilizar. No introduzcas credenciales bancarias: Actual no las necesita para esta integración.

En los ajustes avanzados del presupuesto, localiza su **Sync ID**. Lo necesitarás en el siguiente paso.

**Importante sobre versiones:** Compose conserva Actual Budget 26.10.0 como versión de origen para que las actualizaciones pasen por el procedimiento seguro. La API del proyecto está fijada a 26.11.0. No cambies manualmente el tag de la imagen ni ejecutes un `docker pull` para saltarte el backup y las comprobaciones. Utiliza [Actualizaciones seguras](safe-updates.md).

Consulta también la [instalación oficial de Actual Budget](https://actualbudget.org/docs/install/).

## 6. Configurar Personal Budget

Crea el fichero local de configuración:

```bash
cp .env.example .env
```

Abre `.env` con un editor de texto y establece:

- `ACTUAL_BUDGET_ID`: el Sync ID del presupuesto de Actual que acabas de crear o seleccionar.
- `ACTUAL_SERVER_PASSWORD`: solo si configuraste una contraseña para el servidor Actual. No es la contraseña del banco.
- Mantén `ACTUAL_SERVER_URL=http://127.0.0.1:5006` y `APP_HOST=127.0.0.1`.

No publiques ni compartas `.env`. Está excluido de Git porque puede contener credenciales.

El resto de valores puede conservar los defaults de `.env.example`. Las funciones de IA y búsqueda web deben permanecer desactivadas al principio.

## 7. Alinear el servidor Actual con el SDK

El proyecto instala `@actual-app/api` 26.11.0. Compose inicia inicialmente Actual 26.10.0 de forma deliberada: esa es la versión de origen del procedimiento de actualización segura. **Antes de iniciar Personal Budget por primera vez, completa la transición verificada a 26.11.0** para mantener alineadas las versiones del servidor y del SDK.

Ejecuta primero el preflight:

```bash
npm run update:actual -- preflight --to actualbudget/actual-server:26.11.0
```

Si termina correctamente, aplica la actualización:

```bash
npm run update:actual -- update --to actualbudget/actual-server:26.11.0 --confirm
```

El script crea y verifica un backup cifrado antes de cambiar la imagen y guarda la versión de destino en `.env`. Si el preflight indica que `ACTUAL_IMAGE` está exportada en la terminal, ejecuta `unset ACTUAL_IMAGE` y repite el preflight. No cambies manualmente el tag de Compose.

Si Actual ya está en 26.11.0, omite este paso. Ante cualquier error, detente y sigue [Actualizaciones seguras](safe-updates.md); no borres datos ni backups.

## 8. Comprobar la instalación

Ejecuta el diagnóstico:

```bash
npm run doctor
```

Lee el resultado. Si indica que Actual no responde, comprueba el contenedor con `docker compose ps` y sus logs con:

```bash
docker compose logs --tail=100 actual
```

No compartas logs sin revisar y sanear su contenido. No borres `.local` para intentar reparar el servicio.

## 9. Iniciar Personal Budget para uso diario

Desde la raíz del proyecto:

```bash
npm run start:local
```

Este comando compila el proyecto, inicia la API y sirve el frontend compilado. Abre:

**http://127.0.0.1:4173**

La API local utiliza el puerto 3000. No necesitas abrirla manualmente para usar la interfaz.

Para detener Personal Budget, vuelve a la terminal donde se está ejecutando y pulsa `Ctrl+C`. El runtime coordina la parada de la API y la web. Actual puede permanecer activo.

En los siguientes días, el arranque habitual es:

```bash
cd ~/projects/personal-budget
nvm use
docker compose up -d actual
npm run doctor
npm run start:local
```

No necesitas volver a ejecutar `npm ci` en cada arranque.

## 10. Primeros pasos dentro de la aplicación

1. Abre **Resumen** y comprueba el periodo y la divisa.
2. Entra en **Cuentas** y verifica que aparecen las cuentas del presupuesto elegido.
3. En **Movimientos**, comprueba que aparecen operaciones del periodo esperado.
4. Revisa **Presupuestos** e **Informes**.
5. Ajusta el ámbito de cuentas y la divisa si lo necesitas.
6. Consulta la [guía de uso](usage.md) y el [catálogo de funcionalidades](features.md).

Si no aparecen cuentas o movimientos, vuelve a comprobar `ACTUAL_BUDGET_ID`, `ACTUAL_SERVER_URL` y el estado del contenedor. No cambies datos en Actual para intentar corregir una conexión.

## 11. Copias de seguridad: hazlo antes de depender de tus datos

Personal Budget dispone de backup cifrado unificado que incluye el volumen de Actual, los almacenes propios inventariados y los documentos binarios admitidos.

Antes de utilizarlo como sistema habitual:

1. Lee [Backup y restauración](backup-restore.md).
2. Conserva la clave de cifrado separada del equipo o checkout.
3. Crea una copia con `npm run backup:actual` siguiendo los requisitos de parada.
4. Planifica una restauración de ensayo en un entorno aislado con datos sintéticos.

La restauración sustituye datos y requiere confirmación explícita. Nunca hagas pruebas destructivas con tu único presupuesto personal.

## 12. Opcionales: IA, búsqueda web y MCP

No son necesarios para la instalación básica:

- **Ollama:** instala un runtime local y un modelo compatible si quieres utilizar el asistente. Consulta [IA local](local-ai.md).
- **Búsqueda web:** requiere SearXNG, configuración separada y consentimiento para cada consulta. Consulta [Búsqueda web](web-search.md).
- **MCP:** permite conectar un cliente compatible a herramientas de lectura por stdio. Consulta [MCP](mcp.md).

Activa estas funciones solo después de entender qué datos procesan y qué sale del equipo.

## Solución de problemas iniciales

| Problema | Qué comprobar |
|---|---|
| `nvm: command not found` | Revisa la instalación de nvm y vuelve a abrir Ubuntu. |
| Node/npm no coinciden | Ejecuta `nvm use` desde la raíz del repositorio y comprueba `.nvmrc`. |
| Docker no responde | Comprueba Docker Desktop, la integración WSL2 y `docker info`. |
| Actual no abre | Comprueba `docker compose ps`, el puerto 5006 y los logs saneados. |
| No aparecen cuentas | Comprueba el Sync ID en `ACTUAL_BUDGET_ID` y la contraseña del servidor si existe. |
| Puerto ocupado | Identifica primero qué proceso lo utiliza; no mates procesos desconocidos. |
| Directorio .local inaccesible | Consulta la sección de permisos en [Resolución de problemas](troubleshooting.md). |

## Datos privados

No subas a Git ni compartas:

- `.env`, contraseñas o claves de cifrado.
- CSV/OFX bancarios, movimientos, saldos o identificadores personales.
- Bases de datos de Actual o directorios `.local`.
- Backups, documentos justificativos o logs sin sanear.

Para solicitar ayuda, comparte versiones, comandos ejecutados y errores saneados. Consulta [Privacidad](privacy.md) y [Seguridad](../SECURITY.md).
