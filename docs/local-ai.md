# IA local con Ollama

La integración opcional usa la API de Ollama en loopback. Se mantiene desactivada por defecto: configura \`.env\` con \`AI_ENABLED=true\`, \`OLLAMA_MODEL\` con el nombre exacto de un modelo instalado y \`OLLAMA_BASE_URL=http://127.0.0.1:11434\`. \`OLLAMA_REQUEST_TIMEOUT_SECONDS\` admite de 1 a 180 segundos y \`AI_MAX_CONTEXT_CHARS\` limita el contexto agregado que se envía al modelo. La configuración remota se rechaza.

## Límites de seguridad

- El estado del modelo está disponible en \`GET /api/v1/assistant/status\`; la API confirma disponibilidad y que el modelo esté instalado.
- El chat acepta una pregunta limitada a 2.000 caracteres y fechas validadas; solo usa cálculos de \`finance-core\`.
- Se envían al modelo agregados resumidos y totales de categorías, no las descripciones, notas, conceptos ni registros completos de movimientos.
- Las cifras que presenta la interfaz proceden del backend; la narración se trata como explicación cualitativa, no como fuente de importes.
- El asistente no tiene herramientas de escritura ni puede alterar Actual Budget. La variable \`AI_WRITE_OPERATIONS_ENABLED\` no habilita escrituras en esta versión.
- Prompts y respuestas no se registran. Un timeout, un modelo ausente o un runtime caído produce un error saneado y no bloquea el resto de la aplicación.
- Las descripciones bancarias son datos no confiables. La protección principal consiste en no enviarlas al modelo y no darle herramientas ni acceso al backend.

No todas las combinaciones modelo/runtime están verificadas en vivo. La CI prueba comportamiento con respuestas sintéticas, sin descargar modelos ni acceder a internet. Para pruebas manuales, usa un presupuesto sintético y revisa la licencia y los requisitos hardware del modelo elegido.

La IA no constituye asesoramiento financiero profesional. Revisa los indicadores deterministas antes de tomar decisiones.
