# Copias de seguridad cifradas y restauración

Los datos de Actual contienen información financiera personal. Los comandos trabajan sobre el volumen persistente de Compose (.local/actual-server-data por defecto), no sobre el directorio de trabajo de @actual-app/api.

## Crear una copia consistente y cifrada

1. Verifica que Actual funciona y que hay espacio disponible.
2. Desde la raíz del repositorio en WSL2, ejecuta npm run backup:actual.
3. El script valida o genera una clave aleatoria de 32 bytes antes de detener Actual. Después detiene el servicio, empaqueta únicamente el directorio de datos configurado, comprueba las rutas y tipos del archivo, cifra con AES-256-GCM, guarda el archivo cifrado con permisos restrictivos, escribe un SHA-256 y vuelve a iniciar Actual aunque falle la copia.
4. Las copias se guardan como .local/backups/actual-server-<fecha>.tar.gz.enc, con un sidecar .sha256. El sidecar detecta corrupción previa a la desencriptación; la etiqueta de autenticación GCM verifica que el contenido no haya sido alterado y que la clave sea correcta.
5. La clave se guarda por separado como .local/backup-key.bin por defecto. Puede cambiarse con BACKUP_ENCRYPTION_KEY_FILE a una ruta absoluta, por ejemplo una ubicación protegida fuera del directorio del proyecto. La clave nunca se incluye en el archivo ni se imprime en stdout, argumentos de proceso o logs.

La clave se genera en el primer backup y es irreemplazable para las copias creadas con ella. Antes de depender del backup, copia la clave a un gestor de contraseñas o soporte seguro independiente y comprueba que puedes recuperarla. Perder la clave implica perder acceso a todos los backups cifrados con ella. No guardes la única copia de la clave junto al único archivo de backup.

BACKUP_RETENTION_DAYS controla la retención (1–3650 días; por defecto 30). ACTUAL_SERVER_DATA_DIR, BACKUP_DIR y BACKUP_ENCRYPTION_KEY_FILE admiten rutas relativas a la raíz del proyecto o absolutas. Protege la carpeta de copias y la clave con permisos del sistema operativo. No subas datos, backups ni claves a Git o CI.

## Restaurar

    npm run restore:actual -- .local/backups/actual-server-YYYYMMDDTHHMMSSZ.tar.gz.enc

Antes de parar Actual, el script verifica el checksum, descifra a una carpeta temporal con permisos restringidos, valida el formato del archivo y rechaza rutas inseguras, enlaces y tipos especiales. Solo entonces detiene el servicio, extrae en staging y conserva el directorio actual como copia pre-restore. Si el arranque de la nueva instancia falla, intenta recuperar el directorio anterior. La carpeta temporal se elimina en ambos casos.

Clave incorrecta, archivo truncado, contenido alterado o copia sin una etiqueta de autenticación válida provocan un fallo antes de la restauración; nunca se intenta abrir la copia parcialmente descifrada. Las operaciones de restauración sustituyen datos y deben tratarse como destructivas. No borres la copia pre-restore hasta validar la instancia.

## Integridad, cifrado y rotación de claves

- SHA-256 detecta corrupción accidental de los bytes del archivo cifrado, pero no autentica por sí mismo el contenido si alguien puede sustituir tanto el archivo como su checksum.
- AES-256-GCM cifra y autentica el contenido; una clave errónea o cualquier modificación no se acepta como archivo válido.
- Los permisos limitan el acceso local al archivo y a la clave, pero no sustituyen el cifrado.
- Rotación: conserva la clave antigua hasta que todas las copias que la usan hayan caducado o se hayan migrado. Para rotar, crea primero una nueva clave fuera del repositorio, restaura una copia válida en una instancia aislada y genera con la nueva clave un backup cifrado; verifica el nuevo backup antes de retirar copias antiguas. No reemplaces la clave activa y borres la anterior sin verificar la migración.
- Pérdida de clave: no hay recuperación criptográfica de una clave perdida. Restaura la clave desde su copia segura independiente; no se debe generar una clave nueva intentando restaurar un archivo antiguo.

Prueba la restauración en una instancia aislada con datos sintéticos antes de usar backups personales. La verificación criptográfica del archivo no demuestra por sí sola la integridad semántica del presupuesto restaurado.

## Ensayo de restauración registrado

El ensayo sintético original del 25-oct-2026 validó la restauración del archivo sin cifrar (RESTORE_OK). Ese ensayo no prueba el nuevo formato cifrado. Antes de cerrar la verificación de despliegue debe ejecutarse el ensayo actualizado en una instancia aislada: inventario previo, backup cifrado, eliminación de la instancia desechable, restore con la clave original y comparación de cuentas, categorías, movimientos, IDs, fechas y saldos. CI valida el cifrado y autenticación con archivos sintéticos, pero no sustituye esa prueba live con la versión fijada de Actual Budget.
