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
