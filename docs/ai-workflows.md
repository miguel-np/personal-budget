# Workflows y Skills de IA para Personal Budget

## Alcance

Este repositorio incorpora perfiles de trabajo compatibles con el formato de Skills de Codex en `.agents/skills/` y cinco prompts MCP seleccionables. Las Skills orientan a un agente de desarrollo o a un asistente que las cargue explícitamente; los prompts MCP orientan a clientes MCP compatibles. **No se cargan automáticamente en el chat Ollama integrado**: ese chat conserva su contrato sin herramientas.

Los flujos están diseñados para reutilizar los cálculos existentes de `finance-core`, Actual Budget como fuente de verdad y el servidor MCP limitado. No introducen un segundo libro financiero, agentes autónomos, conexiones bancarias, pagos ni escrituras.

## Skills incluidas

| Skill | Cuándo usarla | Herramientas MCP principales |
|---|---|---|
| `personal-finance-review` | Revisión de un periodo y comparación temporal | `compare_periods`, `get_financial_findings`, `get_spending_by_category` |
| `budget-coach` | Interpretar alertas y evaluar ajustes | `get_budget_alerts`, `get_budget_improvement_context`, `simulate_budget_change` |
| `cash-flow-review` | Revisar previsión de liquidez | `project_cash_flow`, `get_recurring_candidates` |
| `recurring-payment-audit` | Revisar patrones candidatos de recurrencia | `get_recurring_candidates` |
| `wealth-review` | Revisar patrimonio y cobertura | `get_net_worth_summary` |
| `tax-research` | Investigar información fiscal pública con fuentes | Flujo de investigación web de la aplicación; no requiere ni recibe datos financieros MCP |
| `impeccable` | Diseñar, criticar, auditar y refinar UX/UI | No aplica a análisis financiero ni a reglas del dominio |

## Prompts MCP

- `monthly_financial_review`: requiere fechas de periodo actual y de comparación.
- `budget_coaching`: admite mes y ventana histórica de 3, 6 o 12 meses.
- `cash_flow_review`: admite horizonte de 7, 30 o 90 días.
- `recurring_payment_audit`: requiere fechas de inicio y fin.
- `wealth_review`: no requiere argumentos.

## Reglas de uso

1. Los importes, porcentajes, comparaciones y proyecciones autoritativas proceden del backend; el modelo no recalcula ni inventa cifras.
2. Distinguir `observed`, `estimated`, `candidate` y `suggestion`. Un candidato recurrente no demuestra que exista una suscripción o un cargo futuro.
3. Un patrimonio con cobertura incompleta no se presenta como total consolidado. Si `netWorthMinor` es `null`, explicar el motivo y no fabricar una cifra alternativa.
4. Las propuestas presupuestarias son hipótesis revisables. Usar simulaciones no persistentes; no guardar escenarios ni cambiar categorías, objetivos o presupuestos desde estos flujos.
5. La proyección de caja es un estimado basado en saldos comunicados por Actual, movimientos futuros registrados, compromisos y recurrencias confirmadas. No equivale a saldo bancario disponible o garantizado.
6. Para investigación fiscal, exigir que la persona indique jurisdicción, materia, ejercicio y fecha de referencia; usar fuentes oficiales y mantener la búsqueda externa separada del contexto financiero.
7. No enviar movimientos, extractos, nombres, cuentas ni documentos a proveedores cloud sin una autorización independiente y explícita. No hay fallback remoto implícito.

## Seguridad y privacidad

- MCP continúa por stdio, dirigido a una API loopback, con lista de herramientas cerrada, límites de llamadas, timeout y tamaño de respuesta.
- Se omiten identificadores de cuentas/activos y de eventos cuando no son necesarios para explicar los resultados.
- El servidor MCP no expone shell, SQL, filesystem, navegación general ni herramientas de escritura.
- El chat local integrado no recibe herramientas. Un cliente MCP externo sí recibe los datos que solicite; comprueba dónde los procesa ese cliente antes de conectarlo.
- No incluyas `.env`, exportaciones, extractos ni backups en Skills o prompts.

## Desarrollo asistido

- **Impeccable** se limita a interfaces web y experiencia de usuario. Debe respetar `docs/design-system.md` y no puede cambiar semántica financiera, cálculos, textos factuales o flujos de escritura fuera del alcance de una tarea.
- **GitHub Spec Kit** se está adoptando para estructurar cambios funcionales: especificación, plan, tareas, revisión de consistencia, implementación y convergencia. La adopción de Codex se documenta en [spec-kit-adoption.md](spec-kit-adoption.md). Mientras no se ejecute y verifique el CLI en un checkout local, sus Skills `$speckit-*` no deben considerarse instaladas.
- Las Skills financieras siguen siendo las instrucciones especializadas de dominio. Spec Kit las complementa; no las sustituye.

Consulta [MCP](mcp.md), [IA local](local-ai.md), [privacidad](privacy.md) y [flujo de caja](cash-flow.md).
