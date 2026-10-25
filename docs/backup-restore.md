# Copias de seguridad y restauración

Los datos de Actual contienen información financiera personal. Los comandos de esta guía trabajan sobre el directorio persistente de Compose (.local/actual-server-data por defecto), no sobre el directorio de trabajo de @actual-app/api.

## Crear una copia consistente

1. Verifica que Actual funciona.
2. Desde la raíz del repositorio en WSL2, ejecuta `npm run backup:actual`.
3. El script detiene el servicio Compose actual, crea un archivo .tar.gz fechado, valida sus rutas, calcula un SHA-256 y vuelve a arrancar el servicio incluso si la creación falla.
4. Las copias quedan en .local/backups, ignorado por Git. El checksum detecta corrupción, no cifra el archivo.
5. BACKUP_RETENTION_DAYS controla la retención (1–3650 días; por defecto 30). Usa una ubicación protegida con espacio suficiente.

La ruta puede ajustarse mediante ACTUAL_SERVER_DATA_DIR y BACKUP_DIR. No incluyas .env, modelos, exportaciones bancarias ni contraseñas en Git. El directorio de trabajo ACTUAL_DATA_DIR del adaptador Node es distinto del volumen de datos del servidor.

## Restaurar

~~~bash
npm run restore:actual -- .local/backups/actual-server-YYYYMMDDTHHMMSSZ.tar.gz
~~~

El script valida el archivo y su sidecar SHA-256 antes de parar Actual, inspecciona que todos los miembros estén bajo el directorio esperado, extrae en staging temporal y conserva el directorio actual como copia pre-restore. Después del cambio intenta arrancar Actual; si el arranque falla, intenta volver al directorio anterior. No borres la copia pre-restore hasta validar la instancia.

Después del restore, abre la UI y compara explícitamente cuentas, categorías, movimientos representativos, saldos e informes con un inventario sintético conocido. El script certifica integridad del archivo y finalización del proceso; no certifica por sí mismo que el presupuesto recuperado sea correcto.

## Cifrado, retención y privacidad

El SHA-256 detecta corrupción accidental, pero no protege si alguien altera también el checksum. Protege el directorio con permisos del sistema y cifra la copia antes de moverla fuera del dispositivo. Una copia remota, aunque esté cifrada, sale del límite estrictamente local. Guarda la clave separada del archivo.

Prueba la restauración en una instancia aislada con datos sintéticos antes de confiar en el procedimiento con datos personales. No copies bases activas arbitrariamente ni mezcles archivos de copias/versiones diferentes.
