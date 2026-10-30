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

## Validación live registrada

Fecha 25-oct-2026, WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2) con Ollama de Windows expuesto en loopback mediante `networkingMode=mirrored` en `.wslconfig`.

- Modelo probado: **qwen3:8b** (8.2B, Q4_K_M, capacidades `completion`, `tools`, `thinking`). `npm run test:ollama:acceptance` pasa: disponibilidad detectada, generación real completada y narración devuelta sin cifras ni enlaces.
- Compatibilidad de tool calling del runtime/modelo: qwen3:8b devuelve la llamada en el campo estructurado `tool_calls` con argumentos JSON válidos. El modo `thinking` consume tokens de generación: la aplicación usa `num_predict=768` para dejar margen a la respuesta; con 256 la narración se truncaba.
- Otros modelos instalados en el entorno: qwen3:14b (misma familia, sin probar en vivo) y qwen2.5-coder:7b, que emite la llamada de herramienta como texto JSON en `content` en lugar del campo estructurado; usar un cliente que solo parse `tool_calls` lo descartaría.
- Chat end-to-end contra datos sintéticos: resumen mensual, gasto por categoría y comparativa de periodos devuelven cifras del backend y narración cualitativa separada; una inyección de prompt pidiendo borrar gastos fue rechazada por el modelo (asistente de solo lectura) y la salida no contiene cifras, URLs ni descripciones de movimientos.
- El fallo del runtime (Ollama caído) está cubierto por tests sintéticos: el chat devuelve 503 saneado y el resto de la aplicación sigue operativo. Los prompts y respuestas no se registran.

La IA no constituye asesoramiento financiero profesional. Revisa los indicadores deterministas antes de tomar decisiones.


## Extracción de intenciones del planificador de ahorro

El planificador usa el mismo cliente local y los mismos límites de concurrencia de Ollama. La petición de extracción contiene solo el texto escrito por el usuario, la fecha local del backend, la divisa de análisis y una lista acotada de objetivos activos compatibles (identificador y nombre para resolver referencias inequívocas). No incluye cuentas, movimientos, descripciones, categorías, notas, importes históricos ni saldos.

Ollama devuelve JSON conforme a un esquema estricto. Los importes se extraen como números en unidades principales de la divisa; la API valida rangos y precisión monetaria y realiza la conversión a unidades menores. El modelo no calcula proyecciones ni decide viabilidad. Fechas o importes ausentes, referencias ambiguas y divisas distintas provocan una pregunta aclaratoria o el rechazo seguro de la simulación.

La IA no dispone de endpoints de escritura. El único endpoint conversacional es `POST /api/v1/planning/conversation/preview` y siempre devuelve `saved: false`. La prueba de un gasto extraordinario usa un compromiso temporal en memoria que desaparece al terminar la petición. Los objetivos y compromisos guardados solo pueden cambiarse mediante los flujos separados de Objetivos.

La aceptación opcional `PERSONAL_BUDGET_RUN_PLANNING_AI_ACCEPTANCE=1 OLLAMA_MODEL=<modelo-local> npm run test:planning-ai:acceptance` ejecuta una pequeña suite de prompts totalmente sintéticos y mide exactitud de campos y detección de aclaraciones. CI valida el contrato con respuestas sintéticas; no descarga ni presupone un modelo local.
