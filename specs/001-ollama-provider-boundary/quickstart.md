# Quickstart: validar la frontera Ollama

Ejecutar desde WSL, en la raíz del repositorio, con Node.js 24.22.1 y dependencias instaladas.

```bash
npm ci
npm test -- services/api/tests/ollama-provider.test.ts services/api/tests/local-ai.test.ts
npm run lint
npm run typecheck
npm run build
npm run test:coverage
npm run audit
npm run audit:production
```

La suite ordinaria usa respuestas HTTP sintéticas y no necesita Ollama real, claves API ni acceso a Internet.

Para aceptación live opcional, utilizar únicamente un modelo instalado localmente y preguntas sintéticas. No usar presupuestos o movimientos personales reales para capturas o fixtures.

## Comprobaciones manuales

1. Con `AI_ENABLED=false`, el estado IA debe seguir desactivado y no realizar peticiones.
2. Con Ollama activo y modelo presente, `GET /api/v1/assistant/status` debe seguir devolviendo `available`.
3. Con Ollama detenido, el asistente debe devolver el error saneado existente; dashboard, movimientos, presupuestos e informes deben seguir disponibles.
4. La configuración con endpoint remoto para Ollama debe seguir rechazándose.
5. La investigación web debe seguir exigiendo consentimiento y ejecutar solo la consulta exacta aprobada mediante el backend.
6. Confirmar que `.codex/hooks.json` sigue conteniendo los hooks existentes de Impeccable, sin handlers nuevos de Spec Kit.

La aceptación live no sustituye los tests sintéticos y debe quedar identificada como tal.
