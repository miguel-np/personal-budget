# Especificación: frontera de proveedor de IA con Ollama

**Feature Branch**: `001-ollama-provider-boundary`

**Creada**: 2026-11-04

**Estado**: Draft — pendiente de clarificación y aprobación

**Origen**: Primer incremento acotado de la issue [#85 — Proveedores de IA intercambiables](https://github.com/miguel-np/personal-budget/issues/85).

**Contexto de partida**: En `main` (commit `b6018554af4bf46fa4f349c299432e64eb32acf2`), `services/api/src/local-ai.ts` contiene el cliente `LocalAiClient`, que utiliza directamente la API HTTP de Ollama. `services/api/src/app.ts` lo instancia con la configuración `ollamaBaseURL`, `ollamaModel` y timeout. Las operaciones financieras y los agregados permanecen en backend/`finance-core`.

## Objetivo y límites

Introducir una frontera interna de proveedor de modelos que permita desacoplar los casos de uso de IA de los detalles HTTP específicos de Ollama, manteniendo Ollama como único proveedor implementado en este primer incremento.

Este cambio es un paso preparatorio de la issue #85, no su entrega completa. Debe conservar el comportamiento actual y dejar una base comprobable para añadir OpenAI y xAI en especificaciones posteriores.

**Incluido en este incremento**

- Un contrato interno de proveedor limitado a las capacidades que los casos de uso actuales necesitan.
- Un adaptador Ollama que encapsule sus rutas, payloads, respuestas y particularidades.
- Migración de los flujos actuales al contrato sin cambiar su comportamiento observable.
- Pruebas de contrato y regresión con respuestas sintéticas.
- Conservación de las restricciones locales, timeout, cancelación, límites de concurrencia, límites de contexto, errores saneados y métricas actuales, en la medida en que el diseño aprobado las ubique en la frontera correcta.

**Fuera de alcance**

- Adaptadores OpenAI, xAI u otros proveedores cloud.
- Selector de proveedor/modelo en la interfaz y perfiles de enrutamiento.
- Almacenamiento o gestión de claves API.
- Fallback remoto, cambios en consentimiento o envío de contexto financiero a terceros.
- Cambios en cálculos de `finance-core`, datos de Actual, contratos financieros, endpoints públicos o diseño visual, salvo que una incompatibilidad detectada requiera una propuesta separada.
- Integración de búsqueda web nativa de un proveedor. SearXNG y la recuperación documental continúan siendo servicios backend independientes.

## Escenarios de usuario y pruebas

### Historia 1 — Mantener el asistente financiero local (Prioridad: P1)

Como usuario que utiliza el asistente financiero local, quiero que la extracción de la comunicación con Ollama no cambie las respuestas ni las garantías de privacidad, para poder seguir usando la aplicación como hasta ahora.

**Prueba independiente**: Con un proveedor Ollama simulado, ejecutar los casos de explicación financiera existentes y comprobar que se mantienen los contratos de respuesta, límites y errores.

**Criterios de aceptación**

1. Dado que la IA está activada y Ollama está disponible, cuando se solicita una explicación, entonces el resultado conserva el contrato actual y las cifras siguen procediendo del backend.
2. Dado que la IA está desactivada, no configurada o no disponible, cuando se solicita una explicación, entonces se devuelve el estado/error actual y el resto de funciones financieras sigue operativo.
3. Dado que la configuración contiene un endpoint no local, cuando se construye el adaptador Ollama, entonces se rechaza antes de enviar una petición.

### Historia 2 — Conservar los flujos estructurados actuales (Prioridad: P1)

Como usuario que utiliza clasificación de categorías y planificación conversacional, quiero que esos flujos sigan funcionando con el adaptador Ollama, sin trasladar cálculos ni decisiones financieras al modelo.

**Prueba independiente**: Ejecutar las pruebas de clasificación y extracción de intención con respuestas simuladas válidas, inválidas, incompletas y ambiguas.

**Criterios de aceptación**

1. Las salidas estructuradas continúan validadas en backend y las propuestas no persistentes siguen sin producir escrituras.
2. Los casos de respuesta mal formada o incierta producen abstención/error controlado, no una decisión financiera inventada.
3. Los importes autoritativos y las proyecciones siguen calculándose fuera del proveedor de IA.

### Historia 3 — Conservar la investigación web controlada (Prioridad: P2)

Como usuario que autoriza una búsqueda concreta, quiero que el modelo local pueda seguir sintetizando los resultados recuperados por el backend, sin obtener acceso de red propio ni contexto financiero.

**Prueba independiente**: Simular la primera respuesta estructurada del modelo, el único tool call autorizado y la síntesis posterior; comprobar el aislamiento de SearXNG y la recuperación documental.

**Criterios de aceptación**

1. Solo el backend ejecuta la búsqueda, sobre la consulta exacta aprobada.
2. El proveedor de modelo no obtiene acceso directo a SearXNG ni a URLs arbitrarias.
3. La segunda inferencia recibe resultados acotados como contenido no confiable y no recibe herramientas.
4. El contexto de cuentas, movimientos, saldos y agregados no se añade a la búsqueda externa.

## Requisitos funcionales

- **FR-001**: El backend DEBE depender de un contrato interno de proveedor y no de los detalles HTTP de Ollama en los casos de uso.
- **FR-002**: Este incremento DEBE implementar únicamente el adaptador Ollama.
- **FR-003**: El contrato DEBE cubrir, como mínimo, las modalidades que ya utiliza la aplicación: generación narrativa, salida estructurada y solicitud controlada de herramienta, además de consulta de estado/capacidades cuando sea necesario.
- **FR-004**: El adaptador Ollama DEBE preservar los endpoints y formatos actuales necesarios para explicar, extraer intención, clasificar y sintetizar investigación web.
- **FR-005**: El adaptador DEBE rechazar endpoints que no sean loopback y no debe permitir credenciales embebidas en la URL.
- **FR-006**: Las llamadas DEBEN respetar timeout, cancelación, límites de concurrencia/cola, presupuestos de contexto y límites de salida actuales.
- **FR-007**: Los errores del proveedor DEBEN traducirse a errores internos estables y saneados; no se exponen payloads o respuestas del proveedor en mensajes de error ni logs.
- **FR-008**: El estado del proveedor DEBE distinguir desactivado, no configurado, disponible, modelo ausente y no disponible, manteniendo compatibilidad con la API existente.
- **FR-009**: La configuración existente de Ollama DEBE seguir funcionando sin exigir nuevas variables ni claves.
- **FR-010**: La búsqueda y recuperación web DEBE continuar ejecutándose en backend; el modelo no adquiere red, filesystem, shell, SQL ni permisos de escritura.
- **FR-011**: El contrato y el adaptador DEBEN poder probarse con dobles/simulaciones sin descargar Ollama ni acceder a Internet.
- **FR-012**: El cambio NO DEBE introducir dependencias de proveedor en `packages/finance-core` ni modificar la fuente de verdad financiera.
- **FR-013**: Ningún fallo o ausencia del proveedor DEBE bloquear dashboard, movimientos, presupuestos, informes, objetivos u otras funciones deterministas.

## Requisitos no funcionales y de seguridad

- Mantener la inferencia local en loopback.
- No registrar prompts, contenido financiero, claves, respuestas completas ni datos sensibles.
- No habilitar fallback remoto.
- No cambiar el contenido financiero que se entrega a Ollama en los flujos locales existentes.
- Mantener el comportamiento cancelable y los límites de recursos documentados.
- Evitar abstraer capacidades futuras que no tengan un caso de uso concreto; el contrato debe cubrir las necesidades verificadas, no un SDK universal especulativo.

## Casos límite

- IA desactivada o modelo no configurado.
- Ollama detenido, modelo ausente, timeout, petición cancelada o respuesta HTTP no satisfactoria.
- Respuesta vacía, mal formada, demasiado grande o incompatible con el esquema estructurado.
- Tool calling no soportado, tool call distinta de la autorizada, argumentos modificados o múltiples llamadas.
- Saturación de concurrencia y cola completa.
- Endpoint remoto, hostname no loopback, URL con credenciales o URL mal formada.
- Proveedor simulado que falla después de aceptar la petición.
- Cambio de modelo con estado de disponibilidad cacheado.

## Criterios de éxito

- Las pruebas actuales de `services/api/tests/local-ai.test.ts`, `web-search.test.ts` y `app.test.ts` siguen pasando con dobles sintéticos.
- Existen pruebas de contrato que ejecutan el mismo conjunto de expectativas sobre el contrato y el adaptador Ollama.
- No se necesita Ollama real, API key ni conexión externa para la suite ordinaria.
- `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run build` y las auditorías existentes pasan.
- La suite E2E y los contratos HTTP existentes mantienen resultados compatibles.
- No se modifican datos de Actual ni almacenes persistentes.

## Supuestos y puntos pendientes

- La issue #85 sigue abierta y es el objetivo paraguas; esta especificación delimita solo el primer incremento.
- Ollama permanece como proveedor por defecto y único en este incremento.
- La ubicación final de la interfaz (en `services/api` o en un paquete separado) se decidirá en el plan, en función del grafo real de dependencias.
- **[NEEDS CLARIFICATION]** El contrato debe confirmar si la capacidad de tool calling se modela como una operación genérica del proveedor o como una conversación por pasos orquestada por el backend. No debe conceder al adaptador la ejecución de herramientas.
- **[NEEDS CLARIFICATION]** Definir qué métricas son propias del proveedor y cuáles deben normalizarse en el contrato común, sin introducir coste/tokens ficticios cuando Ollama no los proporciona.
- **[NEEDS CLARIFICATION]** Confirmar el modelo de persistencia de las especificaciones entregadas: historial inmutable por feature o especificación viva. Propuesta inicial: historial inmutable, con nuevas carpetas numeradas para cambios posteriores.
