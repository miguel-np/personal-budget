# Personal Budget Constitution

> Estado: borrador de adopción. Los principios siguientes se han extraído de las decisiones, documentación y controles que ya existen en el repositorio. La ratificación del propietario del proyecto sigue pendiente.

## Principios fundamentales

### I. Actual Budget es la única fuente de verdad del libro financiero

Las cuentas, categorías, presupuestos y movimientos permanecen bajo la autoridad de Actual Budget. Personal Budget puede mantener preferencias, planificación, revisiones, patrimonio y metadatos propios en sus almacenes versionados, pero no debe crear una segunda contabilidad ni escrituras dobles. El acceso al SDK de Actual queda encapsulado en `services/actual-adapter`, salvo los scripts operativos documentados.

### II. La exactitud financiera es determinista y explícita

Los importes autoritativos, comparaciones, proyecciones y simulaciones se calculan en backend y `packages/finance-core`, usando unidades monetarias menores enteras y reglas de dominio verificables. No se suman monedas incompatibles sin conversión explícita y fechada. Los datos desconocidos permanecen desconocidos; nunca se convierten silenciosamente en cero. Los datos observados, estimados, candidatos y sugerencias deben distinguirse de forma visible. Un modelo generativo puede explicar resultados, pero no sustituir su cálculo ni inventar cifras.

### III. Local-first y minimización de datos por defecto

Las funciones financieras deben seguir disponibles sin IA ni conexión externa. Ollama es opcional, local y desactivado por defecto; sus endpoints deben permanecer en loopback. La búsqueda web y cualquier proveedor de IA remoto requieren configuración y consentimiento explícitos. No existe fallback silencioso de local a cloud. No se envían movimientos, cuentas, saldos, categorías, objetivos, documentos ni agregados financieros a servicios remotos por defecto. Cada flujo externo debe documentar con precisión qué dato sale, a qué destino y por qué.

### IV. La IA no recibe autoridad sobre el sistema financiero

Los modelos y el contenido externo se consideran no confiables. Ningún modelo obtiene acceso directo a SQL, shell, filesystem, navegador general, APIs administrativas o credenciales. Las herramientas MCP deben ser una lista cerrada, validada, acotada y de solo lectura salvo decisión expresa. Toda escritura financiera debe pasar por validación backend, previsualización y confirmación humana explícita. Un fallo del modelo o de un proveedor no puede provocar cambios financieros ni bloquear las funciones deterministas.

### V. Las fronteras arquitectónicas deben mantenerse

La interfaz web consume la API local; no accede directamente a Actual, Ollama ni al proveedor de búsqueda. La API coordina validación, permisos, persistencia y servicios. `packages/finance-core` conserva contratos de dominio y cálculos independientes de frameworks, SDKs y proveedores. `services/actual-adapter` encapsula Actual. Las futuras integraciones de modelos deben vivir detrás de adaptadores explícitos y no introducir dependencias de proveedor en `finance-core`. Las capacidades no soportadas deben declararse; nunca se simulan.

### VI. Cada cambio debe ser verificable y degradar con seguridad

Los cambios deben añadir pruebas proporcionales al riesgo: unitarias para reglas y cálculos, contractuales para interfaces, integración para fronteras entre componentes y E2E para recorridos de usuario. La CI ordinaria usa datos sintéticos y no depende de bancos reales, secretos, Internet ni modelos descargados. Las pruebas live y la aceptación manual Windows + WSL2 se identifican por separado; una CI sintética no se presenta como evidencia de aceptación live. Lint, typecheck, build, auditorías y pruebas aplicables deben pasar antes de integrar.

### VII. Persistencia, recuperación y privacidad forman parte de la funcionalidad

Los cambios que afecten a almacenes, formatos, documentos o datos financieros deben considerar compatibilidad, backup, restauración y rollback. Los backups deben conservar sus garantías de cifrado, integridad e inventario. No se incluyen secretos, extractos, bases financieras reales, logs sensibles ni copias de seguridad en Git, fixtures, capturas o documentación.

### VIII. Las decisiones y el contexto deben quedar trazables

Los cambios funcionales deben enlazarse a una necesidad o issue, definir criterios de aceptación y actualizar la documentación afectada. Los cambios arquitectónicos requieren una ADR cuando alteran límites, fuentes de verdad, proveedores, persistencia o seguridad. Las especificaciones describen el cambio nuevo, no reescriben retrospectivamente todo el sistema. Las Skills existentes conservan su ámbito: las financieras orientan tareas de dominio; Impeccable se limita a UX/UI y no puede cambiar reglas financieras ni la semántica de datos.

## Restricciones técnicas y de producto

- Mantener el stack y las versiones fijadas del repositorio salvo justificación explícita y pruebas de compatibilidad.
- No añadir telemetría, sincronización bancaria, pagos ni proveedores externos implícitos.
- No exponer claves API al navegador, logs, exportaciones o repositorio.
- Preservar los contratos HTTP existentes salvo que una especificación aprobada requiera su evolución.
- Los límites de contexto, concurrencia, timeout, cancelación y tamaño de respuesta deben seguir aplicándose a las llamadas de IA.
- La búsqueda externa conserva su flujo separado: solo la consulta autorizada sale a SearXNG; no recibe contexto financiero.
- El diseño visual debe partir de `docs/design-system.md` y de los tokens existentes. Una revisión de interfaz no autoriza cambios de comportamiento o de texto factual fuera del alcance acordado.

## Gobierno

Esta constitución complementa —no sustituye— README, ADR, documentación de arquitectura, privacidad, seguridad, contribuciones y criterios de aceptación existentes. Si un plan propone una excepción, debe identificar el principio afectado, justificar la necesidad, describir el riesgo y obtener revisión humana antes de implementar. La comprobación de constitución debe realizarse durante la planificación y de nuevo antes de implementar. Las contradicciones detectadas entre especificación, plan, tareas y código deben resolverse; no se consideran aprobadas por el mero hecho de que el agente las haya generado.

Las modificaciones a estos principios requieren revisión del propietario del proyecto, explicación del impacto y actualización versionada de esta constitución. No se deben inventar reglas para completar una plantilla: los principios aquí recogidos reflejan prácticas y restricciones documentadas en el estado actual del repositorio.

**Versión**: 0.1.0 | **Ratificación**: pendiente de aprobación | **Última modificación**: 2026-11-04
