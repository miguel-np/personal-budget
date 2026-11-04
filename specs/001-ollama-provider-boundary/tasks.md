# Tasks: frontera de proveedor Ollama

**Input**: Documentos de diseño en `specs/001-ollama-provider-boundary/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/model-provider.md`

## Phase 1: Setup

**Purpose**: Preparar la frontera sin nuevas dependencias.

- [x] T001 Crear el contrato neutral `ModelProvider` en `services/api/src/model-provider.ts`.
- [x] T002 Crear el adaptador Ollama en `services/api/src/ollama-provider.ts`.
- [x] T003 Mantener la API de configuración existente y no añadir dependencias ni variables de entorno.

## Phase 2: Foundational

**Purpose**: Conectar el contrato con la orquestación existente sin cambiar el contrato HTTP.

- [x] T004 Inyectar `ModelProvider` en `LocalAiClient` con Ollama como implementación predeterminada en `services/api/src/local-ai.ts`.
- [x] T005 Delegar readiness y llamadas de chat al adaptador, manteniendo prompts, validación, coalescing, timeout, cola y métricas en `LocalAiClient`.
- [x] T006 Añadir el punto de composición opcional `AppDependencies.modelProvider` en `services/api/src/app.ts`.
- [ ] T007 Revisar tipos y ejecutar `npm run typecheck`; corregir cualquier incompatibilidad detectada.

## Phase 3: User Story 1 — Mantener asistente local (Priority: P1)

**Goal**: El asistente de explicaciones sigue funcionando con el adaptador Ollama y no contacta servicios externos.

**Independent Test**: `npm test -- --run services/api/tests/local-ai.test.ts`.

- [x] T008 Añadir prueba de inyección de proveedor sin invocar el transporte Ollama en `services/api/tests/local-ai.test.ts`.
- [x] T009 Añadir pruebas de endpoint loopback, probe y chat normalizado en `services/api/tests/ollama-provider.test.ts`.
- [ ] T010 Verificar explicación, caché de estado, cancelación, cola, concurrencia y métricas mediante la suite existente.

## Phase 4: User Story 2 — Conservar flujos estructurados (Priority: P1)

**Goal**: Clasificación y extracción de intención mantienen JSON estructurado, validación backend y abstención.

- [ ] T011 Verificar que el esquema de extracción de planificación se conserva en `services/api/tests/local-ai.test.ts`.
- [ ] T012 Verificar que la clasificación mantiene JSON y no pasa por sanitización narrativa en `services/api/tests/local-ai.test.ts`.
- [x] T013 Añadir casos del adaptador para JSON mal formado, error HTTP/red y límite explícito de respuesta en `services/api/tests/ollama-provider.test.ts`.

## Phase 5: User Story 3 — Conservar investigación web (Priority: P2)

**Goal**: Tool call validado por backend y búsqueda exacta a través de SearXNG continúan aislados del proveedor.

- [ ] T014 Ejecutar regresión de una tool call exacta y rechazar tool calls múltiples o argumentos alterados en `services/api/tests/local-ai.test.ts`.
- [ ] T015 Comprobar que la inferencia final no recibe tools y no solicita una segunda ejecución en `services/api/tests/local-ai.test.ts`.
- [ ] T016 Confirmar que SearXNG y recuperación documental continúan ejecutándose en backend en `services/api/tests/web-search.test.ts`.

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T017 Ejecutar lint, typecheck, build, cobertura y auditorías.
- [ ] T018 Ejecutar E2E de navegador y verificar que los contratos HTTP no han cambiado.
- [ ] T019 Revisar `docs/local-ai.md`, `docs/architecture.md` y `docs/ai-workflows.md` contra el contrato implementado.
- [ ] T020 Revisar diff completo, confirmar que no cambiaron datos financieros ni hooks de Impeccable y preparar PR para revisión.

## Dependencies & Execution Order

- Setup precede a Foundational.
- Las historias P1 dependen de Foundational y deben validarse antes de ampliar a P2.
- La investigación web se valida después de que el chat normalizado y los mensajes con tool_calls hayan pasado los tests.
- La adopción de proveedores cloud, selector UI, consentimiento, secretos, costes y enrutamiento quedan para una especificación posterior de la issue #85.

## Implementation Strategy

Validar primero la regresión local con datos sintéticos. No fusionar este incremento hasta que T007, T010–T020 estén completadas o sus excepciones queden explícitamente aceptadas por el propietario del proyecto.
