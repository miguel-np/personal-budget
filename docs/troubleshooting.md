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
