# Privacidad y flujo de datos

## Principios

Personal Budget está diseñado para uso local-first. Actual Budget conserva la fuente de verdad de cuentas, categorías, presupuestos y movimientos. Los almacenes de Personal Budget contienen preferencias, planificación, revisiones, patrimonio y metadata documental; no duplican el libro de movimientos.

La aplicación no configura sincronización bancaria automática ni pide credenciales de acceso al banco. Los datos reales no deben aparecer en fixtures, capturas, logs, issues ni pruebas automatizadas.

## Datos que se procesan localmente

- Transacciones, fechas, importes, divisas, descripciones, categorías y cuentas mediante el adaptador oficial de Actual.
- Agregados deterministas generados en backend/finance-core.
- Preferencias de ámbito/divisa, objetivos, compromisos, revisiones, alertas y decisiones.
- Valoraciones manuales y metadata/binarios documentales privados.
- Preguntas y respuestas de asistentes locales, sin persistencia de conversaciones por defecto.

## Qué sale del equipo

La aplicación financiera no envía movimientos ni agregados a servicios de búsqueda o a APIs de IA en la nube. Ollama debe permanecer en loopback (127.0.0.1:11434) para mantener la inferencia local. Configurar otro runtime alojado o remoto puede cambiar esa frontera de privacidad.

### Búsqueda web explícita (#84)

La investigación web es un flujo independiente y desactivado por defecto (WEB_SEARCH_ENABLED=false). Para cada búsqueda, el usuario debe marcar el consentimiento en la interfaz. El backend envía al proveedor configurado únicamente el texto exacto de la consulta aprobada.

No se adjuntan conversaciones, preguntas del chat financiero, movimientos, cuentas, importes, categorías, objetivos, compromisos ni agregados. La síntesis se realiza con Ollama local a partir de resultados de búsqueda acotados. Las respuestas y consultas no se guardan como historial y los logs no registran la consulta ni los fragmentos.

El proveedor por defecto es una instancia SearXNG configurada por el operador:
- **SearXNG local:** puede ejecutarse en loopback. Aunque se autohospede, SearXNG puede remitir la consulta a motores upstream según sus preferencias, configuración y motores habilitados.
- **SearXNG remoto:** solo se admite mediante HTTPS. El operador debe revisar la política del servicio y las condiciones de sus motores upstream.

La consulta puede ser visible para SearXNG y para sus motores upstream. Estos servicios pueden observar la IP pública de salida del servidor SearXNG y los términos buscados. El usuario debe revisar la configuración de esos proveedores antes de habilitar la función. Los enlaces de los resultados abren el sitio original cuando el usuario lo decide; la API no descarga páginas arbitrarias.

En el modo fiscal, la búsqueda se limita a una lista de dominios oficiales permitidos (AEAT, BOE, Hacienda, Seguridad Social, Xunta/DOG, CNMV y Banco de España, según dominios configurados). La lista reduce resultados fuera de esos dominios, pero no certifica que cada fragmento sea completo ni que una norma siga vigente.

### Otras conexiones externas

El software puede establecer conexiones para descargar dependencias, imágenes de contenedor, actualizaciones y modelos. Revisa los endpoints y motores upstream que configures. Una garantía más fuerte requiere firewall con política de salida restringida después de instalar dependencias y modelos.

## Asistente financiero y privacidad

El chat financiero calcula agregados en el backend y envía a Ollama local solo el contexto mínimo previsto. No envía descripciones, notas ni filas completas de movimientos. Sus cálculos numéricos permanecen en finance-core y el modelo no tiene herramientas ni permisos de escritura.

El flujo de búsqueda web no reutiliza este contexto financiero. Son endpoints y contratos separados.

## Historial y logs

No se persisten conversaciones ni historial de navegación por defecto. Los logs operativos excluyen textos completos de movimientos, saldos, mensajes de usuario, consultas, resultados, tokens y contraseñas. La telemetría local de inferencia registra únicamente métricas no sensibles (duración, espera, resultado y presupuesto de contexto).

## Backup y datos locales

El backup cifrado unificado contiene el volumen de Actual, nueve almacenes JSON propios y los binarios documentales inventariados. Incluye financial-intelligence-state.json y periodic-reviews.json; la whitelist completa está en la guía de backup y restauración. La clave AES se conserva separada del archivo cifrado.

La exportación portable es diferente: es una instantánea legible seleccionable, no un backup restaurable. No contiene secretos ni claves.

## Límites

«Local» no equivale a «cifrado automáticamente». Los ficheros locales pueden ser leídos por otros procesos o usuarios con acceso al sistema. Protege la cuenta del sistema operativo y el disco, conserva la clave de backup en un lugar seguro y revisa las políticas de Docker Desktop, Windows, WSL y los proveedores de modelos/búsqueda.
