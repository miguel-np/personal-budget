# Roadmap de implementación

Este documento fija dirección y criterios de secuenciación. No es un espejo del backlog ni certifica que una issue esté abierta o cerrada: consulta el [backlog de GitHub](https://github.com/miguel-np/personal-budget/issues) y sus PR vinculadas para el ciclo de vida operativo.

## Principios de priorización

1. **Integridad financiera y seguridad primero.** No sacrificar precisión, recuperación, privacidad ni aislamiento local para acelerar nuevas capacidades.
2. **Reducir riesgo estructural antes de ampliar superficie.** Priorizar modularidad, contratos claros, pruebas, accesibilidad y observabilidad cuando el coste de cambio crece.
3. **Exigir evidencia proporcional al riesgo.** Distinguir tests sintéticos, aceptación live, revisión humana especializada y operación en el entorno objetivo.
4. **No convertir experimentos en producto por inercia.** Cada capacidad nueva debe superar los criterios de [política de alcance](scope-policy.md).
5. **Mantener una sola fuente por clase de información.** GitHub gestiona el estado de tareas; [implementation-status.md](implementation-status.md) conserva la evidencia del producto; este roadmap contiene secuencia y decisiones.

## Líneas de trabajo

### 1. Fiabilidad, seguridad y aceptación

Conservar Actual Budget como fuente de verdad, asegurar backups restaurables, mantener CI multiplataforma y probar los límites de los proveedores. Las aceptaciones que requieren tráfico real, configuración local, revisión humana o validación jurídica permanecen separadas de los checks sintéticos.

Referencias de trabajo: [#106](https://github.com/miguel-np/personal-budget/issues/106), [#108](https://github.com/miguel-np/personal-budget/issues/108), [#110](https://github.com/miguel-np/personal-budget/issues/110), [#130](https://github.com/miguel-np/personal-budget/issues/130).

### 2. Mantenibilidad y experiencia de contribución

Reducir módulos con demasiadas responsabilidades mediante extracciones incrementales, empezando por límites de dominio probados. Mejorar guías, plantillas, trazabilidad, accesibilidad y gobernanza sin introducir refactors masivos ni nuevas dependencias innecesarias.

Referencias: [#126 — gobernanza y mantenibilidad](https://github.com/miguel-np/personal-budget/issues/126), [#124 — auditoría transversal de UI y accesibilidad](https://github.com/miguel-np/personal-budget/issues/124).

### 3. Capacidades opcionales y dependencias externas

La investigación web, los proveedores de IA y las herramientas fiscales deben mantener consentimiento, privacidad local-first, evidencia verificable y abstención ante incertidumbre. La expansión de proveedores necesita una decisión explícita de privacidad y capacidades. El calendario fiscal no debe inferir obligaciones a partir de datos financieros.

Referencias: [#84](https://github.com/miguel-np/personal-budget/issues/84), [#85](https://github.com/miguel-np/personal-budget/issues/85), [#87](https://github.com/miguel-np/personal-budget/issues/87).

### 4. Exploración arquitectónica condicionada por evidencia

No sustituir Actual ni introducir almacenamiento paralelo por anticipación. Primero debe existir un ADR que compare coste, integridad, licencias, consistencia y migración; un prototipo posterior solo se justifica con una hipótesis medible y fixtures sintéticas.

Referencias: [#66 — decisión sobre Actual](https://github.com/miguel-np/personal-budget/issues/66) y [#67 — prototipo de lectura condicionado](https://github.com/miguel-np/personal-budget/issues/67).

## Criterios de secuenciación

- Resolver primero riesgos de datos, seguridad, recuperación y bloqueos de aceptación que invaliden afirmaciones de producto.
- Aceptar refactors por dominio, con una PR por límite de responsabilidad y tests de contrato antes/después.
- No abrir trabajo de una dependencia si su decisión previa no lo justifica.
- No duplicar el seguimiento de issues en listas marcadas manualmente dentro de documentación.
- Revisar esta dirección cuando cambien la arquitectura, las restricciones de privacidad, el modelo de mantenimiento o la evidencia de uso.
