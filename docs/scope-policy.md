# Política de alcance y ciclo de vida de capacidades

## Objetivo

Evitar que el repositorio acumule funcionalidades cuya aceptación, privacidad, evidencia o coste operativo no estén definidos. Esta política aplica a cambios funcionales, integraciones, automatizaciones, experimentos arquitectónicos y ampliaciones de superficie externa.

## Fuentes de referencia

| Información | Fuente autoritativa |
|---|---|
| Estado de una tarea, prioridad operativa y discusión | GitHub Issue |
| Estado de una propuesta de código, revisiones y checks | Pull Request y su último SHA |
| Capacidades integradas y evidencia de producto | [Estado de implementación](implementation-status.md) |
| Dirección y secuencia estratégica | [Roadmap](roadmap.md) |
| Reglas de arquitectura, privacidad y seguridad | [Arquitectura](architecture.md), [privacidad](privacy.md), [SECURITY.md](../SECURITY.md) |

README y roadmap no deben mantener copias manuales del estado abierto/cerrado de issues. Los textos de issues describen el alcance y los criterios de aceptación; no sustituyen la evidencia de merge ni los resultados del último CI.

## Entrada de una capacidad nueva

Una propuesta debe incluir, antes de implementación:

1. **Problema y resultado:** quién necesita la capacidad, qué tarea habilita y cómo se comprobará el beneficio.
2. **Alcance negativo:** qué no hará, especialmente acciones financieras, acceso externo, automatización y persistencia.
3. **Fuente de verdad y límites:** qué componente posee los datos y qué paquetes/servicios pueden acceder a ellos.
4. **Privacidad y seguridad:** datos procesados, datos que salen del equipo, consentimiento, retención, amenazas, validación de entradas y permisos.
5. **Diseño y alternativas:** opción mínima, alternativas descartadas, nuevas dependencias y coste de mantenimiento.
6. **Aceptación:** pruebas automatizadas, pruebas manuales, evidencia externa y responsable de cada condición.
7. **Retirada y recuperación:** cómo desactivar la capacidad, revertir cambios y recuperar datos si hay persistencia o migración.

No se inicia una capacidad que dependa de una decisión arquitectónica aún no tomada, una aprobación humana no disponible o un proveedor externo sin contrato de privacidad revisado.

## Clasificación del ciclo de vida

- **Propuesta:** problema y criterios aún no aprobados; no se presenta como función disponible.
- **En desarrollo:** existe alcance aprobado y trabajo en PR; no equivale a integración.
- **Integrada:** cambios fusionados y checks aplicables superados en el SHA validado.
- **Experimental:** útil para evaluación, pero con limitaciones de alcance, evidencia o aceptación declaradas; no se presenta como garantía de producto.
- **Bloqueada externamente/manual:** el código no elimina una dependencia de configuración, servicio real, inspección de privacidad o revisión humana especializada.
- **Retirada/no planificada:** la decisión de no implementar está documentada; no se oculta una capacidad incompleta como completada.

Una capacidad puede estar integrada técnicamente y seguir experimental o bloqueada para aceptación. La clasificación debe especificar qué condición falta y quién puede resolverla.

## Clasificación de #84 y dependencias

| Issue | Clasificación | Condición pendiente / límite |
|---|---|---|
| [#84 — Investigación web controlada](https://github.com/miguel-np/personal-budget/issues/84) | Experimental; aceptación no completada | No es un motor de dictamen jurídico. Requiere resolver aceptación real, revisión del corpus y límites semánticos. |
| [#106 — Aceptación de búsqueda y fuentes](https://github.com/miguel-np/personal-budget/issues/106) | Bloqueada por ejecución manual/configuración local | La versión vigente de la issue define ejecución desde API en loopback con SearXNG configurado y consultas públicas fijas. **No exige un backend público ni un despliegue HTTPS de Personal Budget.** La privacidad se acepta solo tras inspeccionar petición saliente y logs reales. |
| [#108 — Corpus fiscal/legal](https://github.com/miguel-np/personal-budget/issues/108) | Bloqueada por revisión humana especializada | Los 13 casos y sus regresiones técnicas no equivalen a aprobación fiscal/jurídica. Cada resultado esperado requiere revisión competente. |
| [#110 — Evidencia y discrepancias](https://github.com/miguel-np/personal-budget/issues/110) | Parcialmente integrada; validación pendiente | El cotejo literal no demuestra entailment. La clasificación del modelo y la comparación de metadatos no resuelven por sí solas jurisdicción, rango, aplicabilidad ni contradicciones no señaladas. |

La issue #84 no se cierra por CI verde mientras esas condiciones permanezcan abiertas. No se inventará una URL pública, no se relajaran allowlists ni se automatizará una aprobación jurídica.

## Condiciones de entrada para líneas relacionadas

- **#85 — Proveedores de IA:** antes de habilitar un proveedor remoto, documentar datos transmitidos, región, retención, credenciales, control del usuario y modo de desactivación. Ollama local no autoriza por sí mismo el envío a proveedores cloud.
- **#87 — Espacio fiscal:** el perfil fiscal y las obligaciones deben introducirse explícitamente y validarse contra fuentes oficiales y ejercicios concretos; nunca inferirlos del presupuesto o de ubicación aproximada.
- **#66 — Dependencia de Actual:** completar primero el ADR con coste de mantenimiento, integridad, licencia, operación, sincronización y migración. No presupone reemplazar Actual.
- **#67 — Prototipo SQLite:** no empieza hasta que #66 justifique una hipótesis medible. Solo fixtures sintéticas, modo aislado y lectura; no accede al SQLite de Actual ni sustituye la fuente de verdad.

## Salida y cierre

Una issue se cierra cuando:

- Los criterios de aceptación están demostrados con evidencia asociada al SHA/entorno correcto.
- Los checks obligatorios y aplicables están verdes sobre el último SHA de la PR.
- Las condiciones manuales, externas o de especialista están realizadas por la persona competente; si no pueden realizarse, la tarea permanece abierta y bloqueada.
- Los enlaces y documentación afectados están actualizados.
- No quedan riesgos nuevos sin documentar ni cambios de alcance fuera de la aprobación.

Los informes deben distinguir: test automatizado, inspección estática, aceptación live, revisión manual y revisión especializada. No uses una como sustituto de otra.

## Taxonomía del backlog

Los títulos describen el problema, no la prioridad. Una vez creadas las etiquetas en GitHub, se usará:

### Prioridad

- `priority:p0` — riesgo inmediato de pérdida/corrupción financiera, exposición de datos o vulnerabilidad crítica activa.
- `priority:p1` — fiabilidad, seguridad o bloqueo grave del flujo principal.
- `priority:p2` — mejora importante de producto, UX, accesibilidad o mantenibilidad.
- `priority:p3` — experimento, investigación u optimización no bloqueante.

### Tipo

- `type:bug`
- `type:feature`
- `type:refinement`

### Área

- `area:security`, `area:privacy`, `area:architecture`, `area:maintainability`
- `area:finance-core`, `area:api`, `area:web`
- `area:ux`, `area:accessibility`, `area:performance`
- `area:ai`, `area:research`, `area:documentation`, `area:operations`

Una issue tendrá una etiqueta de prioridad, una de tipo y una o varias de área. La prioridad se ordena por impacto y riesgo, no por fecha ni por preferencia. No se debe quitar el prefijo histórico de prioridad de los títulos hasta haber creado y aplicado las etiquetas al backlog abierto.

**Estado de aplicación:** en el snapshot auditado de 15-nov-2026, el backlog abierto no tenía estas etiquetas. La conexión de mantenimiento usada para esta intervención no expone una operación para crear etiquetas; por tanto, la taxonomía queda definida, pero su alta y aplicación masiva requieren una acción administrativa posterior. No se afirma que estén aplicadas.

## Cambios de alcance

Una PR no puede ampliar unilateralmente la issue. Un cambio material en API, contratos, datos persistidos, privacidad, dependencias o comportamiento requiere una nueva issue o aprobación explícita. Mejoras oportunistas se documentan como propuestas separadas.
