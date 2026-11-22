# Catálogo de funcionalidades

Esta guía explica qué puedes hacer en Personal Budget, para qué sirve cada sección y qué límites debes tener presentes. Los nombres coinciden con la navegación de la aplicación.

Personal Budget no sustituye a Actual Budget: añade una interfaz y herramientas de análisis sobre el presupuesto que ya gestionas en Actual.

## Las doce secciones principales

### 1. Resumen

**Para qué sirve:** ver de un vistazo cómo han evolucionado tus finanzas durante un periodo.

Incluye indicadores de ingresos, gastos, ahorro neto y tasa de ahorro cuando el cálculo es válido, además de distribución por categorías y evolución temporal. Los resultados dependen del periodo, las cuentas seleccionadas y la divisa de análisis.

**Cómo utilizarlo:** elige el periodo y revisa primero el ámbito de cuentas y la divisa. Si comparas periodos, asegúrate de que ambos tienen una duración comparable.

**Límite:** los traspasos entre cuentas propias no deben interpretarse como ingresos o gastos consolidados. Los importes de divisas incompatibles no se suman sin conversión válida.

### 2. Movimientos

**Para qué sirve:** consultar, buscar, filtrar y gestionar operaciones del presupuesto.

Incluye movimientos, transferencias y operaciones divididas. Permite registrar y editar operaciones y realizar importaciones locales CSV/OFX con previsualización antes de confirmar la escritura en Actual.

**Cómo utilizarlo:** filtra por periodo, cuenta o categoría; revisa los detalles y verifica la previsualización antes de confirmar una importación o modificación.

**Límites:** la aplicación no inicia sesión en tu banco ni descarga movimientos automáticamente. OFX admite perfiles concretos documentados en [Importación OFX](ofx-import.md). La detección de duplicados y la conciliación deben revisarse antes de confirmar lotes grandes.

### 3. Cuentas

**Para qué sirve:** consultar las cuentas existentes en el presupuesto de Actual y decidir qué cuentas participan en los análisis.

El ámbito global puede incluir todas las cuentas abiertas o solo una selección explícita. La selección vacía significa cero cuentas, no todas.

**Cómo utilizarlo:** revisa el nombre, saldo, divisa y estado de las cuentas. Ajusta el ámbito de análisis desde las preferencias disponibles.

**Límite:** el ámbito es una preferencia de análisis local; no crea usuarios, permisos multiusuario ni cuentas nuevas en Actual.

### 4. Patrimonio y documentos

**Para qué sirve:** complementar el presupuesto con una visión de activos, pasivos y justificantes.

Permite clasificar cuentas de Actual como activo o pasivo, registrar activos y pasivos externos, añadir valoraciones manuales fechadas y guardar documentos privados vinculados a movimientos existentes.

**Cómo utilizarlo:** registra cada elemento con su importe, divisa, fecha y procedencia. Mantén las valoraciones actualizadas y vincula justificantes al movimiento correcto.

**Límites:** una valoración manual no es una operación de inversión ni un movimiento. No se infiere rentabilidad, precio de mercado ni liquidez. Los documentos son privados y deben incluirse en los backups; no los compartas al pedir soporte.

### 5. Informes

**Para qué sirve:** analizar periodos y conservar una copia legible de los resultados.

Incluye informes por periodo y comparación, categorías, ingresos y gastos. La exportación permite generar PDF imprimible, Excel (XLSX), CSV y JSON según el flujo disponible.

**Cómo utilizarlo:** selecciona el periodo, comprueba las cuentas y la divisa y después exporta. En PDF, el navegador abre una vista de impresión: elige «Guardar como PDF».

**Límites:** las exportaciones se generan localmente. Un informe exportado no es una copia de seguridad restaurable del presupuesto.

### 6. Presupuestos

**Para qué sirve:** comparar las asignaciones de Actual Budget con el gasto observado y revisar alertas locales.

Las alertas se calculan bajo demanda y se muestran dentro de la aplicación. No hay notificaciones push, correo, daemon ni alertas del sistema operativo.

**Cómo utilizarlo:** revisa la categoría, el periodo, el importe asignado y el gasto utilizado. Investiga las alertas antes de cambiar una asignación.

**Límite:** una alerta no modifica el presupuesto. Las propuestas y simulaciones no deben confundirse con cambios aplicados en Actual.

### 7. Planificación

**Para qué sirve:** detectar patrones y estudiar escenarios futuros.

Incluye:
- **Pagos recurrentes candidatos:** patrones históricos de fechas e importes que podrían corresponder a pagos periódicos.
- **Sugerencias de categoría:** propuestas para movimientos sin clasificar, basadas en evidencia determinista y, opcionalmente, IA local.
- **Previsiones:** simulaciones de cambios de gasto o ingresos con supuestos y horizonte definidos.

**Cómo utilizarlo:** revisa las señales y advertencias de cada candidato. Previsualiza las sugerencias y confirma explícitamente las que quieras aplicar.

**Límites:** un candidato recurrente no confirma una suscripción ni garantiza un cargo futuro. Una previsión es una estimación, no una promesa. La IA opcional puede abstenerse y requerir revisión manual.

### 8. Inteligencia financiera

**Para qué sirve:** encontrar cambios o anomalías que merecen atención.

Reúne hallazgos deterministas, comparaciones, anomalías, movimientos sin clasificar y desviaciones presupuestarias cuando existen datos comparables. Cada hallazgo debe mostrar regla, periodo, ámbito, evidencia y limitaciones.

**Cómo utilizarlo:** abre un hallazgo, comprueba sus evidencias y decide si necesita revisión. Puedes registrar decisiones cuando el flujo lo permita.

**Límites:** una variación de gasto no demuestra por sí sola su causa. Los hallazgos no son asesoramiento financiero ni predicciones.

### 9. Revisión financiera

**Para qué sirve:** realizar una revisión guiada semanal o mensual.

Resume el periodo, compara ventanas equivalentes y reúne hallazgos que conviene comprobar. Se genera cuando la persona la solicita.

**Cómo utilizarlo:** selecciona el tipo de revisión y fecha de referencia, lee el corte temporal y comprueba si el periodo está completo antes de tomar decisiones.

**Límites:** no crea tareas en segundo plano ni envía notificaciones. Un periodo que incluye el día actual puede estar incompleto.

### 10. Objetivos

**Para qué sirve:** registrar metas de ahorro y compromisos futuros.

Permite crear y mantener objetivos, supuestos de ingresos/gastos, aportaciones deseadas y compromisos manuales puntuales o recurrentes. Incluye simulaciones de escenarios.

**Cómo utilizarlo:** crea un objetivo, introduce el importe y fecha deseados y revisa los supuestos que utiliza la proyección. Añade compromisos solo cuando los hayas verificado.

**Límites:** crear un objetivo o compromiso no realiza pagos ni crea movimientos en Actual. Las proyecciones dependen de los datos y supuestos disponibles.

### 11. Asistente

**Para qué sirve:** formular preguntas en lenguaje natural sobre resultados financieros calculados por el backend.

Utiliza Ollama local y está desactivado por defecto. El backend calcula las cifras; el modelo genera una explicación cualitativa separada.

**Cómo utilizarlo:** instala Ollama, descarga un modelo compatible, configura las variables indicadas en [IA local](local-ai.md) y activa expresamente la función.

**Límites:** el asistente integrado no dispone de herramientas, no navega por Internet, no lee ficheros y no modifica Actual. Si Ollama no está disponible, las funciones financieras deterministas siguen funcionando.

### 12. Configuración

**Para qué sirve:** ajustar las preferencias de análisis y consultar la configuración de la aplicación.

Incluye preferencias de divisa, ámbito de cuentas y otros ajustes locales que se muestran en la interfaz.

**Cómo utilizarlo:** cambia solo los valores que entiendas y conserva los defaults seguros. Las variables de servicios y proveedores se configuran en el fichero local `.env`, no en el navegador.

**Límite:** no compartas el fichero `.env` ni publiques la API en una interfaz de red.

## Funciones transversales e integraciones opcionales

| Función | Qué hace | Qué no hace |
|---|---|---|
| Importación CSV/OFX | Lee ficheros locales, previsualiza y confirma registros normalizados. | No solicita credenciales bancarias ni inicia conexiones con el banco. |
| Exportación | Genera informes y movimientos en formatos portables. | No crea un backup restaurable. |
| Multidivisa | Convierte importes usando tipos de cambio manuales/locales y fechados. | No consulta cotizaciones automáticas. |
| Ollama | Ejecuta inferencia local opcional para asistente y clasificación híbrida. | No es necesario para cálculos ni gestión básica. |
| Investigación web | Envía una consulta exacta autorizada a SearXNG y recupera fuentes acotadas. | No envía el contexto financiero ni habilita navegación arbitraria. |
| MCP | Expone herramientas financieras de lectura y simulación no persistente por stdio. | No ofrece shell, SQL libre, filesystem ni escrituras financieras. |
| Backup y restauración | Cifra y recupera Actual junto con el estado propio inventariado y documentos. | No sustituye conservar la clave de cifrado fuera del equipo. |

## Conceptos que conviene recordar

- **Fuente de verdad:** Actual Budget conserva las cuentas, movimientos, categorías y presupuestos.
- **Estimación:** resultado calculado a partir de datos y supuestos; no es una garantía.
- **Candidato:** patrón que requiere confirmación humana.
- **Previsualización:** muestra lo que se va a cambiar antes de confirmar.
- **Confirmación:** acción explícita que permite persistir una modificación.
- **Divisa desconocida:** no se sustituye silenciosamente por EUR ni se suma como si fuera conocida.

Para entender los términos, consulta el [glosario](glossary.md). Para aprender los flujos paso a paso, consulta la [guía de uso](usage.md).
