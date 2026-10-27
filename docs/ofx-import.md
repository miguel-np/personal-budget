# Importación local de OFX

La importación OFX de **personal-budget** es una función local de lectura y conciliación. No inicia sesiones bancarias, no solicita credenciales ni envía el fichero original a la API. El navegador lee el archivo y únicamente envía registros normalizados a la API local cuando se solicita una previsualización o una confirmación.

## Perfiles admitidos

| Perfil | Tratamiento |
|---|---|
| OFX SGML 1.02 (OFXHEADER:100, DATA:OFXSGML, VERSION:102) | Admitido |
| OFX SGML 1.03 (OFXHEADER:100, DATA:OFXSGML, VERSION:103) | Admitido |
| OFX XML 2.x con raíz OFX y declaración XML opcional | Admitido si es UTF-8/ASCII válido y no contiene construcciones XML peligrosas o no admitidas |
| SGML con otras versiones/cabeceras | Rechazado |
| QFX, QIF y CAMT | No admitidos por este flujo |
| UTF-16/UTF-32, codificaciones desconocidas, DTD, entidades personalizadas y CDATA | Rechazados; no se intenta una conversión implícita |

Para SGML se respetan CHARSET:1252/WINDOWS-1252 cuando se declara expresamente, o UTF-8/ASCII. El contenido financiero no se repara silenciosamente cuando la codificación es incompatible.

## Límites y reglas de normalización

- Máximo de 350.000 bytes por fichero y 2.000 operaciones STMTTRN.
- Las fechas parten de DTPOSTED y se convierten a fecha civil YYYY-MM-DD; no se aplican desplazamientos de zona horaria.
- TRNAMT debe usar signo y punto decimal, con cero, uno o dos decimales, y convertirse de forma segura a unidades monetarias menores. Se rechazan importes cero, formato ambiguo, precisión adicional y valores fuera de rango.
- FITID es obligatorio para importar. El identificador estable personal-budget-ofx: se deriva de un hash de la identidad disponible de la cuenta de origen y FITID; el valor bancario sin procesar no se copia al identificador.
- NAME/MEMO se conservan en los campos de concepto disponibles. Los metadatos de cheque y referencia se anotan sin crear categorías nuevas.
- Registros con fecha, importe, FITID, concepto o campos obligatorios inválidos se aíslan y se muestran como rechazados. Si un mismo FITID aparece varias veces con datos idénticos, se omiten las copias internas; si se repite con datos distintos, se rechaza el archivo completo para evitar una conciliación arbitraria.
- Se muestra cualquier divisa CURDEF declarada. Una diferencia con la divisa nativa conocida de la cuenta destino bloquea la importación; nunca se aplica una conversión automática. Si no se puede verificar la divisa, la interfaz exige una confirmación explícita.
- Se requiere elegir explícitamente la cuenta destino. Los campos bancarios BANKID/BRANCHID/ACCTID no se consideran suficientes para identificar una cuenta de Actual de forma fiable, porque Actual no expone una correspondencia bancaria universal.
- Categorías y saldos del extracto no se importan. Se informa de los datos omitidos y de los movimientos rechazados antes de escribir.

## Previsualización, conciliación y cancelación

1. El navegador analiza el fichero y muestra el perfil, operaciones válidas, rechazadas, duplicados internos, avisos y campos omitidos.
2. La API local ejecuta la previsualización con la opción dryRun: true de @actual-app/api. La interfaz muestra el número de nuevas operaciones y posibles coincidencias/actualizaciones detectadas por Actual.
3. La confirmación solo envía los registros validados. El adaptador oficial usa importTransactions con reimportDeleted: false; Actual continúa siendo la fuente de verdad y la encargada de conciliar por identificador importado y sus reglas de coincidencia.
4. Cancelar limpia la confirmación pendiente y no hace ninguna escritura. Una segunda importación del mismo extracto genera los mismos imported_id, de modo que Actual puede reconocer los movimientos ya importados. Esta garantía depende de que la exportación preserve la identidad y los FITID; no implica deduplicación infalible entre exportaciones bancarias distintas.

La previsualización no garantiza que Actual vaya a aceptar una escritura posterior: comprueba la respuesta de confirmación y muestra los resultados reales de added y updated. Si Actual devuelve errores, la aplicación presenta un conflicto saneado y no expone los errores internos del adaptador.

## Privacidad y pruebas

El parser procesa bytes en memoria en el navegador. No se conserva el fichero en el servidor ni se registran los conceptos, los FITID, las rutas locales o el contenido del extracto. Las pruebas automatizadas emplean solo fixtures sintéticos. No añadas ficheros bancarios reales a tests, issues, commits ni logs.

La implementación usa el flujo oficial soportado por Actual Budget: [referencia de la API](https://actualbudget.org/docs/api/reference/) y [guía de importación de movimientos](https://actualbudget.org/docs/transactions/importing/). La compatibilidad descrita aquí es deliberadamente más limitada que el conjunto total de formatos que pueda admitir Actual.
