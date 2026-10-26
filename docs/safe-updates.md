# Actual Budget: actualización segura y recuperación

## Política de actualización

El servicio Actual está fijado por defecto a actualbudget/actual-server:26.10.0. Compose admite una etiqueta opcional ACTUAL_IMAGE, definida en el archivo local .env. No se aceptan latest, etiquetas flotantes, repositorios diferentes ni actualizaciones que no estén en docs/update-compatibility.json.

La matriz enumera transiciones concretas validadas por una prueba de aceptación aislada. No se infiere compatibilidad porque una versión sea numéricamente más reciente. Para introducir otra transición hay que añadir una prueba real desde la versión origen a la destino, pasar la CI y revisar el impacto de migraciones. En una actualización fallida después de arrancar el nuevo contenedor, no se promete que volver a una imagen antigua sea seguro.

## Preflight

Desde la raíz del repositorio en WSL2:

    npm run update:actual -- preflight --to actualbudget/actual-server:26.10.0

El comando comprueba que la imagen configurada coincide con la ejecutada, que la instancia local responde, que hay espacio libre suficiente y que la transición exacta está en la matriz. No detiene el servicio ni cambia los datos. Si ACTUAL_IMAGE está exportada en el shell, hay que hacer unset ACTUAL_IMAGE y usar .env para que la configuración persistente no quede eclipsada por una variable externa.

## Aplicar una actualización

    npm run update:actual -- update --to actualbudget/actual-server:26.10.0 --confirm

El comando vuelve a ejecutar preflight, crea una copia cifrada con el procedimiento de backup existente, verifica el SHA-256, autentica AES-256-GCM, comprueba las rutas y los tipos del archivo y solo entonces hace pull y cambia la imagen. Tras arrancar, exige que Actual responda en localhost y verifica la imagen activa. El backup cifrado se conserva siguiendo la retención configurada.

Si pull falla antes de iniciar el contenedor destino, el script restaura la configuración anterior e intenta reiniciar esa versión. Si se ha intentado arrancar el destino y no pasa readiness, el script detiene Actual y conserva la configuración de la versión destino y el backup verificado; no arranca automáticamente la imagen anterior ni restaura datos, porque la versión nueva podría haber migrado el almacenamiento.

## Recuperación explícita tras una actualización fallida

La recuperación de datos es una operación destructiva y debe elegirse conscientemente. El estado local de la operación (.local/update-state.json) registra las versiones, el paso fallido y la ruta del backup, sin credenciales ni movimientos.

    npm run update:actual -- restore-backup --backup .local/backups/actual-server-YYYYMMDDTHHMMSSZ.tar.gz.enc --to-image actualbudget/actual-server:26.9.0 --confirm-data-restore

La orden solo acepta el backup registrado de esa actualización, la imagen origen registrada y el indicador explícito --confirm-data-restore. Primero configura la imagen origen y después invoca el restore cifrado; el script de restauración preserva el directorio reemplazado como copia de seguridad adicional. Si la copia de seguridad, la clave o la restauración fallan, no se debe borrar ninguna copia ni carpeta de datos.

La restauración de datos no es lo mismo que revertir el código de Personal Budget o la configuración de Docker. Una restauración devuelve el volumen de Actual al punto del backup y puede eliminar todos los movimientos nuevos que se hayan escrito después. No la ejecutes sin revisar el backup y aceptar explícitamente esa pérdida.

## Qué comprobar después

Antes de utilizar el presupuesto normal, abre Actual y verifica la cantidad y los nombres de las cuentas, categorías, varios movimientos, fechas, importes, saldos y presupuesto mensual. CI cubre una actualización soportada desde 26.9.0 a 26.10.0 y un fallo inyectado sobre datos sintéticos, seguido por recuperación explícita y comparación de inventario. Esta comprobación no autoriza otras transiciones de versión no incluidas en la matriz.

Actual Budget, el adaptador, la API web, las dependencias de Node y Ollama/modelo son componentes distintos. Actualizar la imagen del servidor no actualiza automáticamente las dependencias npm ni el modelo local. Mantén los lockfiles y las versiones fijados y actualiza una pieza cada vez.
