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

El proveedor limita consulta, respuesta, timeout, resultados y tasa; valida todas las respuestas DNS contra rangos especiales/no globales de IANA aplicando las excepciones con prefijo más específico ([IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry), [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry)), fija una IP pública para la petición y rechaza redirects. Las URLs de resultados deben ser HTTPS, sin credenciales, puertos no estándar ni direcciones IP directas. Los dominios se filtran antes de mostrar los resultados.

### Recuperación de documentos oficiales

La búsqueda conserva `OFFICIAL_SOURCE_DOMAINS` como grupos de filtrado elegibles por el usuario. Esos grupos **no son permisos de descarga**. La clasificación institucional y la recuperación de documentos requieren coincidencia exacta con `OFFICIAL_SOURCE_HOSTS`; no se confía en todos los subdominios de un dominio permitido.

Hosts exactos aprobados en esta iteración:
- AEAT: `sede.agenciatributaria.gob.es`.
- BOE: `boe.es`, `www.boe.es`.
- Ministerio de Hacienda: `hacienda.gob.es`, `www.hacienda.gob.es`.
- DGT: `petete.tributos.hacienda.gob.es`, `sede.tributos.hacienda.gob.es`.
- TEAC: `serviciostelematicosext.hacienda.gob.es`, `sede.tea.hacienda.gob.es`.
- Seguridad Social: `seg-social.es`, `www.seg-social.es`, `sede.seg-social.gob.es`, `portal.seg-social.gob.es`.
- Xunta/DOG y Lex.gal: `xunta.gal`, `www.xunta.gal`, `sede.xunta.gal`, `facenda.xunta.gal`, `lex.gal` y `www.lex.gal`. La Xunta enlaza la base consolidada desde su portal de transparencia. Las páginas de la edición del DOG se reconocen solo en la ruta `/diario-oficial-galicia/` del host oficial de la Xunta.
- CNMV: `cnmv.es`, `www.cnmv.es`.
- Banco de España: `bde.es`, `www.bde.es`, `sedeelectronica.bde.es`.

La lista se mantiene explícita y conservadora. Añadir un host requiere validar su titularidad institucional y finalidad; un subdominio nuevo no hereda confianza automáticamente. El dominio `dog.gal` no se considera oficial ni descargable por esta integración: no se ha verificado su titularidad institucional. Las publicaciones del DOG se reconocen únicamente en la ruta de edición electrónica del portal oficial de la Xunta (`www.xunta.gal/diario-oficial-galicia/`). Los grupos de filtro siguen siendo cómodos: por ejemplo, seleccionar `boe.es` incluye `www.boe.es` porque ambos están en la lista exacta. En modo general pueden aparecer fuentes externas, pero solo los hosts de la lista exacta se clasifican como oficiales y se pueden recuperar en backend.

Los dominios oficiales se clasifican por separado: publicación normativa, doctrina DGT, criterios/resoluciones TEAC, Ministerio de Hacienda, información AEAT y otros organismos. La clasificación indica procedencia, no convierte una consulta o resolución concreta en vinculante. Un host allowlisted limita el destino técnico; no demuestra por sí solo que una página concreta sea auténtica, vigente o jurídicamente aplicable.

Para cada búsqueda se recuperan como máximo tres resultados oficiales. Se aceptan solo HTTPS y hosts allowlisted, se validan todas las direcciones DNS como públicas y se fija la IP resuelta. No se siguen redirecciones. La descarga individual tiene un timeout limitado y límites de tamaño: HTML/texto hasta 1 MiB, metadatos BOE hasta 96 KiB y análisis BOE hasta 192 KiB. La recuperación se cancela junto con la petición original. No se ejecuta JavaScript y no se envían credenciales/cookies.

Los formatos HTML/XHTML/texto plano se convierten a texto legible, eliminando scripts, estilos y controles comunes. El modelo recibe extractos relevantes acotados, no un espejo completo del documento. PDF y formatos desconocidos no se interpretan en esta iteración: se muestran como no compatibles/no recuperados y se conserva el enlace original.

## Tratamiento específico del BOE

Cuando un resultado contiene un identificador validado `BOE-A-AAAA-NNNN`, el adaptador utiliza únicamente endpoints fijos de la API oficial de legislación consolidada:
- `/datosabiertos/api/legislacion-consolidada/id/{id}/metadatos`.
- `/datosabiertos/api/legislacion-consolidada/id/{id}/analisis`.
- `/buscar/act.php?id={id}` para la representación HTML consolidada. Esta ruta aporta la representación consolidada disponible en el momento de la consulta; no se interpreta como una instantánea histórica.

Se extraen, cuando existen, fecha de publicación, fecha de entrada en vigor, fecha de actualización registral, indicadores explícitos de derogación/anulación/agotamiento, estado de consolidación y relaciones anteriores/posteriores (por ejemplo, modificaciones y derogaciones). La evaluación se calcula contra la fecha de referencia que el usuario indicó en modo fiscal. Una fecha futura de derogación/anulación no se presenta como efectiva en la fecha de referencia; una marca sin fecha deja el resultado como insuficiente.

El frontend muestra las fechas y el estado como metadatos registrados por BOE, no como una decisión jurídica propia. La interfaz también expone la limitación de que el extracto HTML es la consolidación más reciente y no representa automáticamente el texto aplicable en `eventDate`. Los estados «sin marca de derogación/anulación/agotamiento» y «consolidación finalizada» no equivalen a una garantía de vigencia legal.

**Límites jurídicos esenciales:**
- El propio BOE indica que el texto consolidado es informativo y carece de valor jurídico; para fines jurídicos debe consultarse la publicación oficial.
- La consolidación incorpora modificaciones expresas y correcciones; no acredita derogaciones tácitas.
- Una ficha de norma no resuelve la vigencia parcial por artículo, normas transitorias, aplicación a hechos concretos ni la normativa autonómica/local concurrente.
- Una consolidación desactualizada o pendiente puede no incorporar una modificación publicada recientemente.
- La fecha de publicación no es la fecha de entrada en vigor, y ninguna fecha del buscador sustituye a los metadatos oficiales.

### Versiones históricas y vigencia por artículo

La API oficial del BOE documenta recursos adicionales para el texto consolidado: `/texto` (XML con todas las versiones), `/texto/indice` y `/texto/bloque/{id_bloque}`. Cada bloque identifica su tipo/título y agrupa versiones con `fecha_publicacion`, `fecha_vigencia` e `id_norma`. Estos recursos permiten una futura selección y trazabilidad de la redacción por bloque y fecha.

**No están integrados por el adaptador actual.** Actualmente se recupera la representación HTML consolidada más reciente, junto con metadatos y relaciones. La fecha `referenceDate` solo evalúa las marcas temporales de la ficha; `eventDate` no selecciona la versión histórica del texto. Por ello, una respuesta no puede afirmar qué redacción de un artículo regía en la fecha del hecho basándose únicamente en el extracto actual. Debe declararse la insuficiencia y remitirse a la publicación original y al historial de versiones/modificadoras oficiales. La selección histórica por bloque y su verificación frente a publicaciones originales quedan pendientes de implementación y pruebas.

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

Los tests sintéticos cubren validación de proveedor, bloqueo de destinos/redirects, tamaño, filtros de dominio, consulta exacta, aislamiento financiero, prompt injection, referencias y metadatos temporales BOE (fecha ausente, derogación anterior/posterior, anulación, agotamiento y consolidación desactualizada). También comprueban que las cuatro limitaciones jurídicas principales se conservan al pasar la evidencia al modelo: consolidación informativa, ausencia de acreditación de derogaciones tácitas, límites de vigencia parcial/transitorias y falta de reconstrucción histórica por artículo. No realizan peticiones reales a organismos.

Las PR #99–#104 endurecieron la frontera de confianza de hosts, el contexto fiscal, DNS/SSRF y la comunicación de límites históricos BOE. La clasificación de un host indica procedencia técnica, no autenticidad, fuerza vinculante ni aplicabilidad de un documento concreto.

**Lex.gal:** se trata como recurso de información/consolidación jurídica desarrollado conjuntamente por el Parlamento de Galicia, la Xunta, la Universidade de Santiago de Compostela y AMTEGA, no como sustituto de la publicación formal en el [Diario Oficial de Galicia](https://www.xunta.gal/diario-oficial-galicia). La [Xunta lo identifica en su portal de transparencia como base de normativa gallega vigente consolidada](https://transparencia.xunta.gal/es/tema/informacion-de-relevancia-xuridica/normativa-consolidada). Para acreditar publicación, fecha y texto promulgado debe comprobarse la edición oficial del DOG. Una ficha consolidada de [Lex.gal](https://www.lex.gal/es/lex.gal) puede servir como ayuda de localización, pero no prevalece por sí misma sobre la publicación original ni demuestra vigencia completa.

La aceptación real sigue pendiente y está desglosada en [#106](https://github.com/miguel-np/personal-budget/issues/106): ejecutar el backend con una instancia SearXNG configurada y comprobar las respuestas efectivas de BOE, AEAT, DGT, TEAC, Xunta/DOG, Seguridad Social y Lex.gal, registrando endpoint, fecha, formato, estado y limitaciones sin capturar datos financieros. Abrir una URL desde un navegador independiente no valida el contrato de red del backend.

La PR [#111](https://github.com/miguel-np/personal-budget/pull/111) se integró en `main` y añade recuperación histórica BOE por bloques para artículos explícitos, distinguiendo `fecha_publicacion` y `fecha_vigencia`, con parser XML acotado sin DTD/entidades declaradas y abstención ante fechas ausentes, ambigüedad o posible retroactividad. La regresión del artículo 32 de la Ley 39/2015 parte del ejemplo oficial de la [FAQ de la API de legislación consolidada del BOE](https://www.boe.es/datosabiertos/faq/consolidada.php), que documenta el bloque `a32`, las versiones `BOE-A-2015-10565` y `BOE-A-2022-4972`, sus fechas y la estructura del bloque; se contrasta con la [publicación oficial del Real Decreto-ley 6/2022](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2022-4972). La prueba selecciona la versión anterior el 30-03-2022 y la modificada desde el 31-03-2022. La consolidación sigue siendo informativa; no cubre transitorias, derogaciones tácitas ni aplicabilidad al supuesto. La PR [#112](https://github.com/miguel-np/personal-budget/pull/112) amplía la cobertura negativa y de límites XML y permanece pendiente de cierre. La aceptación HTTP live del backend contra SearXNG y los hosts oficiales es un criterio separado de [#106](https://github.com/miguel-np/personal-budget/issues/106).

No hay parser PDF ni OCR; los formatos PDF no HTML/texto se declaran no compatibles ([#109](https://github.com/miguel-np/personal-budget/issues/109)), cerrada explícitamente como fuera de alcance.

## Trazabilidad de afirmaciones

La API construye una relación determinista entre cada frase de la síntesis y los identificadores `[S#]` que aparezcan en esa misma frase. Solo se resuelven IDs presentes en el conjunto de fuentes de la petición; las referencias inventadas se marcan como no resueltas. La interfaz muestra los enlaces y la clase de autoridad junto a la afirmación correspondiente.

Esta relación es trazabilidad sintáctica, no verificación semántica: no demuestra que una fuente sostenga la afirmación ni que una interpretación sea jurídicamente correcta. Las frases citadas se etiquetan como interpretación generada y todas requieren revisión humana. Una frase sin referencia válida se marca como no resuelta. No se inventan localizadores de artículo, bloque o página.

## PDF: fuera del alcance de la entrega base

La recuperación de documentos admitida por #84 se limita a HTML, XHTML y texto plano; el código rechaza PDF y cualquier otro MIME como formato no compatible. No se ejecuta OCR. La issue #109 se cierra explícitamente fuera de alcance para evitar presentar una capacidad inexistente como soportada. La extracción PDF solo se reconsiderará en una ampliación independiente con límites de bytes/páginas/tiempo/memoria, validación MIME y firma, aislamiento de contenido activo, pruebas de ficheros corruptos/cifrados y aceptación específica de OCR, siempre desactivado por defecto.
