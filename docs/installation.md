# Instalación: Windows + WSL2

Esta guía prepara los componentes base en un equipo Windows con WSL2. **No instala la aplicación web `personal-budget`**, ya que el código de esa aplicación aún no forma parte de este paquete documental. Los pasos de Actual Budget y Ollama pueden realizarse antes de implementar el frontend.

## Requisitos

- Windows con WSL2 y una distribución Linux, preferiblemente Ubuntu.
- Docker Desktop con integración WSL2 activada, o Docker Engine + Docker Compose dentro de WSL.
- Git.
- Node.js LTS y un gestor de paquetes para el desarrollo cuando exista la aplicación.
- Ollama instalado localmente para habilitar IA.

Comprueba WSL desde PowerShell:

```powershell
wsl --status
wsl -l -v
```

Guarda el repositorio y los datos de desarrollo en el sistema de archivos Linux, por ejemplo `~/projects/personal-budget`, en lugar de `/mnt/c/...`, para evitar problemas de rendimiento y permisos.

## 1. Instalar Docker

Instala Docker Desktop para Windows y activa la integración con tu distribución WSL, o instala Docker Engine/Compose dentro de WSL. Verifica la instalación desde Ubuntu:

```bash
docker --version
docker compose version
docker ps
```

## 2. Ejecutar Actual Budget localmente

Desde una terminal WSL crea un directorio persistente:

```bash
mkdir -p ~/personal-budget/actual-data
cd ~/personal-budget
```

Para una prueba local, puedes iniciar el servidor oficial de Actual Budget con Docker:

```bash
docker run -d \
  --name actual-budget \
  --restart unless-stopped \
  -p 127.0.0.1:5006:5006 \
  -v "$PWD/actual-data:/data" \
  actualbudget/actual-server:latest
```

Después abre [http://localhost:5006](http://localhost:5006) en el navegador de Windows y completa la configuración de Actual. La ruta `actual-data` contiene datos privados: no la incluyas en Git ni la compartas. Para una instalación duradera, fija una versión de imagen probada en lugar de depender indefinidamente de `latest`, y consulta las instrucciones oficiales de actualización.

Documentación oficial: [Installing Actual](https://actualbudget.org/docs/install/).

## 3. Importar datos de prueba

Crea un presupuesto vacío y usa datos ficticios para probar el flujo antes de importar datos reales. Los formatos admitidos por Actual incluyen CSV, QIF, OFX, QFX y CAMT. OFX/QFX suelen facilitar la detección de duplicados. Consulta [Transacciones e importaciones](transactions-and-imports.md).

## 4. Instalar Ollama

Instala Ollama en el mismo entorno local desde el que se ejecutará el backend (recomendación inicial: WSL). Sigue las instrucciones oficiales vigentes: [Ollama](https://ollama.com/download) y [documentación de API](https://docs.ollama.com/api).

Comprueba el servicio:

```bash
ollama --version
ollama list
curl http://127.0.0.1:11434/api/tags
```

Descarga un modelo que quepa en tu equipo y cuya licencia sea compatible con tu uso. No se fija un modelo por defecto porque el rendimiento y la compatibilidad con tool calling dependen del hardware y de la versión del modelo. La descarga necesita red; la inferencia local ordinaria puede funcionar sin enviar prompts a un proveedor remoto.

## 5. Preparar el código de `personal-budget`

Cuando la implementación se añada al repositorio, el proceso esperado será:

```bash
# Dentro de la raíz del repositorio, una vez incorporado el código
cp .env.example .env
# Instalar dependencias con el lockfile del proyecto
# Ejecutar migraciones o comprobaciones iniciales si las implementa el proyecto
# Arrancar la aplicación con el script documentado en package.json
```

Los comandos definitivos (`pnpm install`, `pnpm dev`, etc.) se añadirán después de decidir el gestor de paquetes y validar los scripts reales. No ejecutes comandos de proyecto que todavía no existan.

## 6. Comprobaciones iniciales

- Actual responde en `http://localhost:5006`.
- Ollama responde en `http://127.0.0.1:11434` desde el entorno del backend.
- Los puertos están publicados solo en localhost.
- La app puede consultar un presupuesto de prueba a través de `@actual-app/api`.
- El modelo responde sin proveedor en la nube.
- La importación de prueba no crea movimientos duplicados.
- Existe una copia de seguridad y se ha comprobado la restauración con un presupuesto de prueba.

## Datos privados

No actives sincronización bancaria automática para esta configuración inicial. Importa extractos descargados manualmente y no introduzcas credenciales bancarias en Actual, Ollama, MCP ni `personal-budget`.
