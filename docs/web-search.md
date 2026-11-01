# Búsqueda web controlada y evidencia oficial (#84)

## Alcance y separación de datos

La búsqueda externa es investigación pública opt-in, desactivada por defecto. No habilita navegación autónoma, scraping general, JavaScript, acceso a red local ni herramientas arbitrarias.

Son dos flujos aislados:
- El chat financiero sigue sin herramientas y recibe únicamente los agregados previstos por backend.
- La investigación web no consulta `BudgetRepository` ni carga cuentas, movimientos, saldos, categorías, objetivos, compromisos o agregados financieros.
- El modelo Ollama recibe exclusivamente la consulta aprobada, el contexto fiscal que el usuario introduce expresamente y los resultados/documentos externos acotados.
- La herramienta de búsqueda ejecuta una consulta exacta; la recuperación documental posterior se realiza en backend contra una allowlist de organismos oficiales.

## Activación, consentimiento y privacidad de salida

Se requiere `AI_ENABLED=true`, `WEB_SEARCH_ENABLED=true`, un modelo Ollama con tool calling y un SearXNG configurado. El consentimiento se solicita en cada envío y se invalida al cambiar consulta o modo.

SearXNG y sus motores upstream reciben solo la consulta exacta aprobada. Tras obtener resultados, el backend puede solicitar hasta tres documentos oficiales relacionados. El texto de esos documentos se procesa en memoria, no se persiste como historial ni se incluye en logs. No se envían cookies, credenciales ni el contexto financiero. La recuperación documental se activa como parte de la misma petición consentida.

SearXNG local no implica que los términos permanezcan en el equipo: la instancia puede consultar motores upstream. Esos servicios ven la consulta y la IP pública de salida de SearXNG/proxy. Los fetches documentales posteriores conectan desde el servidor de la aplicación con los dominios oficiales allowlisted; esos organismos pueden observar la IP pública de salida del servidor y la URL solicitada. Revisa las políticas de los motores upstream y la conectividad del servidor antes de habilitar la función.

## Proveedor y controles de red

### Búsqueda

`SearXNGSearchProvider` implementa `WebSearchProvider` y usa su API JSON. Se permiten HTTP solo para loopback configurado; los endpoints remotos requieren HTTPS. No se permiten credenciales, query, fragment ni path en el origin.

El proveedor limita consulta, respuesta, timeout, resultados y tasa; valida el DNS, fija una IP pública para la petición y rechaza redirects. Las URLs de resultados deben ser HTTPS, sin credenciales, puertos no estándar ni direcciones IP directas. Los dominios se filtran antes de mostrar los resultados.

### Recuperación de documentos oficiales

La búsqueda conserva `OFFICIAL_SOURCE_DOMAINS` como grupos de filtrado elegibles por el usuario. Esos grupos **no son permisos de descarga**. La clasificación institucional y la recuperación de documentos requieren coincidencia exacta con `OFFICIAL_SOURCE_HOSTS`; no se confía en todos los subdominios de un dominio permitido.

Hosts exactos aprobados en esta iteración:
- AEAT: `sede.agenciatributaria.gob.es`.
- BOE: `boe.es`, `www.boe.es`.
- Ministerio de Hacienda: `hacienda.gob.es`, `www.hacienda.gob.es`.
- DGT: `petete.tributos.hacienda.gob.es`, `sede.tributos.hacienda.gob.es`.
- TEAC: `serviciostelematicosext.hacienda.gob.es`, `sede.tea.hacienda.gob.es`.
- Seguridad Social: `seg-social.es`, `www.seg-social.es`.
- Xunta/DOG y Lex.gal: `xunta.gal`, `www.xunta.gal`, `sede.xunta.gal`, `facenda.xunta.gal`, `dog.gal`, `lex.gal`.
- CNMV: `cnmv.es`, `www.cnmv.es`.
- Banco de España: `bde.es`, `www.bde.es`, `sedeelectronica.bde.es`.

La lista se mantiene explícita y conservadora. Añadir un host requiere validar su titularidad institucional y finalidad; un subdominio nuevo no hereda confianza automáticamente. Los grupos de filtro siguen siendo cómodos: por ejemplo, seleccionar `boe.es` incluye `www.boe.es` porque ambos están en la lista exacta. En modo general pueden aparecer fuentes externas, pero solo los hosts de la lista exacta se clasifican como oficiales y se pueden recuperar en backend.

Los dominios oficiales se clasifican por separado: publicación normativa, doctrina DGT, criterios/resoluciones TEAC, Ministerio de Hacienda, información AEAT y otros organismos. La clasificación indica procedencia, no convierte una consulta o resolución concreta en vinculante. Un host allowlisted limita el destino técnico; no demuestra por sí solo que una página concreta sea auténtica, vigente o jurídicamente aplicable.

Para cada búsqueda se recuperan como máximo tres resultados oficiales. Se aceptan solo HTTPS y hosts allowlisted, se validan todas las direcciones DNS como públicas y se fija la IP resuelta. No se siguen redirecciones. La descarga individual tiene un timeout limitado y límites de tamaño: HTML/texto hasta 1 MiB, metadatos BOE hasta 96 KiB y análisis BOE hasta 192 KiB. La recuperación se cancela junto con la petición original. No se ejecuta JavaScript y no se envían credenciales/cookies.

Los formatos HTML/XHTML/texto plano se convierten a texto legible, eliminando scripts, estilos y controles comunes. El modelo recibe extractos relevantes acotados, no un espejo completo del documento. PDF y formatos desconocidos no se interpretan en esta iteración: se muestran como no compatibles/no recuperados y se conserva el enlace original.

## Tratamiento específico del BOE

Cuando un resultado contiene un identificador validado `BOE-A-AAAA-NNNN`, el adaptador utiliza únicamente endpoints fijos de la API oficial de legislación consolidada:
- `/datosabiertos/api/legislacion-consolidada/id/{id}/metadatos`.
- `/datosabiertos/api/legislacion-consolidada/id/{id}/analisis`.
- `/buscar/act.php?id={id}` para la representación HTML consolidada.

Se extraen, cuando existen, fecha de publicación, fecha de entrada en vigor, fecha de actualización registral, indicadores explícitos de derogación/anulación/agotamiento, estado de consolidación y relaciones anteriores/posteriores (por ejemplo, modificaciones y derogaciones). La evaluación se calcula contra la fecha de referencia que el usuario indicó en modo fiscal. Una fecha futura de derogación/anulación no se presenta como efectiva en la fecha de referencia; una marca sin fecha deja el resultado como insuficiente.

El frontend muestra las fechas y el estado como metadatos registrados por BOE, no como una decisión jurídica propia. Los estados «sin marca de derogación/anulación/agotamiento» y «consolidación finalizada» no equivalen a una garantía de vigencia legal.

**Límites jurídicos esenciales:**
- El propio BOE indica que el texto consolidado es informativo y carece de valor jurídico; para fines jurídicos debe consultarse la publicación oficial.
- La consolidación incorpora modificaciones expresas y correcciones; no acredita derogaciones tácitas.
- Una ficha de norma no resuelve la vigencia parcial por artículo, normas transitorias, aplicación a hechos concretos ni la normativa autonómica/local concurrente.
- Una consolidación desactualizada o pendiente puede no incorporar una modificación publicada recientemente.
- La fecha de publicación no es la fecha de entrada en vigor, y ninguna fecha del buscador sustituye a los metadatos oficiales.

Por tanto, el adaptador aporta evidencia documental/temporal verificable y transparencia sobre sus límites; no es un motor jurídico ni certifica la vigencia aplicable.

## Jerarquía y discrepancias

La síntesis debe separar:
1. **Norma publicada:** texto de ley, real decreto, orden o disposición en BOE/DOG y su publicación original.
2. **Criterios administrativos:** consultas/doctrina DGT y resoluciones/criterios TEAC. Su naturaleza y eventual efecto vinculante dependen del documento y de las normas aplicables; no se presume por dominio.
3. **Guías e información administrativa:** AEAT, Ministerio y otros organismos; útiles para trámites/interpretación, pero no deben describirse como norma.
4. **Fuentes externas:** contexto secundario, nunca sustituto automático de fuente primaria en una afirmación normativa.

Las discrepancias se deben hacer visibles con organismo, tipo de documento y fechas. No se escoge automáticamente el documento más reciente. Si no hay fuente primaria, si el documento no se recupera o si la evidencia temporal no es suficiente, la respuesta debe abstenerse de una conclusión normativa y señalar qué documento debe revisarse.

## Modo fiscal

Exige jurisdicción principal, materia/impuesto/trámite, ejercicio fiscal, año de presentación y fecha de referencia. Admite, cuando sean pertinentes y el usuario los conozca, comunidad autónoma, municipio, tipo de contribuyente (persona física, autónomo/actividad económica, sociedad u otro) y fecha del hecho u operación.

`referenceDate` es la fecha contra la que se evalúan los metadatos temporales BOE. `eventDate` describe la fecha del hecho u operación investigada y puede ser distinta; el modelo debe mantener ambas separadas. No se infiere residencia fiscal, municipio, actividad, régimen ni circunstancias personales desde el presupuesto, movimientos o ubicación. Los campos opcionales son contexto explícito para Ollama local y nunca se concatenan a la consulta enviada a SearXNG. No introduzcas NIF, nombres, datos de contacto ni otros identificadores personales.

La síntesis diferencia ejercicio fiscal de año de presentación y publicación de entrada en vigor. Debe separar hechos respaldados por texto/metadatos, interpretación y circunstancias no conocidas. No presenta el resultado como asesoramiento fiscal profesional ni garantiza una declaración o trámite.

## Tool calling e instrucciones no confiables

Ollama recibe una sola herramienta fija `web_search` con un argumento `query`. El backend exige una llamada única y coincidencia exacta con el texto aprobado; una consulta modificada o más herramientas falla cerrada. La segunda inferencia recibe resultados/extractos como contenido externo no confiable y no tiene herramientas. IDs de cita se validan contra las fuentes devueltas; sin fuentes o citas válidas no se presenta una conclusión.

Títulos, fragmentos, HTML y documentos se tratan como datos, nunca como instrucciones. El modelo no accede a navegador, shell, filesystem, APIs internas, Actual ni herramientas MCP.

## Configuración

- `WEB_SEARCH_ENABLED`: `false` por defecto.
- `WEB_SEARCH_BASE_URL`: origin de SearXNG; HTTP loopback o HTTPS remoto.
- `WEB_SEARCH_TIMEOUT_SECONDS`: timeout de búsqueda y de cada solicitud documental.
- `WEB_SEARCH_MAX_RESULTS`: 1–8 resultados de búsqueda.
- `WEB_SEARCH_MAX_QUERY_CHARS`: 20–500 caracteres.
- `WEB_SEARCH_MAX_RESPONSE_KB`: 8–256 KiB para JSON del buscador.

La recuperación oficial no añade nuevos secretos ni variables. Mantiene límites fijos conservadores y usa la fecha de referencia fiscal ya capturada en el formulario.

## Validación y límites restantes

Los tests sintéticos cubren validación de proveedor, bloqueo de destinos/redirects, tamaño, filtros de dominio, consulta exacta, aislamiento financiero, prompt injection, referencias y metadatos temporales BOE (fecha ausente, derogación anterior/posterior, consolidación desactualizada). No realizan peticiones reales a organismos.

La cobertura de documentos reales requiere aceptación manual con SearXNG y fuentes oficiales: BOE con identificador consolidado, DGT, TEAC, AEAT y DOG/Lex.gal. Se debe confirmar que el servicio accesible devuelve HTML/JSON esperado. No hay parser PDF ni motor de análisis artículo a artículo, derogación tácita, transitorias, jurisprudencia o conflictos jurídicos complejos. Esos casos siguen requiriendo revisión del documento original y no pueden marcarse como resueltos solo con pruebas sintéticas.
