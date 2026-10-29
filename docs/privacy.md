# Privacidad y flujo de datos

## Objetivo

La aplicación está diseñada para uso local y privado. Los datos de movimientos deben permanecer en Actual Budget en tu equipo/servidor local; el asistente debe operar con el mínimo contexto necesario para responder cada pregunta.

## Qué datos procesa

- Transacciones, fechas, importes, divisas, descripciones y categorías del presupuesto.
- Nombres de cuentas, categorías y presupuestos existentes en Actual.
- Preguntas que el usuario escribe en el chat.
- Resultados agregados generados por herramientas financieras.
- Configuración del modelo y preferencias de interfaz.

Los datos reales no deben utilizarse en fixtures, capturas, logs ni pruebas automatizadas.

## Qué se envía fuera del equipo

La arquitectura objetivo no requiere enviar transacciones ni prompts a una API de IA en la nube. Sin embargo, el software puede establecer conexiones externas para descargar instaladores, dependencias, imágenes de contenedor, actualizaciones y modelos. Si se configura una URL de inferencia remota o un modelo de nube a través de Ollama, los datos enviados a esa API dejarían de estar limitados al equipo.

Por ello:

- Utiliza la API local de Ollama (`127.0.0.1:11434`), no un endpoint alojado.
- No habilites sincronización bancaria automática en la configuración inicial.
- No incluyas analítica o telemetría de terceros.
- Revisa las llamadas de red y dependencias antes de publicar una versión.
- Para una garantía más fuerte, usa firewall con política de salida restringida después de instalar dependencias y modelos.

## Historial del chat

El valor por defecto propuesto es no persistir conversaciones. Si se añade historial local, debe ser opcional, indicar qué se guarda y permitir borrarlo. El sistema no debe guardar automáticamente todos los datos financieros devueltos por herramientas en cada mensaje.

## Logs

Los logs operativos deben limitarse a estado de servicio, duración, código de error y un identificador no sensible. No registrar textos completos de transacciones, saldos, mensajes de usuario, resultados de herramientas, tokens ni contraseñas.

## Centro de inteligencia financiera

El centro calcula hallazgos en la API local. El estado de revisión almacena solo ID, huella y metadatos de estado; no conserva importes, descripciones ni movimientos. El panel calcula la tasa de descarte localmente a partir de revisiones explícitas, sin enviarla fuera del dispositivo. La explicación con IA es explícita y opcional: envía una síntesis agregada y reglas/limitaciones a Ollama local; no se envían filas de transacciones ni notas. Si Ollama está desactivado o no disponible, el análisis determinista continúa. El archivo financial-intelligence-state.json está en el directorio local de datos de la API y no forma parte del backup cifrado del volumen de Actual Budget; consérvalo por separado si deseas preservar las revisiones.

## Límites

«Local» no equivale a «cifrado automáticamente». Los archivos locales pueden ser leídos por otros procesos o usuarios con acceso al mismo sistema. Protege la cuenta del sistema operativo, cifra el disco y cifra las copias de seguridad. Revisa también las políticas y la configuración de Docker Desktop, Windows, WSL y el proveedor de modelos.
