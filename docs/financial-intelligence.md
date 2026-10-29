# Centro de inteligencia financiera

El centro de inteligencia reúne hallazgos deterministas en una bandeja revisable. El contrato versionado schemaVersion 1 se valida en la API. Cada hallazgo incluye una identidad estable, huella de evidencias, regla que lo activa, periodo, ámbito de cuentas, divisa, métricas agregadas, limitaciones, prioridad explicada y estado de revisión.

## Reglas de la primera versión

- **Cambios de gasto e ingresos:** compara ventanas contiguas de la misma duración. Requiere al menos tres movimientos comparables en cada ventana, divisa coincidente y cero movimientos sin conversión válida. Se activa con una diferencia absoluta de al menos 5.000 unidades menores y una variación relativa de al menos el 20 %. Identifica aumentos o reducciones; no atribuye causas.
- **Persistencia:** para ventanas de hasta 92 días consulta una tercera ventana equivalente. La prioridad sube una categoría cuando la misma dirección vuelve a superar ambos umbrales. Si falta historial suficiente, la persistencia figura como no evaluada, nunca como ausencia de persistencia.
- **Movimientos sin categoría:** muestra el número y los importes agregados de movimientos normalizados sin categoría. Excluye transferencias internas; la normalización de movimientos divididos evita contar el padre y sus líneas hijas como movimientos separados. Nunca asigna categorías.
- **Desviaciones presupuestarias:** exige presupuesto y gasto conocidos en Actual Budget, análisis del mes completo, todas las cuentas y coincidencia entre la divisa presupuestaria y la de análisis. Así evita atribuir un presupuesto global a una selección parcial de cuentas.
- **Compromisos próximos:** muestra compromisos activos registrados localmente, dentro de los 30 días siguientes y compatibles con la divisa y el ámbito de cuentas actuales. Son datos de planificación, no confirmaciones bancarias.
- **Posibles pagos recurrentes:** aplica el detector existente sobre hasta 12 meses de historial y muestra candidatos cuya próxima fecha estimada cae en los siguientes 30 días. No afirma que se trate de una suscripción ni garantiza el siguiente cargo.
- **Progreso de objetivos:** cada objetivo activo compatible con el ámbito y la divisa genera una proyección determinista. Se marca como progreso cuando la aportación configurada alcanza la meta y como riesgo cuando no llega a tiempo; se diferencia la aportación planeada del flujo máximo potencial.

Las prioridades consideran impacto, persistencia cuando se puede medir y proximidad temporal. Las reglas y umbrales se incluyen en la evidencia. Prioridad no significa certeza. La primera versión no modela estacionalidad, inflación, eventos excepcionales ni cambios estructurales.

## Periodo y filtros

La interfaz permite cambiar explícitamente las fechas desde/hasta para analizar una ventana, además de filtrar por tipo y estado de revisión. Cambiar las fechas recalcula el intervalo elegido y no altera el periodo predeterminado del resto del dashboard.

## Identidad y revisión

El ID permanece estable para la misma regla, sujeto, periodo y ámbito. La huella cambia si cambian materialmente las métricas o las evidencias; una decisión anterior no oculta evidencia nueva. Los hallazgos se deduplican por ID.

Los estados son pendiente, útil confirmado (estado interno reviewed), descartado y aplazado. La opción «Marcar útil» registra una señal positiva explícita del usuario. Los aplazamientos expiran y la API los limita a 90 días; la interfaz permite aplazar durante siete días. Las revisiones se validan y escriben atómicamente en financial-intelligence-state.json, bajo el directorio local de datos de la API, con permisos restrictivos y límites de tamaño. El archivo conserva solo ID, huella y metadatos de revisión, no importes ni detalles de movimientos.

El backup cifrado de Actual Budget cubre el volumen de Actual, no el archivo de revisiones de la aplicación. Si se desea conservar las revisiones al reinstalar, se debe incluir ese archivo local en una copia segura independiente. No debe subirse a Git.

## Métricas de utilidad sin telemetría

El panel calcula en local el número de hallazgos marcados útiles/descartados y la tasa de descarte entre hallazgos con feedback explícito. Esta tasa es una señal de utilidad declarada, no la precisión ni la tasa de falsos positivos del detector. El núcleo también expone un evaluador para calcular verdaderos positivos, falsos positivos, falsos negativos, precisión y tasa de falsos positivos sobre un conjunto sintético o curado con etiquetas independientes; si falta denominador, la métrica queda como no disponible. Las pruebas usan fixtures sintéticos. No se transmiten estas métricas ni el feedback a servicios externos.

## IA local opcional y privacidad

La lista funciona sin Ollama. Solo cuando la persona pulsa «Explicar con IA local», la API puede enviar al modelo local configurado una síntesis agregada del periodo, tipo de hallazgo, explicación determinista, reglas y limitaciones. No se envían filas de movimientos, notas, nombres de cuentas ni títulos de objetivos o compromisos. La IA no modifica el hallazgo ni sus métricas. Si Ollama está desactivado o no disponible, el análisis determinista continúa; no se utiliza IA remota ni telemetría para este flujo.

## Validación

Las pruebas unitarias cubren comparaciones, periodos equivalentes, datos escasos, divisas incompatibles, conversiones pendientes, persistencia, identidad y movimientos sin categoría. Las pruebas de API cubren el contrato versionado, la revisión y el modo de IA desactivada. Las pruebas E2E cubren evidencia y revisión desde la interfaz, además de los estados vacíos y de error.

Para validar el repositorio completo:

    npm run typecheck
    npm run lint
    npm test
    npm run build
    npm run test:e2e

El centro es informativo: no detecta fraude, no ofrece asesoramiento fiscal, de inversión o crédito y no aplica cambios automáticos al presupuesto.
