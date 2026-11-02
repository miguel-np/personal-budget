# Corpus jurídico-fiscal de regresión

## Finalidad y límites

El corpus de `services/api/tests/fixtures/legal-tax-corpus.ts` proporciona regresiones deterministas sobre procedencia documental, jurisdicción, fechas, jerarquía de fuentes, conflictos de versiones y abstención. No calcula cuotas, no determina obligaciones de personas concretas y no constituye un dictamen jurídico o fiscal.

Cada caso contiene un identificador estable, una pregunta neutral, un contexto no personal, jurisdicción, tipo de contribuyente, ejercicio, año de presentación, fechas separadas, documentos, citas obligatorias, resultado esperado y hechos que no deben inferirse. Cada documento citado debe disponer de un snapshot de evidencia con URL, versión o corte temporal, fecha de captura, localizador y fragmento breve o hechos constatados.

**Estado de revisión humana:** todos los casos se mantienen como `reviewStatus: 'pending'`. La CI comprueba consistencia técnica y trazabilidad, no la corrección jurídica de la interpretación. #108 permanece abierta hasta que una persona competente revise y apruebe expresamente los resultados esperados.

## Cobertura actual

| Caso | Ámbito | Materia | Riesgo/regresión principal |
|---|---|---|---|
| `ES-IRPF-2023-FILING-2024` | Estado | IRPF | Separar ejercicio 2023 y campaña 2024; periodo impositivo anual |
| `ES-IRPF-2024-FILING-2025` | Estado | IRPF | Ley frente a guía administrativa AEAT y campaña de presentación |
| `ES-FRAUD-LAW-11-2021-EFFECTIVE-DATES` | Estado | Medidas tributarias | Entrada en vigor general y efectos temporales diferentes de la Ley 11/2021 |
| `ES-IVA-1992-ORIGINAL-VS-CURRENT` | Estado | IVA | Publicación original frente a consolidación informativa fechada |
| `ES-IVA-2024-DECREE-9-2024-REPEAL` | Estado | IVA, regímenes especiales | Modificación del RDL 9/2024 con efectos 01/01/2025 y resolución de derogación publicada 23/01/2025; abstenerse sobre el efecto individual |
| `ES-BOE-ARTICLE-32-2022-03-30` | Estado | Procedimiento administrativo | Redacción anterior a la entrada en vigor del RDL 6/2022 |
| `ES-BOE-ARTICLE-32-2022-03-31` | Estado | Procedimiento administrativo | Redacción desde la entrada en vigor del RDL 6/2022 |
| `ES-GALICIA-LAW-5-2024-IRPF-2025` | Galicia | IRPF autonómico | Requisitos acumulativos de una deducción; no inferir elegibilidad |
| `ES-GALICIA-LAW-5-2024-DOG-BOE-DATE-DISCREPANCY` | Galicia | Publicación normativa | Diferenciar publicación DOG, reproducción BOE y entrada en vigor |
| `ES-GALICIA-LAW-6-2023-SCOPE-ABSTENTION` | Galicia | Alcance de la fuente | No extrapolar una norma de patrimonio público a una herencia privada |
| `ES-IRPF-CONSOLIDATED-VS-OFFICIAL-PUBLICATION` | Estado | IRPF | Valor informativo de la consolidación frente a la publicación oficial |
| `ES-TAX-INSUFFICIENT-JURISDICTION-AND-FACTS` | Indeterminada | Consulta fiscal | Abstención si faltan jurisdicción, impuesto o fecha del hecho |
| `ES-MADRID-IBI-2026-MUNICIPAL-ORDINANCE` | Madrid | IBI | Ordenanza municipal 2026 y devengo; abstención sin datos catastrales |

Cobertura geográfica actual: ámbito estatal, comunidad autónoma de Galicia y municipio de Madrid. Los organismos DGT, TEAC/TEAR y Seguridad Social son fuentes candidatas de ampliación, no deben considerarse cubiertos por los 13 casos actuales.

## Jerarquía y clasificación de fuentes

- `official_publication`: publicación oficial de la norma en el diario oficial correspondiente. Es la evidencia jurídica primaria del texto publicado.
- `official_municipal_ordinance`: publicación/versión oficial de una ordenanza local, vinculada a su municipio y ejercicio.
- `informative_consolidation`: texto consolidado BOE. Facilita la lectura, pero el BOE advierte que no tiene valor jurídico; se fija el corte temporal y se contrasta con las publicaciones oficiales.
- `administrative_guide`: guía/ayuda de AEAT. Es información administrativa, no una norma con rango legal.
- Las resoluciones y acuerdos se clasifican por su naturaleza y órgano emisor; no se elevan a categoría de ley por estar alojados en el BOE.

## Fuentes oficiales fijadas en esta versión

- [Ley 11/2021 (BOE-A-2021-11473)](https://www.boe.es/eli/es/l/2021/07/09/11): disposición final séptima, letras a)-c); publicación 10/07/2021, entrada general en vigor 11/07/2021 y efectos particulares.
- [RDL 9/2024 (BOE-A-2024-26915)](https://www.boe.es/eli/es/rdl/2024/12/23/9): artículo 8.Tres y modificación de la disposición transitoria 13 de la Ley 37/1992, con efectos indicados desde 01/01/2025.
- [Resolución de derogación (BOE-A-2025-1136)](https://www.boe.es/eli/es/res/2025/01/22/(1)): acuerdo de 22/01/2025, publicación 23/01/2025; el análisis del BOE identifica la modificación de la DT 13 LIVA entre las modificaciones con efectos desde 01/01/2025 que quedan sin efecto.
- [Ley 5/2024 de Galicia (BOE-A-2025-2145)](https://www.boe.es/eli/es-ga/l/2024/12/27/5): artículo 2 y disposición final tercera; se contrasta la publicación en DOG y BOE y la entrada en vigor 01/01/2025.
- [Registro oficial DOG-g-2024-90260](https://www.boe.es/buscar/doc.php?id=DOG-g-2024-90260): publicación DOG núm. 251, 31/12/2024.
- [TRLRHL (BOE-A-2004-4214)](https://www.boe.es/eli/es/rdlg/2004/03/05/2): artículo 75, devengo y periodo impositivo del IBI.
- [Ordenanza IBI de Madrid, ANM 2025\\141](https://sede.madrid.es/eli/es-md-01860896/odnz/1989/12/22/(1)/con/20251226/spa/html): la sede municipal identifica la última actualización publicada 26/12/2025 y la redacción como vigente para 2026.
- [AEAT, Modelo 100 IRPF 2024](https://sede.agenciatributaria.gob.es/Sede/Ayuda/24Presentacion/100.html): guía administrativa de la campaña del ejercicio 2024.

Los detalles y fragmentos de cada caso se mantienen junto al dato de prueba, en lugar de copiar el texto íntegro de la norma. Se registra `capturedAt` para permitir la actualización revisada de evidencia.

## Ejecución y actualización

La regresión se ejecuta sin red externa durante CI:

```bash
npx vitest run services/api/tests/legal-tax-corpus.test.ts
```

Al actualizar una fuente o caso:

1. Consultar la publicación oficial y, cuando proceda, su análisis de modificaciones/derogaciones. No actualizar desde una búsqueda o snippet sin abrir el documento primario.
2. Fijar el documento y la versión/corte temporal. Separar publicación, entrada en vigor, fecha del hecho, fecha de referencia, ejercicio y año de presentación.
3. Cambiar `evidenceSnapshots`, `citationIds` y `expected` en el mismo cambio. No dejar citas que no correspondan a un documento y snapshot del caso.
4. Explicar si un documento es norma publicada, consolidación informativa, guía administrativa, resolución o criterio. Mantener la abstención si la fuente no resuelve el caso individual.
5. Ejecutar la prueba local y abrir una PR con el motivo de actualización y las diferencias de evidencia.
6. Para aprobar jurídicamente un caso, una persona competente debe verificar el texto, la interpretación, el ámbito y las fechas y dejar constancia revisable. Solo entonces se podrá cambiar `reviewStatus` a `approved` y ampliar el test para exigir esa aprobación.

La CI no descarga documentos ni depende de que los portales estén disponibles. La verificación de disponibilidad HTTP/MIME de organismos externos corresponde a la aceptación live de [#106](https://github.com/miguel-np/personal-budget/issues/106); el corpus y su revisión corresponden a [#108](https://github.com/miguel-np/personal-budget/issues/108).
