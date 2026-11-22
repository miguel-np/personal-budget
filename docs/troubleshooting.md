# Resolución de problemas

Esta guía reúne comprobaciones seguras para los errores más habituales. Antes de cambiar configuración o borrar archivos, identifica el problema. **No borres `.local`, volúmenes Docker ni bases de datos para intentar reparar un servicio.**

## 1. La aplicación web no abre

Comprueba que el runtime está iniciado y que has abierto la dirección correcta:

- Uso diario: http://127.0.0.1:4173
- Desarrollo Vite: http://127.0.0.1:5173

Deja abierta la terminal donde ejecutas la aplicación. En desarrollo, `npm run dev` muestra los registros de API y Vite en esa misma terminal; si uno de los procesos termina, el supervisor detiene el otro. En uso diario, `npm run start:local` mantiene el runtime compilado activo.

Si la web no responde, revisa los mensajes de esa terminal y ejecuta `npm run doctor` en otra. Comprueba también que no haya otra instancia de Personal Budget ocupando los puertos 3000, 4173 o 5173. No mates procesos desconocidos para liberar un puerto.

## 2. La API no responde

La API local utiliza `127.0.0.1:3000`.

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/health` comprueba que la API responde. `/ready` informa del estado de configuración del presupuesto; un estado `not_configured` no significa que el proceso esté apagado.

Comprueba el puerto antes de detener procesos:

```bash
ss -ltnp | grep ':3000'
```

No mates procesos desconocidos. Si hay una instancia de Personal Budget en ejecución, deténla desde su terminal con Ctrl+C.

## 3. Actual Budget no abre

```bash
docker compose ps
docker compose logs --tail=100 actual
```

Comprueba que el contenedor está activo y que el puerto 5006 no está ocupado. Actual se publica en loopback, no en la red local.

No elimines `.local/actual-server-data` ni el contenedor con volúmenes para solucionar un fallo. Si necesitas recuperar datos, sigue el procedimiento de [backup y restauración](backup-restore.md).

## 4. Personal Budget no encuentra el presupuesto

Comprueba en `.env`:

- `ACTUAL_SERVER_URL=http://127.0.0.1:5006`
- `ACTUAL_BUDGET_ID` contiene el Sync ID correcto.
- `ACTUAL_SERVER_PASSWORD` coincide con la contraseña configurada en el servidor, si existe.

El Sync ID no es una contraseña. No inventes endpoints REST: la integración utiliza el SDK oficial `@actual-app/api`.

## 5. Error de permisos en .local

Crea los directorios con tu usuario antes de iniciar Docker:

```bash
mkdir -p .local/actual-server-data .local/actual-api .local/backups
```

Si Docker ya creó directorios propiedad de root y tu usuario no puede acceder, revisa primero qué rutas son propiedad del contenedor. Solo si confirmas que `.local` es el directorio de datos de este checkout y que no hay procesos escribiendo, puedes corregir la propiedad:

```bash
sudo chown -R "$(id -u):$(id -g)" .local
```

No ejecutes `npm ci` ni scripts Node con sudo. Los archivos creados por el contenedor pueden volver a quedar bajo el usuario del contenedor; no cambies permisos recursivamente fuera de `.local`.

## 6. Node.js o npm tienen una versión incorrecta

Desde la raíz del repositorio:

```bash
nvm install
nvm use
node --version
npm --version
```

Debes obtener Node 26.13.1 y npm 11.20.0. Si `nvm` no existe, revisa su instalación y vuelve a abrir Ubuntu.

## 7. Docker no responde desde WSL2

Comprueba `docker --version`, `docker compose version` y `docker info`. Si usas Docker Desktop, revisa que la integración WSL2 esté activada para tu distribución Ubuntu. No arranques dos motores Docker distintos sin saber cuál gestiona el contenedor de Actual.

## 8. Ollama no responde

Ollama es opcional. Comprueba:

```bash
ollama list
curl http://127.0.0.1:11434/api/tags
```

Verifica que `OLLAMA_MODEL` coincide con un modelo instalado y que `AI_ENABLED=true`. Si falla, desactiva la IA y continúa utilizando las funciones deterministas; el resto de la aplicación no debe depender del modelo.

## 9. La búsqueda web no funciona

La búsqueda requiere `AI_ENABLED=true`, `WEB_SEARCH_ENABLED=true`, un modelo compatible con tool calling y SearXNG accesible. Además, cada consulta necesita consentimiento explícito.

Un error de compatibilidad del modelo no debe provocar una búsqueda alternativa ni enviar una consulta no confirmada. Consulta [Búsqueda web](web-search.md) y revisa el proveedor sin compartir consultas privadas o logs sensibles.

## 10. La importación falla o aparecen duplicados

- Comprueba el formato y las columnas del archivo.
- Revisa fechas, separadores decimales y signo de cargos/abonos.
- Comienza con un periodo pequeño.
- Revisa la previsualización y los posibles duplicados.
- Haz backup antes de repetir una importación amplia.

No compartas el extracto real para pedir ayuda. Utiliza un ejemplo sintético que reproduzca el formato.

## 11. Los totales no coinciden

Comprueba que comparas el mismo periodo, ámbito de cuentas y divisa. Revisa transferencias internas, reembolsos, movimientos divididos, categorías ausentes y tipos de cambio manuales.

Los importes sin moneda conocida o sin conversión válida no se agregan como si fueran EUR. Un saldo desconocido no se sustituye por cero.

## 12. Información segura para solicitar ayuda

Puedes compartir:
- Sistema operativo y versión de WSL2.
- Versiones de Node, npm, Docker y Compose.
- Comandos ejecutados.
- Mensaje de error después de retirar rutas privadas, tokens, identificadores y datos financieros.
- Pasos de reproducción con datos sintéticos.

No compartas CSV/OFX reales, descripciones, IBAN, saldos, Sync IDs privados, tokens, contraseñas, `.env`, backups, bases de datos ni documentos justificativos.
