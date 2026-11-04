# Implementation Plan: frontera de proveedor Ollama

**Branch**: `chore/adopt-spec-kit` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

## Summary

Introducir un contrato interno mínimo para proveedores de modelos y encapsular la API HTTP actual de Ollama en un adaptador. `LocalAiClient` conserva la orquestación de casos de uso (prompts, validación del contexto, cola, coalescing, métricas, consentimiento y políticas de seguridad), pero delega el transporte, el mapeo de payloads y la normalización de respuestas al proveedor.

El primer incremento implementa únicamente Ollama. No añade proveedores remotos, selección de proveedor, almacenamiento de secretos ni nuevas rutas HTTP. Los cambios actuales están preparados en esta rama y requieren validación local.

## Technical Context

- **Language/Version**: TypeScript 6.0.3 sobre Node.js 24.22.1 Active LTS.
- **Primary Dependencies**: Fastify 5.12.7, Zod 4.6.7, Vitest 5.0.5; no se añaden dependencias.
- **Storage**: Ninguno. El contrato de proveedor y sus mensajes son efímeros; no hay migración ni persistencia nueva.
- **Testing**: Vitest con respuestas HTTP sintéticas; no requiere Ollama instalado ni Internet.
- **Target Platform**: API local en Windows + WSL2 (Ubuntu recomendado), con conexiones a modelos locales en loopback.
- **Project Type**: Monorepo TypeScript con API Fastify, frontend React/Vite y paquetes de dominio.
- **Performance Goals**: Conservar la concurrencia máxima de dos inferencias y la cola máxima de cuatro; no añadir un salto de red ni serialización adicional fuera del adaptador.
- **Constraints**: Endpoint Ollama en loopback, sin credenciales embebidas; timeout y cancelación propagados; límites de contexto/salida conservados; sin fallback remoto; logs sin prompts, importes, claves o respuestas completas.
- **Scale/Scope**: Refactor interno de la API IA existente; cuatro usos actuales (explicación, clasificación, planificación e investigación web).

## Design

### Contrato

`services/api/src/model-provider.ts` define:
- Identidad de proveedor y capacidades declaradas para salida estructurada, tool calling y streaming.
- Estado de disponibilidad por modelo.
- Mensajes, opciones, formato estructurado y herramientas como datos tipados.
- Una respuesta normalizada con contenido y tool calls separados.
- Un error de proveedor genérico que no expone detalles de transporte.

El contrato no contiene métodos para ejecutar herramientas, leer finanzas, acceder al filesystem ni persistir datos.

### Adaptador Ollama

`services/api/src/ollama-provider.ts`:
- Valida URL loopback y ausencia de credenciales.
- Consulta `/api/tags` para saber si el modelo está disponible.
- Traduce solicitudes normalizadas a `/api/chat` con `stream: false`.
- Normaliza `message.content` y `message.tool_calls`.
- Convierte errores HTTP, de red y JSON a un error estable.
- Devuelve tool calls como datos; nunca las ejecuta.

### Orquestación

`LocalAiClient` mantiene el comportamiento del producto y recibe un `ModelProvider`. Por defecto crea `OllamaProvider`; el punto de inyección de `AppDependencies` permite probar o componer otra implementación en el futuro. Las decisiones de autorización y ejecución de herramientas siguen en la API.

No se cambia el significado de los endpoints públicos ni el contexto financiero que reciben los modelos.

## Constitution Check

- [x] Actual Budget permanece como fuente de verdad; no se toca `finance-core`.
- [x] Los cálculos financieros continúan fuera del modelo.
- [x] Ollama continúa limitado a loopback; no se añade proveedor cloud.
- [x] El proveedor no puede ejecutar tools; backend valida la búsqueda.
- [x] No se añaden dependencias ni persistencia.
- [x] Se escriben pruebas sintéticas; la validación local sigue pendiente.
- [x] No se cambian endpoints públicos ni la UI.
- [x] Se conserva documentación y trazabilidad del issue #85.

## Project Structure

```text
services/api/src/
├── model-provider.ts       # Contrato neutral del proveedor
├── ollama-provider.ts      # Transporte y payloads específicos Ollama
├── local-ai.ts             # Orquestación y reglas del dominio IA
└── app.ts                  # Composición e inyección del proveedor

services/api/tests/
├── ollama-provider.test.ts # Contrato y errores del adaptador
└── local-ai.test.ts        # Regresión de los casos de uso existentes

specs/001-ollama-provider-boundary/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── model-provider.md
└── tasks.md
```

**Structure Decision**: Mantener el contrato y el adaptador en `services/api/src`: el proveedor de modelos solo se utiliza desde el servicio API y no constituye dominio financiero compartido. Si un segundo consumidor real aparece, revisar la ubicación con una nueva decisión; no crear ahora un paquete prematuro.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Contrato + adaptador separados | Aislar detalles de Ollama y permitir adaptadores independientes | Mantener HTTP en LocalAiClient hace que cada nuevo proveedor vuelva a mezclar transporte y orquestación |
| Inyección opcional en AppDependencies | Permitir sustitución controlada y pruebas | El singleton hard-coded impide probar el contrato desde la composición de la API |

No se introduce un sistema de plugins, registro dinámico, descubrimiento remoto, streaming ni SDK universal.
