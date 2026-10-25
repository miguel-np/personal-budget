# Desarrollo

## Estado actual

Existe un workspace inicial en packages/finance-core, services/actual-adapter, services/api y apps/web. La shell web es provisional; el flujo completo de movimientos, importación, dashboard y chat queda pendiente. No considerar P0 terminado hasta que CI pase y el adaptador se valide contra Actual Budget local.

## Entorno

- Windows + WSL2, Ubuntu recomendado.
- Node.js 24.22.1 y npm compatibles.
- Docker/Compose para Actual Budget.
- Ollama solo para una fase futura; no es requisito de los tests normales.

Mantén el código dentro del filesystem Linux de WSL. Nunca uses datos personales reales en fixtures o ejemplos.

## Estructura

~~~text
personal-budget/
├── apps/web/                 # React/Vite shell
├── services/api/             # Fastify local
├── services/actual-adapter/  # adaptador @actual-app/api
├── packages/finance-core/    # tipos y cálculos puros
├── docs/
└── compose.yaml
~~~

## Comandos

~~~bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
npm run dev:api
npm run dev:web
~~~

## Pruebas mínimas

- Cálculos exactos en unidades monetarias menores.
- Límites de mes/año y años bisiestos.
- Transferencias internas excluidas del gasto consolidado.
- Reembolsos, categorías ausentes, importes extremos y transacciones divididas.
- Validación del adaptador y ciclo de vida.
- Configuración que prohíbe hosts y URLs remotos.
- Errores de API saneados y límites de parámetros.
- Integración contra una instancia de Actual con datos sintéticos.
- Auditoría de dependencias y revisión de secretos en CI.

La suite ordinaria no debe necesitar credenciales, banco real, Internet ni un modelo real. Las pruebas de aceptación de Ollama/Actual pueden ser optativas, pero necesarias antes de afirmar que la integración está validada.

## Clean Code y SOLID

Las rutas HTTP dependen de la interfaz BudgetRepository, no de Actual directamente. El núcleo financiero no depende del framework web, de Actual ni de IA. El adaptador encapsula el ciclo de vida y serializa el uso de la API de Actual. Los cambios de contrato deben incluir pruebas y documentación. Prioriza funciones pequeñas, nombres explícitos, validación en fronteras y abstracciones justificadas.
