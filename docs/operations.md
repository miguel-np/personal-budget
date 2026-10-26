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

El modo de uso diario fija y comprueba los puertos locales de la API y del frontend descritos a continuación; no publiques estos servicios en interfaces LAN.

## Arranque y parada

La secuencia prevista es: iniciar Actual, confirmar el presupuesto, iniciar Ollama si se usa IA, iniciar backend/frontend y comprobar la pantalla de estado. Detén los procesos con sus comandos de desarrollo o Docker Compose. No borres volúmenes ni carpetas de datos para solucionar errores antes de realizar una copia.

## Actualizaciones

1. Crea y verifica una copia de seguridad.
2. Lee notas de versión de Actual, Ollama y dependencias.
3. Actualiza un componente cada vez.
4. Revisa migraciones, adaptador y compatibilidad de tool calling.
5. Verifica informes y conciliación en un presupuesto de prueba.

No uses `latest` indefinidamente para un sistema con datos importantes; fija versiones conocidas y actualiza con un procedimiento controlado.


## Modo diario implementado

Desde la raíz del repositorio en WSL2:

~~~bash
npm run doctor
npm run start:local
~~~

La interfaz compilada se abre en `http://127.0.0.1:4173` y la API en `http://127.0.0.1:3000`. El comando arranca los dos procesos, comprueba su respuesta y los detiene de forma coordinada al recibir Ctrl+C. Usa `npm run dev:api` y `npm run dev:web` solo durante desarrollo. No mates procesos secundarios de forma aislada ni borres los directorios persistentes para resolver un fallo.

- `GET /health` comprueba que la API responde.
- `GET /ready` distingue API activa de presupuesto configurado; un estado `not_configured` no equivale a que el runtime esté apagado.
- `npm run doctor` diferencia requisitos inválidos de servicios no iniciados. No imprime variables sensibles, credenciales ni datos financieros.
- La UI financiera básica sigue disponible cuando Ollama está desactivado; solo el asistente local queda no disponible.
- Los tests E2E usan fixtures sintéticos aislados y no tocan el directorio `.local`, el presupuesto real ni backups.

La actualización del servidor está automatizada de forma conservadora en [Actualizaciones seguras](safe-updates.md). Las versiones deben estar fijadas y la transición exacta debe estar validada; la restauración de datos requiere confirmación explícita.
