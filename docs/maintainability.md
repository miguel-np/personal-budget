# Mantenibilidad, tamaño de módulos y modularización

## Objetivo

Mantener módulos que puedan comprenderse, probarse y revisarse de forma aislada. El tamaño es una señal para revisar responsabilidades, acoplamiento y complejidad; no es un sustituto del juicio técnico ni una métrica de calidad por sí misma.

## Presupuestos para código nuevo

Medir líneas físicas y bytes UTF-8 del fichero versionado:

| Nivel | Umbral | Acción |
|---|---|---|
| Objetivo | Hasta 600 líneas **y** 40 KiB | Módulo dentro del presupuesto ordinario. |
| Aviso | Más de 600 líneas **o** 40 KiB | Justificar cohesión y límites; considerar división antes de añadir más responsabilidades. |
| Revisión reforzada | Más de 1.000 líneas **o** 64 KiB | La PR debe explicar por qué el módulo sigue cohesionado, qué límites impiden extraerlo y qué plan de reducción existe. |

Estos umbrales son guías de revisión, no una nueva condición automática de CI. No se debe dividir código de forma mecánica para cumplir una cifra, crear micro-módulos con una sola función trivial ni modificar comportamiento como efecto secundario.

Las excepciones heredadas se reducen incrementalmente. Una excepción debe tener responsable, dominio acotado, pruebas de regresión y una propuesta de siguiente extracción.

## Snapshot de módulos grandes

Medición de referencia de `main` en el commit `98bdbb270101116f1fb5fe032101e78558c63035` (15-nov-2026). Tamaños tomados del árbol Git y líneas del contenido versionado; sirven como baseline, no como presupuesto objetivo:

| Fichero | Bytes | Líneas | Observación |
|---|---:|---:|---|
| `services/api/src/app.ts` | 250.632 | 4.282 | Composición y 56 handlers/rutas; muy por encima del presupuesto. |
| `services/api/src/local-ai.ts` | 51.466 | 964 | Cliente, contexto y flujos de tool calling; coordinar con el trabajo de frontera de proveedor. |
| `services/api/src/portfolio-routes.ts` | 38.572 | 561 | Plugin Fastify de dominio separado; patrón existente de referencia. |
| `apps/web/src/App.tsx` | 70.052 | 1.071 | Shell, navegación y composición web; separar responsabilidades de shell. |
| `apps/web/src/styles.css` | 71.107 | 1.154 | Hoja global amplia; dividir por capas/áreas sin alterar cascada. |
| `apps/web/src/MovementManager.tsx` | 55.816 | 926 | Gestión de movimientos; revisar subresponsabilidades y estados. |
| `apps/web/src/MovementTools.tsx` | 52.214 | 798 | Herramientas de movimientos; revisar límites con el gestor. |

## Estrategia de modularización

### API Fastify

Existe un ejemplo de plugin de dominio en `portfolio-routes.ts`. La siguiente evolución debe mantener `buildApp` como composition root, registrar plugins en orden explícito e inyectar dependencias mediante contratos tipados.

Secuencia recomendada, en PR separadas:

1. **Mapa y contratos de rutas:** documentar rutas, schemas, hooks, almacenamiento utilizado, permisos y dependencias. Proteger el comportamiento actual con tests API/contrato.
2. **Preferencias y configuración:** separar rutas de preferencias/currency/account scope/app settings con sus schemas y almacenamiento.
3. **Movimientos e importación:** extraer lecturas/escrituras de transacciones, previsualización/confirmación de importación y transferencias, sin cambiar semántica.
4. **Presupuestos e informes:** extraer presupuesto mensual, resumen, informes e insights relacionados.
5. **Planificación e inteligencia:** extraer planificación, compromisos, alertas, flujo de caja, hallazgos y revisiones, una frontera cada vez.
6. **Asistente e investigación:** separar estado/chat, investigación web, validación de evidencias y límites de tool calling. Coordinar con cambios independientes en `local-ai.ts` y no solapar la PR #123.

Cada plugin debe recibir solo las dependencias que utiliza. No usar singletons globales ni importar `app.ts` desde módulos de rutas. Mantener schemas y tipos cerca de su dominio salvo que sean contratos realmente compartidos. Los manejadores globales de errores, cierre y configuración HTTP permanecen en composición común.

### React y CSS

- Mantener `App.tsx` como shell/composición de rutas; mover estado y lógica de dominio a hooks o módulos próximos al panel propietario.
- Evitar mover toda la lógica a un mega-contexto global. Compartir estado solo cuando exista un propietario claro y varios consumidores reales.
- Reducir `MovementManager.tsx` y `MovementTools.tsx` por flujo/responsabilidad; conservar una única fuente de validación y confirmación.
- Organizar CSS por tokens/base/layout/componentes y, después, estilos de área. Antes de separar ficheros, preservar orden de importación, especificidad, responsive, temas y movimiento reducido.
- No introducir CSS Modules, estado global ni dependencias solo por dividir ficheros.

## Protección de comportamiento

Antes de cada extracción:

- Enumerar endpoints, inputs/outputs, errores, side effects, persistencia y eventos.
- Añadir o identificar tests de contrato y regresiones por ruta/flujo.
- Confirmar que Actual sigue siendo la fuente de verdad y que no hay acceso directo a su SQLite.
- Mantener confirmación de escrituras, idempotencia, límites, sanitización de logs y aislamiento local.
- Ejecutar lint, typecheck, test:coverage, build, auditorías y E2E según impacto.
- Comparar diff y resultados; no mezclar refactors con cambios funcionales.

## Criterios de éxito

- Módulos nuevos dentro del presupuesto salvo excepción motivada.
- Plugins con dependencias explícitas y contratos tipados; sin ciclos.
- Ningún cambio de contrato público, cálculo financiero o persistencia derivado de una extracción.
- Pruebas que demuestren equivalencia de comportamiento antes/después.
- PR pequeñas por dominio, revisables y reversibles.
- Excepciones heredadas con reducción progresiva y sin refactor masivo.


## Enforcement en CI

El gate npm run quality:repo convierte en comprobaciones automáticas parte de estas reglas:

- Los workspaces no pueden importar internals de capas superiores ni dependencias reservadas a otro componente. La API puede depender de finance-core y actual-adapter; el adaptador puede depender de finance-core; el frontend y MCP permanecen aislados de los paquetes de backend.
- Los paquetes internos declarados en los manifiestos deben respetar la misma dirección de dependencias.
- Los ficheros nuevos de código no pueden superar 600 líneas ni 40 KiB.
- Un fichero heredado que ya supere alguno de esos límites no puede crecer en líneas ni bytes en una contribución.
- Los enlaces locales de Markdown y los comandos npm run documentados deben apuntar a destinos existentes.

La comparación de tamaño usa el merge-base del PR (o el commit anterior en un push) y solo evalúa los ficheros de código modificados. Los módulos heredados grandes siguen siendo deuda técnica: el gate evita ampliarlos, pero no afirma que estén modularizados ni que SOLID se pueda certificar automáticamente.

ESLint se ejecuta sin tolerancia a warnings y TypeScript mantiene strict, noUnusedLocals y noUnusedParameters. La complejidad y la duplicación siguen requiriendo revisión técnica; no se introducen reglas AST aproximadas que puedan producir falsos positivos sobre el código financiero.
