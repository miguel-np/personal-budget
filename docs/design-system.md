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

Los controles deben tener reposo, hover, foco, activo y desactivado; los mensajes identifican espera, éxito, aviso y error. El estado no se comunica solo mediante color. Se respeta `prefers-reduced-motion`, y los campos/botones conservan foco de teclado. Los controles principales y destinos de navegación mantienen objetivos de al menos 44 × 44 CSS px; no se admiten excepciones compactas que reduzcan la zona pulsable de una acción. Los nombres de campo, importes, celdas y encabezados de tablas deben priorizar legibilidad: tamaño base de 12 px para etiquetas e importes tabulares y al menos 11 px para encabezados compactos.

## Reglas responsive

- Escritorio: navegación lateral y paneles en dos columnas cuando el espacio lo permite.
- Tablet: navegación horizontal, cuadrículas reducidas y filtros reorganizados.
- Móvil: prioridad a indicadores y acciones frecuentes, navegación horizontal contenida y tablas desplazables dentro de su región.
- No se oculta información financiera clave para ajustar el layout.

La referencia viva es la propia aplicación con sus pruebas de navegador sintéticas; las capturas no sustituyen componentes funcionales.

## Aplicación de accesibilidad y pruebas de aceptación (#36)

- El primer elemento de la shell es un enlace visible al recibir foco para saltar la navegación; el destino principal es enfocable.
- Al navegar entre secciones, el foco pasa al título principal actualizado, sin robar el foco durante la carga inicial.
- Las regiones de tablas anchas tienen nombre accesible y pueden recibir foco para desplazamiento horizontal local; la tabla de proyección debe seguir esta misma regla. La página completa no debe desbordarse.
- Los controles de acción frecuentes usan un objetivo de 44 × 44 CSS px cuando corresponde. Los campos visibles deben tener una etiqueta programática; los placeholders no sustituyen a una etiqueta.
- El contraste de los textos financieros prioritarios se comprueba en tema claro y oscuro sobre el color de fondo compuesto por sus ancestros, con 4,5:1 para texto normal y 3:1 para texto grande. La comprobación automatizada es una señal de regresión, no una certificación completa.
- Se respetan las preferencias de movimiento reducido existentes. La revisión manual sigue comprobando teclado, foco, zoom, árbol de accesibilidad/lector de pantalla y tareas completas.
- La regresión responsive recorre las doce secciones en ambos temas y en 320, 375, 390, 768, 1024 y 1440 CSS px. Los datos de las pruebas y capturas de aceptación son sintéticos.
