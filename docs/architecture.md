# Arquitectura

## Resumen

Personal Budget es una aplicación web local. El navegador se comunica con la API Fastify en loopback; el backend coordina el adaptador oficial de Actual, los cálculos deterministas, el estado propio y las inferencias locales. El navegador no accede directamente a la base de datos financiera, a Ollama ni al proveedor de búsqueda.

~~~mermaid
flowchart TD
  U[Browser localhost] --> W[React + TypeScript]
  W --> B[API local Fastify]
  B --> A[Actual adapter]
  A --> AB[Actual Budget]
  B --> F[finance-core determinista]
  B --> L[LocalAiClient / ModelProvider]
  L --> O[Ollama adapter · loopback]
  B --> S[SearXNG configurado · solo consentimiento]
  S --> X[Motores upstream del buscador]
  B --> P[Almacenes locales versionados]
  M[MCP stdio · read-only] --> B
~~~

## Componentes

| Componente | Responsabilidad | Límite principal |
|---|---|---|
| Frontend | Dashboard, formularios, gráficos, chat y confirmaciones | No guarda credenciales ni llama directamente a Actual/Ollama/SearXNG. |
| Backend | Validación, ámbito, permisos, límites, cálculo coordinado y persistencia | Escucha en loopback por defecto. |
| packages/finance-core | Contratos de dominio y cálculos financieros deterministas | No conoce SDK ni transporte del proveedor. |
| services/actual-adapter | Inicializar @actual-app/api, abrir presupuesto y adaptar estructuras/errores | Único paquete runtime que importa el SDK. |
| Actual Budget | Fuente de verdad de cuentas, categorías, presupuestos y movimientos | No se modifica SQLite ni archivos internos directamente. |
| Estado propio | Preferencias, planificación, revisiones, alertas, patrimonio y metadata documental | No duplica movimientos; cada almacén se inventaría en backup. |
| Asistente financiero | Explicación cualitativa de agregados calculados por backend | No recibe herramientas, filas de movimientos ni permisos de escritura. |
| Investigación web | Buscar el texto explícito aprobado por el usuario y devolver fuentes acotadas | Una única herramienta backend; sin contexto financiero, navegación general ni fetch arbitrario de páginas. |
| ModelProvider | Contrato normalizado para probe, capacidades y chat | No contiene lógica financiera ni ejecuta herramientas. |
| Ollama adapter | Transporte específico para `/api/tags` y `/api/chat` | Loopback obligatorio; tool calls se devuelven como datos sin ejecutar. |
| LocalAiClient | Orquestación de prompts, límites, cola, cancelación, caché y métricas | Usa Ollama por defecto; no cambia datos financieros ni el contrato HTTP. |
| SearXNG | Adaptador de búsqueda configurado por el operador | Local loopback o remoto HTTPS; puede remitir la consulta a motores upstream. |
| MCP | Herramientas revisadas para clientes locales | Transporte stdio, solo lectura. |

## Fuente de verdad y dominio financiero

Actual Budget conserva la fuente de verdad. services/api depende de BudgetRepository y de contratos neutrales declarados en finance-core. El adaptador traduce tipos y errores específicos de Actual; los scripts operativos son excepciones documentadas. La suite de conformidad permite probar otro proveedor sin sustituir automáticamente el libro de datos.

Los cálculos se realizan con importes en unidades menores enteras. Las monedas distintas no se suman sin conversión local explícita y fechada; los datos desconocidos permanecen desconocidos, no se convierten en cero.

## Flujos de datos de IA

### Chat financiero

1. API valida periodo, divisa y ámbito global de cuentas.
2. Backend obtiene los movimientos mediante el adaptador.
3. finance-core calcula los agregados.
4. La API serializa un contexto compacto y limitado para Ollama local.
5. El modelo devuelve una explicación cualitativa; la UI presenta los importes autoritativos por separado.

El chat no tiene herramientas. No puede consultar datos adicionales, navegar, escribir movimientos ni cambiar presupuestos. La disponibilidad de Ollama no condiciona las demás funciones financieras.

### Investigación web independiente (#84)

1. La persona abre el panel de búsqueda, escribe la consulta y marca un consentimiento explícito para esa petición.
2. El frontend envía solo la consulta autorizada, modo general/fiscal y, en modo fiscal, jurisdicción, materia, ejercicio fiscal, año de presentación y fecha de referencia.
3. La API valida el consentimiento, longitud, dominios permitidos, límites de uso y configuración. No llama a repository ni consulta cuentas, movimientos, saldos, categorías u objetivos.
4. Ollama recibe la consulta y una única definición fija de herramienta web_search. El backend exige que el modelo llame exactamente a esa herramienta una vez y que el argumento query coincida byte por byte con la consulta aprobada.
5. El backend ejecuta el proveedor SearXNG configurado, valida su destino, limita tiempo y respuesta, rechaza redirecciones y filtra enlaces/resúmenes. Solo los resultados acotados se devuelven como contenido no confiable.
6. Ollama realiza una segunda inferencia sin herramientas para sintetizar hallazgos y referencias [S1], [S2], etc. La UI presenta los enlaces originales para revisión humana.

El modelo no recibe red general, navegador, shell, filesystem, API interna, herramientas MCP arbitrarias ni acceso a la cuenta financiera. Tras la búsqueda, el backend puede recuperar hasta tres documentos oficiales desde una allowlist cerrada de hosts HTTPS: valida DNS público, fija la IP resuelta, rechaza redirects, limita tiempo/tamaño y no envía cookies ni credenciales. Para normas BOE-A consulta metadatos y relaciones de legislación consolidada; para HTML/texto oficial extrae un fragmento en memoria. La recuperación no se ejecuta en hosts externos no oficiales y no persiste documentos ni extractos. El modelo recibe solo evidencia acotada y sigue sin herramientas en la segunda inferencia. El texto consolidado BOE es informativo y no resuelve derogaciones tácitas, reglas transitorias ni aplicación concreta.

## Límites de alcance

- No hay conexión bancaria automática.
- No hay asesoramiento profesional fiscal, de inversión o crédito.
- No se ejecutan pagos ni acciones externas a partir de resultados web.
- No se ejecuta código generado por el modelo.
- No hay navegación autónoma, scraping general ni JavaScript arbitrario.
- No hay telemetría de terceros por defecto.
- Los resultados web son externos y no confiables; la fecha del buscador no acredita por sí misma vigencia normativa.

## Inteligencia financiera

finance-core conserva los cálculos de flujo de caja, propuestas presupuestarias y reglas de alerta como funciones deterministas. La API resuelve el ámbito global, obtiene datos mediante el adaptador y aplica tasas locales. El saldo inicial de flujo de caja usa el saldo actual que Actual expone; no se denomina saldo bancario disponible si la fuente no proporciona esa semántica.

## Recursos y límites de IA local

- Disponibilidad de Ollama cacheada durante 5 segundos.
- Contexto compacto y JSON válido, con presupuesto de caracteres/tokens estimados.
- Hasta dos inferencias simultáneas y cuatro en cola por cliente.
- Cancelación y timeout propagados; sin reintentos automáticos.
- Métricas locales sin prompts, cuentas, categorías, movimientos ni importes.
- El modo web utiliza la cola limitada de Ollama y una búsqueda por petición; el endpoint tiene un rate limit local y un límite de resultados/bytes.

Con Ollama desactivado o no disponible, las funciones financieras deterministas continúan operativas. La búsqueda externa permanece deshabilitada salvo configuración explícita.
