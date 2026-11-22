# Operación local

Este documento describe cómo iniciar, detener y comprobar los servicios una vez completada la instalación.

## Servicios

| Servicio | Puerto | Cuándo se necesita |
|---|---:|---|
| Actual Budget | 5006 | Siempre que la API tenga que consultar el presupuesto. |
| API Fastify | 3000 | Para todas las funciones de Personal Budget. |
| Web de desarrollo (Vite) | 5173 | Durante desarrollo con `npm run dev` o `npm run dev:web`. |
| Web compilada (runtime diario) | 4173 | Para uso cotidiano con `npm run start:local`. |
| Ollama | 11434 | Solo si se activa IA local. |
| MCP | stdio, sin puerto TCP | Solo cuando un cliente MCP compatible lo inicia. |
| SearXNG | 8080 por defecto en configuración local | Solo si se activa investigación web y se configura el proveedor. |

Los servicios de Personal Budget y Actual deben permanecer ligados a loopback. No publiques sus puertos en LAN o Internet.

## Arranque diario

Desde WSL, en la raíz del repositorio:

```bash
nvm use
docker compose up -d actual
npm run doctor
npm run start:local
```

Abre http://127.0.0.1:4173. El runtime compila, inicia API y web y coordina el cierre. Para detenerlo, pulsa Ctrl+C en la terminal del runtime.

## Desarrollo

Desde la raíz del repositorio, inicia API y frontend en una sola terminal:

```bash
npm run dev
```

La web de Vite está en http://127.0.0.1:5173 y la API en http://127.0.0.1:3000. El supervisor inicia `dev:api` y `dev:web` en paralelo, muestra sus registros en la misma terminal y detiene el otro servicio si uno termina. Pulsa `Ctrl+C` para cerrar ambos.

Actual Budget no se inicia automáticamente. Cuando necesites probar la integración con un presupuesto de prueba, inicia el contenedor por separado:

```bash
docker compose up -d actual
```

También puedes iniciar cada parte por separado con `npm run dev:api` y `npm run dev:web`, cada una en su propia terminal. No ejecutes estas variantes junto con `npm run dev` ni con el runtime diario `npm run start:local`: comparten los puertos de la API.

## Diagnóstico y readiness

- `npm run doctor` comprueba versiones, configuración y disponibilidad de servicios sin imprimir secretos.
- `GET /health` comprueba que la API responde.
- `GET /ready` informa de si la API está lista y de si hay un presupuesto configurado.
- `not_configured` no significa que el proceso esté apagado.
- La ausencia de Ollama no debe impedir las funciones financieras deterministas.

## Parada y persistencia

Detén Personal Budget con Ctrl+C antes de backup o restauración. No mates procesos hijos de forma aislada y no borres los directorios persistentes para solucionar errores.

Actual puede seguir funcionando después de detener Personal Budget. Para detener solo el contenedor de Actual:

```bash
docker compose stop actual
```

Para volver a iniciarlo:

```bash
docker compose start actual
```

No utilices `docker compose down -v` como solución rutinaria: puede eliminar volúmenes administrados por Docker. El directorio persistente del proyecto está en `.local/actual-server-data`.

## Backup y restauración

El backup unificado requiere que la API esté parada y cubre el volumen de Actual, los nueve almacenes JSON propios inventariados y documentos binarios incluidos en el manifiesto. Lee [Backup y restauración](backup-restore.md) antes de ejecutar los comandos. Conserva la clave fuera del equipo y prueba restauraciones en un entorno aislado.

## Actualizaciones

Actual Budget se actualiza mediante [Actualizaciones seguras](safe-updates.md). No cambies el tag de Compose ni descargues una imagen nueva manualmente para saltarte el backup, el preflight o las pruebas de recuperación.

Actualiza un componente cada vez. Comprueba la compatibilidad de la versión del servidor y `@actual-app/api`, revisa el backup y ejecuta las pruebas aplicables antes de depender del nuevo runtime.

## Límites de aceptación

La CI usa servicios sintéticos y runners Linux/Windows; no demuestra por sí sola que un nuevo equipo tenga Docker, WSL2, permisos y conectividad configurados correctamente. La aceptación manual de Windows + WSL2 se registró para el entorno de referencia el 1 de noviembre de 2026. Cada instalación nueva debe seguir su propio diagnóstico y comprobar su presupuesto de prueba antes de utilizar datos importantes.
