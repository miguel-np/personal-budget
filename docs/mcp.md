# MCP: herramientas locales y límites

El servidor experimental se ejecuta por stdio con npm run mcp:serve. Debe lanzarse desde la raíz y requiere la API local en http://127.0.0.1:3000. PERSONAL_BUDGET_API_URL se puede configurar, pero solo se aceptan hosts loopback. No abre un puerto MCP de red.

Herramientas: get_monthly_summary, get_spending_by_category, compare_periods, get_yearly_overview, get_uncategorized_transactions, get_recurring_candidates y simulate_budget_change. Todas son de solo lectura; simulaciones tienen persisted=false y no actualizan Actual. Los movimientos sin categoría no devuelven conceptos ni notas. Los candidatos recurrentes son patrones históricos, no garantías.

El protocolo JSON-RPC por líneas usa stdin/stdout; logs/diagnósticos solo en stderr. La lista de herramientas es cerrada: sin SQL libre, shell, filesystem, red pública ni escrituras. Rechaza parámetros extra, periodos inválidos o mayores de cinco años, respuestas por encima de 64 KiB y más de 24 llamadas por sesión. Las peticiones a la API expiran a los cinco segundos.

Las pruebas usan un servidor sintético; no requieren Internet, Ollama ni datos reales. Falta validar manualmente la integración con el cliente MCP de escritorio elegido. No habilitar escrituras desde el modelo.
