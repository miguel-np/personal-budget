# Copias de seguridad unificadas y restauración

Los datos financieros de Actual Budget y el estado propio de Personal Budget (planificación, decisiones, patrimonio manual y justificantes) son persistencia crítica. El comando npm run backup:actual crea una única copia cifrada que contiene ambos conjuntos y un manifiesto versionado. No realiza una sincronización en la nube.

## Qué se incluye

El archivo cifrado contiene esta estructura lógica:

- actual-server-data/: volumen persistente completo del servidor Actual Budget (ACTUAL_SERVER_DATA_DIR).
- personal-budget-state/: almacenes JSON propios, más `documents/` con los binarios PDF/JPEG/PNG privados inventariados.
- backup-manifest.json: formato, versión, fecha de creación, inventario JSON y binario, tamaños y SHA-256 por fichero.

La whitelist de estado de Personal Budget es:

| Archivo | Contenido recuperado |
|---|---|
| app-preferences.json | Tema e idioma |
| account-scope-preferences.json | Selección de cuentas |
| currency-preferences.json | Divisa visible, excepciones por cuenta y tipos de cambio |
| financial-intelligence-state.json | Decisiones/metadatos de revisión de hallazgos |
| financial-actions.json | Reglas/estado de alertas, preferencias de categorías, decisiones y escenarios de mejora presupuestaria |
| planning-data.json | Objetivos de ahorro y compromisos |
| periodic-reviews.json | Historial y estado de revisiones periódicas |
| wealth-data.json | Clasificaciones patrimoniales de cuentas Actual, activos/pasivos externos, reglas de vigencia y snapshots de valoración |
| documents-index.json | Metadata versionada, estado de revisión y vínculos de justificantes locales |

Los binarios se guardan en `personal-budget-state/documents/<uuid>.(pdf|jpg|png)`. El nombre es generado por el servidor; el índice, tamaño, firma real y SHA-256 deben coincidir. El backup no sigue rutas suministradas por usuarios.

Los archivos ausentes se registran como ausentes: no se inventa estado durante la restauración. La whitelist contiene nueve almacenes JSON. Los documentos se respaldan en una carpeta separada del índice para mantener el inventario binario explícito. Los ficheros que no estén referenciados por el índice provocan un fallo cerrado del backup, en lugar de quedar excluidos silenciosamente.

## Qué se excluye deliberadamente

- .env, contraseñas, tokens, claves de cifrado y otros secretos.
- La clave de backup, que se guarda separada del archivo cifrado.
- El contenido no inventariado de ACTUAL_DATA_DIR que pertenece al espacio de trabajo/caché de @actual-app/api; no se copia indiscriminadamente ese directorio.
- Importaciones temporales, extractos intermedios, logs, node_modules, cachés, imágenes Docker y modelos locales de Ollama.
- Datos externos a este checkout que no estén en el volumen persistente del servidor Actual.

La exclusión de los ficheros no inventariados evita incorporar accidentalmente credenciales, cachés o datos internos del cliente Actual. Si una nueva funcionalidad añade un almacén persistente de Personal Budget, debe añadirse a APP_STATE_FILE_NAMES, a la validación/fixture de backup y a este inventario antes de considerarla recuperable.

## Crear una copia consistente

1. Cierra Personal Budget con Ctrl+C (npm run start:local, npm run dev:api o el proceso que esté utilizando el puerto local de la API). El comando de backup comprueba que APP_HOST:APP_PORT no acepta conexiones y falla antes de modificar nada si la API sigue activa.
2. Comprueba que Docker/Actual está disponible y que hay espacio.
3. Ejecuta desde la raíz del repositorio:

   ~~~bash
   npm run backup:actual
   ~~~

4. El script detiene el servicio actual, copia el volumen, los nueve almacenes JSON permitidos y el inventario de documentos binarios, crea el manifiesto, empaqueta y valida rutas/tipos, cifra el paquete con AES-256-GCM y escribe un checksum SHA-256. Después vuelve a iniciar Actual y comprueba que responde.
5. El archivo se guarda en .local/backups/personal-budget-<fecha>.tar.gz.enc, acompañado de .sha256.

ACTUAL_SERVER_DATA_DIR controla la ruta montada por Compose y la ruta leída por el backup; ambas usan la misma variable. ACTUAL_DATA_DIR identifica el directorio de trabajo de la API y sus almacenes propios. BACKUP_DIR, BACKUP_ENCRYPTION_KEY_FILE y BACKUP_RETENTION_DAYS controlan el destino, la clave y la retención. Las rutas relativas se resuelven desde la raíz del repositorio.

El backup exige que el servidor API esté parado para no competir con las escrituras atómicas. No uses el directorio .local/actual-api como sustituto del volumen de Actual: contienen datos diferentes y ambos quedan cubiertos solo por la copia unificada.

## Clave y protección

La clave aleatoria de 32 bytes se crea en la primera copia y se guarda separada del archivo, en .local/backup-key.bin por defecto. Puede cambiarse con BACKUP_ENCRYPTION_KEY_FILE; es preferible una ruta protegida fuera del checkout. El archivo no se incluye en el backup ni se imprime en argumentos o logs. Conserva una copia independiente de la clave en un gestor de contraseñas o soporte seguro y comprueba que puedes recuperarla.

Perder la clave impide descifrar todas las copias creadas con ella. No la reemplaces por una nueva esperando recuperar archivos antiguos. La rotación requiere conservar la clave antigua hasta que sus backups hayan caducado o se hayan migrado y verificado con la nueva clave.

Los permisos locales restringen el acceso a la clave, al paquete y a los archivos temporales. SHA-256 detecta corrupción del archivo cifrado; AES-256-GCM autentica el contenido y detecta una clave incorrecta o manipulación.

## Restaurar

La restauración sustituye datos y requiere confirmación explícita. Cierra Personal Budget antes de ejecutar:

~~~bash
npm run restore:actual -- .local/backups/personal-budget-YYYYMMDDTHHMMSSZ.tar.gz.enc --confirm-data-restore
~~~

Antes de parar Actual o sustituir cualquier fichero, el script:

1. Comprueba el checksum y la etiqueta de autenticación AES-GCM.
2. Descifra en un directorio temporal privado.
3. Rechaza miembros con rutas inseguras, enlaces o tipos especiales.
4. Rechaza manifiestos ausentes, malformados o con una versión no soportada.
5. Comprueba que los archivos restaurables coinciden exactamente con el manifiesto (nombre, tamaño y SHA-256) y que contienen JSON válido.

Después detiene Actual, conserva el directorio de datos anterior y una copia separada de los almacenes JSON y la carpeta documental existentes, instala el volumen, los almacenes y los binarios documentales del backup y vuelve a iniciar Actual. Si el servicio no arranca, el procedimiento intenta recuperar el volumen y los almacenes anteriores y reinicia el servicio con el estado previo. Las copias *.pre-restore-* se conservan para inspección; no las borres hasta comprobar la restauración.

La API de Personal Budget debe permanecer detenida hasta que termine la restauración. No se sobrescribe el directorio de trabajo completo de @actual-app/api: solo se reemplazan los almacenes explícitos de la whitelist, mientras que los datos del servidor Actual se restauran desde su propio volumen.

## Validación automatizada y límites

La aceptación de CI utiliza un servidor Actual fijado a una versión concreta, un presupuesto sintético, nueve almacenes JSON, una valoración externa y un PDF ficticio. Genera la copia cifrada, comprueba que una clave incorrecta falla antes de modificar el estado activo, elimina los datos sintéticos y restaura el paquete completo. Después compara el inventario financiero de Actual, los bytes de los almacenes y la integridad/hash del justificante.

Esta comprobación automatizada no equivale a una restauración manual de un backup personal ni acredita que se haya ejecutado el flujo dentro de una distribución WSL2 concreta. Antes de depender del sistema en el entorno de uso, conserva la clave por separado y ejecuta una restauración de ensayo en una instancia aislada con datos sintéticos.

La prueba npm run test:backup:acceptance -- roundtrip es destructiva para .local/actual-server-data y los almacenes inventariados. Solo debe ejecutarse en el runner de CI o en un checkout desechable con un servidor Actual sintético; nunca en el directorio con el presupuesto personal.
