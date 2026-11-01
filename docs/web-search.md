# Búsqueda web controlada y fuentes oficiales (#84)

## Alcance

La búsqueda web está diseñada para investigación actual y contrastable, especialmente normativa/fiscalidad. No habilita navegación autónoma, scraping, JavaScript, acceso a la red local ni herramientas generales del modelo.

Es un flujo diferente del chat financiero:
- el chat financiero sigue sin herramientas y recibe agregados calculados por backend;
- la investigación web no consulta el repositorio ni recibe cuentas, movimientos, importes, categorías, objetivos, compromisos ni agregados financieros;
- el proveedor externo recibe únicamente la consulta exacta que la persona escribe y confirma.

## Activación y consentimiento

La búsqueda permanece deshabilitada por defecto. Deben cumplirse todas estas condiciones:

1. Configurar AI_ENABLED=true y WEB_SEARCH_ENABLED=true.
2. Instalar/configurar un modelo Ollama compatible con tool calling estructurado.
3. Configurar una instancia SearXNG accesible.
4. En cada petición, escribir la consulta y marcar la casilla de consentimiento explícito.

La UI explica que la consulta saldrá del equipo. El consentimiento no se guarda como permiso permanente: se vuelve a pedir en cada búsqueda.

## Proveedor SearXNG

El adaptador implementado utiliza la API JSON de SearXNG (/search?q=…&format=json). El origin se configura mediante WEB_SEARCH_BASE_URL.

- **Local/autohospedado:** default http://127.0.0.1:8080; el servicio debe escuchar solo en loopback o estar expuesto localmente mediante un proxy/forward controlado.
- **Remoto:** solo HTTPS, sin credenciales incrustadas, query, fragment ni path en la variable de configuración. Revisa las condiciones del proveedor.
- La instancia SearXNG debe permitir el formato JSON. Su configuración determina qué motores upstream reciben la consulta.

Una instancia local no garantiza por sí sola que la consulta no salga al exterior: SearXNG suele consultar motores configurados. El operador debe revisar y limitar esos motores, su ubicación y sus políticas. La IP pública visible para los motores es la de salida de SearXNG/proxy, no la IP del navegador enviada desde el chat.

La abstracción WebSearchProvider desacopla al cliente de IA del proveedor de búsqueda; SearXNG es el adaptador configurado en esta versión. Un proveedor diferente puede incorporarse implementando el mismo contrato y aplicando las mismas reglas de salida, límites y filtrado.

## Flujo de ejecución

1. El usuario confirma una consulta exacta y, si procede, dominios oficiales permitidos.
2. La API valida consent=true, longitud, modo, campos fiscales y whitelist de dominios.
3. Ollama recibe un prompt específico de investigación y una única herramienta web_search, cuyo argumento solo puede ser query.
4. El backend exige exactamente una llamada y que el valor de query coincida con el texto autorizado. Si el modelo lo amplía, elimina, altera o emite más herramientas, no se ejecuta la búsqueda.
5. El backend busca usando SearXNG, limita resultados/tamaño/tiempo y filtra URLs y dominios.
6. Los fragmentos devueltos se presentan al modelo como datos no confiables, en un mensaje de herramienta. La segunda inferencia no recibe herramientas.
7. La UI presenta síntesis, proveedor, fecha de búsqueda y enlaces originales.

La API no descarga las páginas enlazadas. No debe describirse un fragmento de búsqueda como lectura íntegra de la ley, sentencia, consulta vinculante o resolución. El usuario debe abrir la fuente original antes de basar en ella una decisión.

## Fuentes oficiales y filtros

Dominios oficiales admitidos como filtros:
- Agencia Estatal de Administración Tributaria: agenciatributaria.gob.es.
- Boletín Oficial del Estado: boe.es.
- Ministerio de Hacienda y páginas de criterios/consultas: hacienda.gob.es.
- Seguridad Social: seg-social.es.
- Xunta de Galicia y Diario Oficial de Galicia: xunta.gal, dog.gal.
- Comisión Nacional del Mercado de Valores: cnmv.es.
- Banco de España: bde.es.

En modo fiscal, si no se selecciona un subconjunto, el backend limita la búsqueda a esos dominios. En modo general, el campo vacío no restringe por dominio. Un filtro por dominio reduce resultados, pero no garantiza que una página sea primaria, vinculante ni vigente.

### Jerarquía y tipos de fuente

La UI distingue:
- **Normativa publicada:** resultado alojado en BOE o DOG.
- **Criterio administrativo:** resultado alojado en Hacienda.
- **Organismo oficial:** otros organismos/administraciones de la whitelist.
- **Fuente externa:** resultado no oficial, solo cuando el modo general lo permite.

Esta clasificación es una heurística de dominio. No determina la fuerza jurídica del documento ni sustituye la revisión de su naturaleza. Una ley, un reglamento, una consulta vinculante, una resolución, una FAQ y una nota informativa no tienen la misma jerarquía.

## Consultas fiscales y normativas

El modo fiscal exige introducir expresamente:
- jurisdicción (por ejemplo, Estado y comunidad autónoma cuando proceda);
- impuesto, materia o trámite;
- ejercicio fiscal;
- año de presentación;
- fecha de referencia para estudiar vigencia.

No se infiere residencia fiscal, municipio, actividad, régimen, deducciones ni obligaciones a partir de transacciones o ubicación del dispositivo.

La síntesis debe:
- distinguir ejercicio fiscal de año de presentación;
- identificar el tipo de fuente y organismo;
- mantener referencias [S1], [S2] y enlaces visibles;
- diferenciar hechos reflejados en los fragmentos de interpretación del modelo;
- señalar cuando el resultado no incluye publicación, entrada en vigor, modificación, derogación o disposición transitoria suficiente;
- hacer explícitas fuentes contradictorias o evidencia incompleta;
- recomendar comprobar el texto oficial y acudir a asesor/organismo cuando dependa de circunstancias personales.

**Limitación importante:** el proveedor devuelve snippets y fechas declaradas por el buscador; el backend no lee el documento completo ni verifica automáticamente vigencia normativa. Una fecha de publicación del resultado no equivale a fecha de entrada en vigor ni prueba aplicabilidad al contribuyente. Cuando la vigencia no esté acreditada por la evidencia retornada, la respuesta debe expresarlo.

No es asesoramiento fiscal profesional ni genera/declarara obligaciones tributarias.

## Seguridad y límites técnicos

- WEB_SEARCH_ENABLED=false por defecto; consentimiento por petición.
- Máximo una herramienta fija web_search, una búsqueda y ningún fetch de páginas.
- Consulta de 2–500 caracteres; el límite configurable de búsqueda es 20–500.
- Hasta ocho resultados; timeout configurable de 1–30 segundos y respuesta JSON limitada a 8–256 KiB.
- Rate limit local del endpoint: seis peticiones/minuto por proceso.
- Solo HTTP en loopback para SearXNG local; destinos remotos por HTTPS.
- Resolución DNS comprobada; se rechazan destinos privados, reservados, link-local, metadata, .local y .internal; la IP resuelta se fija para esa petición para reducir DNS rebinding.
- Redirecciones HTTP rechazadas.
- Resultados limitados a HTTPS, sin credenciales/puerto no estándar ni destinos IP directos; dominios se validan antes de mostrar.
- Snippets/títulos se limpian, limitan y tratan como contenido no confiable; nunca pueden redefinir prompts ni activar otra herramienta.
- El modelo no obtiene conectividad de red directa, navegador, shell, filesystem, APIs internas ni herramientas MCP.
- No se almacenan consultas, resultados ni historial de navegación; los logs operativos no contienen el texto de consulta.

El control de DNS/IP reduce SSRF, pero la seguridad también depende del host SearXNG, de su proxy y sus motores. Mantén el proveedor aislado y actualizado.

## Configuración

Variables de entorno documentadas en configuration.md:
- WEB_SEARCH_ENABLED
- WEB_SEARCH_BASE_URL
- WEB_SEARCH_TIMEOUT_SECONDS
- WEB_SEARCH_MAX_RESULTS
- WEB_SEARCH_MAX_QUERY_CHARS
- WEB_SEARCH_MAX_RESPONSE_KB

Se requiere también AI_ENABLED=true, OLLAMA_MODEL y un runtime/modelo con tool calling compatible. Un modelo sin tool calling devuelve una limitación explícita y no provoca una búsqueda.

## Validación

Los tests sintéticos cubren:
- límites, filtros de dominio, redirecciones y tamaño de respuesta;
- consentimiento desactivado por defecto y rate limit;
- igualdad exacta entre consulta aprobada y argumentos de herramienta;
- ausencia de llamadas al repositorio financiero desde la ruta de búsqueda;
- una herramienta en la primera inferencia y ninguna en la segunda;
- rechazo de query modificada por modelo;
- fixtures oficiales sintéticas y metadata fiscal.

La CI no realiza búsquedas reales ni requiere una clave/servicio de búsqueda externo. El ensayo manual debe usar datos no sensibles y una instancia SearXNG controlada.
