# Copias de seguridad y restauración

Los datos de Actual contienen información financiera personal. Los comandos de esta guía trabajan sobre el directorio persistente de Compose (.local/actual-server-data por defecto), no sobre el directorio de trabajo de @actual-app/api.

## Crear una copia consistente

1. Verifica que Actual funciona.
2. Desde la raíz del repositorio en WSL2, ejecuta `npm run backup:actual`.
3. El script detiene el servicio Compose actual, crea un archivo .tar.gz fechado con permisos de propietario únicamente (`0600`), valida las rutas y los tipos de entrada, calcula un SHA-256 y vuelve a arrancar el servicio incluso si la creación falla. Para restauración se rechazan enlaces simbólicos, enlaces duros y tipos especiales dentro del archivo.
4. Las copias quedan en .local/backups, ignorado por Git. El checksum detecta corrupción, no cifra el archivo.
5. BACKUP_RETENTION_DAYS controla la retención (1–3650 días; por defecto 30). Usa una ubicación protegida con espacio suficiente.

La ruta puede ajustarse mediante ACTUAL_SERVER_DATA_DIR y BACKUP_DIR. No incluyas .env, modelos, exportaciones bancarias ni contraseñas en Git. El directorio de trabajo ACTUAL_DATA_DIR del adaptador Node es distinto del volumen de datos del servidor.

## Restaurar

~~~bash
npm run restore:actual -- .local/backups/actual-server-YYYYMMDDTHHMMSSZ.tar.gz
~~~

El script valida el archivo y su sidecar SHA-256 antes de parar Actual, inspecciona que todos los miembros estén bajo el directorio esperado, extrae en staging temporal y conserva el directorio actual como copia pre-restore. Después del cambio intenta arrancar Actual; si el arranque falla, intenta volver al directorio anterior. No borres la copia pre-restore hasta validar la instancia.

Después del restore, abre la UI y compara explícitamente cuentas, categorías, movimientos representativos, saldos e informes con un inventario sintético conocido. El script certifica integridad del archivo y finalización del proceso; no certifica por sí mismo que el presupuesto recuperado sea correcto. La comprobación de permisos del archivo de copia y la validación de tipos no sustituyen una restauración de aceptación contra una instancia aislada.

## Cifrado, retención y privacidad

El SHA-256 detecta corrupción accidental, pero no protege si alguien altera también el checksum. Protege el directorio con permisos del sistema y cifra la copia antes de moverla fuera del dispositivo. Una copia remota, aunque esté cifrada, sale del límite estrictamente local. Guarda la clave separada del archivo.

Prueba la restauración en una instancia aislada con datos sintéticos antes de confiar en el procedimiento con datos personales. No copies bases activas arbitrariamente ni mezcles archivos de copias/versiones diferentes.

## Ensayo de restauración registrado

Fecha 25-oct-2026, instancia aislada de Actual Budget `actualbudget/actual-server:26.10.0` en `127.0.0.1:5007` con Compose y directorio de datos propios (`COMPOSE_FILE`/`ACTUAL_SERVER_DATA_DIR`/`BACKUP_DIR` en un directorio temporal).

1. Inventario sintético: 1 cuenta (`Cuenta sintética`), 9 categorías, 3 movimientos (ingreso 1500,00 €, gastos 32,00 € y 78,00 €) y saldo 1890,00 €; presupuesto de 200,00 € en `Comida` para 2026-09.
2. `npm run backup:actual` creó el archivo fechado con permisos `0600` y su `.sha256`.
3. Se destruyó el directorio de datos y se eliminó el contenedor (`docker compose down`), el peor caso de recuperación.
4. `npm run restore:actual -- <copia>` recreó el contenedor (`docker compose up -d`) y restauró el directorio.
5. Verificación con la API oficial contra la instancia restaurada: cuentas, categorías, movimientos (mismos IDs y fechas) y saldo **idénticos** al inventario previo (`RESTORE_OK`).

El script usa ahora `docker compose up -d` en lugar de `start` para que la restauración también funcione cuando el contenedor fue eliminado y no solo parado. La copia pre-restore se conserva hasta verificar el inventario completo.
