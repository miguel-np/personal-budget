# Sistema de diseño

## Principios

El sistema visual usa CSS y componentes React existentes, sin añadir una librería pesada ni telemetría. La identidad es de finanzas locales: jerarquía clara, baja competencia visual, densidad moderada y cifras comparables sin depender solo del color.

## Tokens

Los tokens globales viven en `apps/web/src/styles.css`:

- Superficies: lienzo, panel, panel elevado, sidebar y controles.
- Bordes: sutil, normal y fuerte.
- Texto: primario, secundario y terciario.
- Marca y foco: acento y contorno de teclado visible.
- Estados semánticos: positivo, negativo y advertencia con superficies relacionadas.
- Espaciado en múltiplos de 4 px, radios compartidos, sombra de panel y duración de movimiento.

Los componentes nuevos deben usar estos tokens y evitar valores hexadecimales repetidos o medidas arbitrarias.

## Estados y accesibilidad

Los controles deben tener reposo, hover, foco, activo y desactivado; los mensajes identifican espera, éxito, aviso y error. El estado no se comunica solo mediante color. Se respeta `prefers-reduced-motion`, y los campos/botones conservan foco de teclado.

## Reglas responsive

- Escritorio: navegación lateral y paneles en dos columnas cuando el espacio lo permite.
- Tablet: navegación horizontal, cuadrículas reducidas y filtros reorganizados.
- Móvil: prioridad a indicadores y acciones frecuentes, navegación horizontal contenida y tablas desplazables dentro de su región.
- No se oculta información financiera clave para ajustar el layout.

La referencia viva es la propia aplicación con sus pruebas de navegador sintéticas; las capturas no sustituyen componentes funcionales.

## Aplicación de accesibilidad y pruebas de aceptación (#36)

- El primer elemento de la shell es un enlace visible al recibir foco para saltar la navegación; el destino principal es enfocable.
- Al navegar entre secciones, el foco pasa al título principal actualizado, sin robar el foco durante la carga inicial.
- Las regiones de tablas anchas tienen nombre accesible y pueden recibir foco para desplazamiento horizontal local; la página completa no debe desbordarse.
- Los controles de acción frecuentes usan un objetivo de 44 × 44 CSS px cuando corresponde. Los campos visibles deben tener una etiqueta programática; los placeholders no sustituyen a una etiqueta.
- El contraste se valida sobre los elementos textuales financieros prioritarios. La comprobación automatizada es una señal de regresión, no una certificación completa.
- Se respetan las preferencias de movimiento reducido existentes. La revisión manual sigue comprobando teclado, foco, zoom, árbol de accesibilidad/lector de pantalla y tareas completas.
- Los datos de las pruebas y capturas de aceptación son sintéticos.
