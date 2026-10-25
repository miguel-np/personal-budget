# MCP: herramientas locales y límites

El servidor experimental se ejecuta por stdio con npm run mcp:serve. Debe lanzarse desde la raíz y requiere la API local en http://127.0.0.1:3000. PERSONAL_BUDGET_API_URL se puede configurar, pero solo se aceptan hosts loopback. No abre un puerto MCP de red.

Herramientas: get_monthly_summary, get_spending_by_category, compare_periods, get_yearly_overview, get_uncategorized_transactions, get_recurring_candidates y simulate_budget_change. Todas son de solo lectura; simulaciones tienen persisted=false y no actualizan Actual. Los movimientos sin categoría no devuelven conceptos ni notas. Los candidatos recurrentes son patrones históricos, no garantías.

El protocolo JSON-RPC por líneas usa stdin/stdout; logs/diagnósticos solo en stderr. La lista de herramientas es cerrada: sin SQL libre, shell, filesystem, red pública ni escrituras. Rechaza parámetros extra, periodos inválidos o mayores de cinco años, respuestas por encima de 64 KiB y más de 24 llamadas por sesión. Las respuestas HTTP se leen con un límite de bytes en streaming, evitando almacenar cuerpos ilimitados antes de comprobar su tamaño. Las peticiones a la API expiran a los cinco segundos por defecto; `PERSONAL_BUDGET_MCP_API_TIMEOUT_MS` permite configurar de 100 a 30000 ms.

Las pruebas de protocolo lanzan el servidor como subproceso y usan una API sintética. Cubren inicialización, catálogo read-only, llamadas válidas, herramientas desconocidas, argumentos inválidos, límite de respuesta, timeout y rechazo de endpoints no loopback. No requieren Internet, Ollama ni datos reales. La interoperabilidad visual con el cliente MCP de escritorio elegido sigue siendo una comprobación manual; no habilitar escrituras desde el modelo.

Además, `services/mcp/tests/sdk-client.test.ts` valida la interoperabilidad con el **cliente oficial del SDK `@modelcontextprotocol/sdk`** (el mismo stack de protocolo que usan los clientes de escritorio): handshake de inicialización, listado de herramientas, llamadas estructuradas y fallos cerrados, contra una API sintética.

Validación en vivo (25-oct-2026): el cliente SDK oficial conectado por stdio al servidor MCP del checkout, con la API local real en `127.0.0.1:3000`, listó las 7 herramientas, devolvió `get_monthly_summary`, `compare_periods` y `simulate_budget_change` con datos reales del presupuesto sintético y rechazó herramientas desconocidas. La comprobación con un cliente de escritorio concreto (Claude Desktop u otro) en el equipo del usuario sigue siendo una verificación opcional adicional.
