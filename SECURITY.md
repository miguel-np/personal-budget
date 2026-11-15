# Política de seguridad

## Estado

Proyecto local-first implementado (P0–P2, 25-oct-2026). La política define requisitos de diseño y operación; no certifica que ninguna versión cumpla todos los requisitos automáticamente.

Revisión de seguridad de P2 registrada:

- CI ejecuta lint, typecheck, build, pruebas con cobertura (92 % statements / 79 % branches), auditoría de dependencias (`npm audit` y `npm audit --omit=dev`) y escaneo de secretos con permisos mínimos en workflow; todo verde en `main`.
- Verificado en el entorno objetivo WSL2: servicios ligados solo a `127.0.0.1`, CORS rechaza orígenes no permitidos (403), logs sin prompts ni detalles de movimientos, respuestas de error saneadas sin secretos.
- Pruebas de prompt injection (descripciones y solicitudes ambiguas), herramientas MCP desconocidas rechazadas, importaciones sin aprobación no persisten y el asistente no tiene herramientas de escritura.
- Límites: los escaneos automáticos detectan dependencias y secretos conocidos, pero **no prueban ausencia de vulnerabilidades**, ni sustituyen revisiones manuales del código ni la validación de restauraciones con inventario (registrada en `docs/backup-restore.md`).

## Frontera de seguridad del runtime local (#130)

La API y el frontend compilado deben escuchar solo en loopback. El gate HTTP de la API valida el Host contra los hostnames/puertos loopback configurados y comprueba Origin, Referer y Fetch Metadata antes del parseo del cuerpo y de los controladores. Los orígenes de navegador se comparan exactamente con `APP_ALLOWED_ORIGINS`; CORS no se utiliza como mecanismo de autorización.

El frontend servido por Vite Preview aplica una CSP efectiva: scripts, hojas de estilo, conexiones y recursos se restringen al mismo origen (con `data:`/`blob:` solo para imágenes y fuentes necesarias); se bloquean objetos, framing y bases/formularios externos. No se permite `unsafe-eval` ni `unsafe-inline` en scripts o elementos de estilo. La única excepción es `style-src-attr 'unsafe-inline'`, limitada a atributos dinámicos utilizados por las barras de progreso de React; no habilita scripts inline ni elementos/hojas de estilo inline. La API conserva cabeceras HTTP defensivas, pero la CSP que protege el documento se entrega desde el servidor del frontend.

Las peticiones locales sin Origin, Referer ni Fetch Metadata se admiten para clientes de automatización no navegador. Esto es compatibilidad, no autenticación: cualquier proceso con acceso a la misma cuenta del sistema puede conectarse al loopback. Las defensas de navegador tampoco protegen frente a malware, extensiones privilegiadas o un origen legítimo comprometido.

### Modelo de amenazas y riesgo residual

| Actor | Activo/ruta de ataque | Controles | Riesgo residual |
|---|---|---|---|
| Sitio remoto abierto en el mismo navegador | Formularios, solicitudes simples, navegación o contenido embebido hacia la API local | Host loopback exacto; Origin/Referer y Fetch Metadata; CSP; no se habilita CORS genérico | El navegador, sus extensiones y el origen permitido siguen siendo parte de la base de confianza |
| Origen local no autorizado | Usar otro puerto/alias local o DNS rebinding para alcanzar la API | Host restringido a loopback y puertos configurados; comparación exacta del origen; aliases DNS arbitrarios rechazados | Un proceso local puede acceder directamente a loopback sin simular un navegador |
| Dispositivo de la LAN | Acceso a API, frontend, Actual u Ollama desde otro equipo | Listeners locales ligados a loopback; puertos de servicios no publicados a interfaces externas por defecto | Túneles, proxy inverso o cambios manuales de binding pueden ampliar la exposición |
| Proceso/usuario local distinto o malware | Lectura/escritura de ficheros, llamadas directas a la API y acceso a secretos del usuario | Permisos mínimos de ficheros, secretos locales y límites de la API | No existe autenticación de procesos ni aislamiento entre procesos con la misma cuenta |
| Dependencia o herramienta comprometida | Código con privilegios de ejecución durante build/CI | Acciones fijadas por SHA; npm audit; Gitleaks fijado por digest, sin red, capacidades ni escritura del filesystem | Auditorías no prueban ausencia de vulnerabilidades; una dependencia ejecutada puede actuar con los permisos del job |

La imagen del escáner se fija como `ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854`. La ejecución del contenedor usa red deshabilitada, capacidades eliminadas, filesystem de solo lectura y un `/tmp` efímero limitado. Para actualizarla se verifica la versión y el digest publicados por el registro oficial y se revisa el cambio explícitamente.

No se afirma que CORS, CSP o loopback protejan frente a malware/procesos locales ni que esta aplicación sea multiusuario o segura para exposición pública.

## Informar una vulnerabilidad

No publiques detalles explotables, extractos financieros, archivos de presupuesto ni credenciales en issues públicos. Utiliza la función de comunicación privada de vulnerabilidades de GitHub si está habilitada en el repositorio. En un repositorio privado, informa al propietario por un canal privado acordado.

## Requisitos de seguridad

- Mantener la aplicación accesible solo desde `localhost` por defecto.
- No publicar los puertos de Actual Budget, Ollama, backend o MCP en interfaces de red externas.
- No exponer una herramienta para ejecutar shell, SQL arbitrario, código o rutas de archivo controladas por el modelo.
- Utilizar una lista permitida explícita de herramientas MCP.
- Validar y limitar entradas, fechas, importes, tamaño de archivos, número de resultados y duración de peticiones.
- Tratar CSV, OFX, QIF, QFX y CAMT como datos no confiables; validar estructura, codificación, tamaño y campos antes de procesarlos.
- Mantener secretos en archivos locales excluidos de Git. No incluir contraseñas bancarias.
- Enmascarar secretos en logs y errores. Evitar registrar descripciones y contenido íntegro de transacciones.
- Mantener dependencias actualizadas y ejecutar análisis de vulnerabilidades antes de publicar versiones.
- Respaldar los datos y probar la restauración. Las copias contienen información financiera sensible.

## Modelo de amenazas mínimo

Las amenazas incluyen acceso desde otro dispositivo en la red, malware local, extensión de navegador maliciosa, dependencia comprometida, prompt injection contenido en descripciones de movimientos, acceso excesivo del modelo a herramientas, pérdida o robo de las copias y errores de importación duplicando movimientos.

El carácter local no protege frente a alguien que ya tenga acceso a la cuenta de Windows/WSL o a los archivos sin cifrar. Utiliza cifrado de disco, una cuenta del sistema protegida y copias cifradas.
