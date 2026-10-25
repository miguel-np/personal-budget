# Operación local

## Servicios esperados

- Actual Budget server.
- Backend local de `personal-budget`.
- Frontend web de `personal-budget`.
- Ollama cuando se utilice el asistente.
- Servidor MCP por stdio, solo si hay un cliente MCP que lo necesite.

No todos los componentes necesitan ejecutarse si solo quieres usar Actual Budget. Para dashboard y chat, se necesitarán el backend y frontend cuando estén implementados.

## Puertos locales previstos

| Servicio | Puerto habitual | Recomendación |
|---|---:|---|
| Actual Budget | 5006 | Publicar en `127.0.0.1` únicamente |
| Aplicación web | 3000 | Publicar en `127.0.0.1` únicamente |
| API local de Ollama | 11434 | Acceso desde el backend local; no exponer a la LAN |
| MCP stdio | Sin puerto TCP por defecto | Iniciar como proceso hijo/cliente local |

Los puertos son una convención de configuración, no un contrato validado para una implementación existente.

## Arranque y parada

La secuencia prevista es: iniciar Actual, confirmar el presupuesto, iniciar Ollama si se usa IA, iniciar backend/frontend y comprobar la pantalla de estado. Detén los procesos con sus comandos de desarrollo o Docker Compose. No borres volúmenes ni carpetas de datos para solucionar errores antes de realizar una copia.

## Actualizaciones

1. Crea y verifica una copia de seguridad.
2. Lee notas de versión de Actual, Ollama y dependencias.
3. Actualiza un componente cada vez.
4. Revisa migraciones, adaptador y compatibilidad de tool calling.
5. Verifica informes y conciliación en un presupuesto de prueba.

No uses `latest` indefinidamente para un sistema con datos importantes; fija versiones conocidas y actualiza con un procedimiento controlado.
