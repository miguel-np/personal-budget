# Resolución de problemas

## Actual Budget no abre

- Comprueba que el contenedor/servicio está en ejecución.
- Revisa `docker ps` y los logs de `actual-budget`.
- Confirma que el puerto 5006 no está ocupado y que está ligado a localhost.
- No borres el directorio de datos para reparar el servicio.

## El adaptador no puede abrir el presupuesto

- Confirma que `ACTUAL_SERVER_URL` apunta al servidor correcto.
- Comprueba el identificador del presupuesto y la contraseña del servidor, si está configurada.
- Sigue la guía de la versión de `@actual-app/api` usada por la implementación.
- No inventes endpoints REST; Actual no ofrece una REST API general para consultar el presupuesto.
- Revisa si el servidor de Actual y la API programática usan versiones compatibles.
- Comprueba que el directorio de datos de la API (`ACTUAL_DATA_DIR`) existe y es escribible por tu usuario.

## `.local` aparece propiedad de root tras `docker compose up`

Cuando Docker crea el directorio de montaje de un bind mount, puede dejarlo propiedad de root, y el contenedor de Actual escribe sus archivos como root. Si `.local` queda inaccesible:

- Crea los directorios con tu usuario **antes** del primer `docker compose up`:

  ~~~bash
  mkdir -p .local/actual-server-data .local/actual-api .local/backups
  docker compose up -d
  ~~~

- Si ya los creó Docker, corrígelos una vez con:

  ~~~bash
  sudo chown -R "$(id -u):$(id -g)" .local
  ~~~

- Los archivos que escriba después el contenedor dentro de `.local/actual-server-data` pueden volver a quedar propiedad de root; el acceso de lectura y el backup con tar siguen funcionando, pero el usuario necesita poder crear `.local/actual-api` y `.local/backups`.

- No uses `sudo npm ci` ni ejecutes los scripts de Node como root; mantén el resto del repositorio propiedad de tu usuario.

## Ollama no responde

- Comprueba `ollama list` y `curl http://127.0.0.1:11434/api/tags` desde el entorno del backend.
- Verifica que `OLLAMA_MODEL` coincide exactamente con un modelo instalado.
- Comprueba memoria disponible y tiempo de carga del modelo.
- Si el chat no puede usar herramientas, valida el soporte de tool calling del modelo y runtime con datos sintéticos.
- La ausencia de IA no debe impedir registrar o consultar datos mediante funciones deterministas.

## La importación falla o crea duplicados

- Revisa el formato y los campos de fecha/importe.
- Prueba primero con pocos movimientos.
- Verifica el signo de cargos y abonos.
- Compara identificadores y fechas con el historial previo.
- Haz copia antes de volver a importar un periodo completo.

## Los totales no coinciden

- Asegúrate de comparar el mismo intervalo, cuenta y divisa.
- Comprueba que los traspasos internos no se cuentan como ingresos o gastos.
- Revisa reembolsos, transacciones pendientes y movimientos duplicados.
- No combines divisas sin una conversión explícita.
- Contrasta el saldo de Actual con el saldo mostrado por el banco.

## Información que puedes compartir para pedir ayuda

Comparte versiones de software, mensajes de error saneados, comandos usados y datos sintéticos mínimos. Nunca compartas CSV real, descripciones, IBAN, saldos, tokens, contraseñas ni la base de datos completa.
