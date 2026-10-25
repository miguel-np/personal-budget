# IA local con Ollama

## Función de la IA

La IA interpreta preguntas en lenguaje natural, decide qué herramienta aprobada necesita y explica los resultados. Los agregados, tasas, diferencias y previsiones deben calcularse en código con reglas reproducibles.

## Configuración objetivo

- Ejecutar Ollama en el mismo equipo y preferiblemente en el mismo entorno WSL que el backend.
- Usar el endpoint local `http://127.0.0.1:11434`.
- Configurar `OLLAMA_MODEL` con un modelo instalado.
- No usar endpoints de nube si el requisito es mantener prompts y resultados localmente.
- No guardar contenido financiero completo en logs.

La API y las capacidades de Ollama pueden evolucionar. Consulta la [documentación oficial de la API](https://docs.ollama.com/api). La API local no requiere una API key por defecto, pero los endpoints de nube sí tienen sus propios requisitos.

## Selección de modelo

No se define un modelo único en esta especificación. La elección depende de:

- RAM/VRAM disponible y velocidad aceptable.
- Calidad en español.
- Resistencia a prompt injection.
- Soporte de tool calling en el modelo y la versión de Ollama.
- Licencia y condiciones de redistribución/uso del modelo.

Un modelo descargado no queda automáticamente cubierto por la licencia MIT del proyecto. Revisa los términos del modelo concreto.

## Contrato de respuesta

El backend debe entregar al modelo solo los agregados necesarios para cada pregunta. La respuesta debe:

1. Citar el periodo, la cuenta o categoría analizada.
2. Mostrar divisa y unidad.
3. Separar cifras verificadas de proyecciones.
4. Explicar datos ausentes y supuestos.
5. No presentar una respuesta de IA como asesoramiento financiero profesional.
6. No inventar movimientos, categorías, importes o resultados de herramientas.

## Tool calling

El soporte de API compatible no garantiza que un modelo determinado pueda emitir llamadas a herramientas correctas. Antes de usar un modelo con MCP, prueba la conversión de argumentos, el ciclo herramienta→resultado→respuesta, límites de llamadas y manejo de errores con datos sintéticos.

## Fallos

Si Ollama no está disponible, el registro manual, las importaciones a través de Actual y los informes deterministas deben seguir funcionando. La app debe indicar que el asistente no está disponible en vez de simular un resultado.
