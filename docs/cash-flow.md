# Saldo estimado y flujo de caja (#73)

## Propósito y límites

La vista de flujo de caja responde a «¿qué saldo podría quedar y cuándo podría caer?». No informa de un saldo bancario disponible garantizado. El adaptador de Actual expone actualmente `balance_current`, pero no un contrato separado para efectivo disponible, saldo contable, saldo liquidado o saldo pendiente de cuenta. La interfaz denomina el dato **saldo actual comunicado por Actual** y calcula una estimación a partir de él.

El saldo inicial consolidado solo se calcula cuando todas las cuentas del ámbito tienen saldo conocido y una divisa/tasa válida a la fecha de corte. Si falta cualquier dato, el saldo y todos los saldos proyectados permanecen `null`; las variaciones netas y eventos siguen visibles. Nunca se sustituye un saldo desconocido por cero.

## Horizonte, ámbito y divisa

- La consulta se ejecuta bajo demanda con horizontes de 7, 30 o 90 días, desde la fecha civil actual (incluida).
- Usa la selección global de cuentas vigente. El saldo inicial es la suma de los saldos actuales de esas cuentas después de conversión local a la divisa de análisis.
- La proyección es del ámbito elegido, no del patrimonio total. Las transferencias entre cuentas incluidas se compensan con sus dos patas; una transferencia hacia/desde una cuenta excluida representa una salida/entrada del ámbito.
- No se combinan importes de divisas distintas sin una tasa local, explícita y fechada. Las cuentas sin divisa, saldo o conversión válida se enumeran como no disponibles.
- El colchón mínimo es una reserva para el ámbito global seleccionado. Se compara con el saldo consolidado diario; no distribuye una reserva por cuenta.

## Fuentes de eventos

Cada evento conserva una procedencia diferenciada:

| Fuente | Uso en la proyección |
|---|---|
| Movimiento futuro registrado en Actual | Se incluye por su fecha e importe firmado. Si Actual proporciona `cleared`, la UI distingue confirmado, pendiente o desconocido. |
| Compromiso manual puntual activo | Se expande según fecha; requiere coincidencia de ámbito y conversión a la divisa de análisis. |
| Recurrencia confirmada | Compromiso activo mensual, trimestral o anual guardado por el usuario; se proyecta en una fuente propia. |
| Candidato recurrente estimado | Se detecta sobre hasta 800 días de historial local. Se ofrece como hipótesis separada y solo se proyecta si el usuario la selecciona expresamente. |
| Escenario hipotético | Se suma únicamente a esa petición; no crea movimientos ni compromisos persistentes. |

Los movimientos divididos se normalizan por sus líneas para no sumar el padre dos veces. Los importes se mantienen en unidades menores enteras.

## Detección conservadora de duplicados

Un compromiso manual se omite del cálculo cuando coincide exactamente con un movimiento futuro de Actual en fecha, importe, dirección y etiqueta normalizada de beneficiario/título. El movimiento real permanece como fuente contada.

Si fecha, importe y dirección coinciden pero el título no permite confirmar correspondencia, ambos eventos se conservan y se presenta una advertencia. No se elimina ni se oculta el compromiso por una heurística ambigua; el usuario debe revisarlo.

## Interpretación del resultado

- **Saldo proyectado**: saldo inicial conocido más entradas y salidas conocidas acumuladas por fecha.
- **Mínimo proyectado**: menor saldo diario dentro del horizonte.
- **Déficit potencial**: primera fecha en que el saldo estimado sería negativo.
- **Incumplimiento de reserva**: primera fecha por debajo del colchón configurado.
- **Variación neta**: entradas menos salidas conocidas, incluso cuando el saldo inicial sea desconocido.

Los resultados son escenarios estimados. No anticipan movimientos no registrados, descubiertos, intereses, liquidaciones ni cambios futuros de tipo de cambio.

## API

`POST /api/v1/cash-flow/project`

Cuerpo estricto: `horizonDays` (7/30/90), `reserveMinor` opcional, `scenario` opcional con fecha/importe/dirección/descripción y `recurringCandidateIds` opcional. Los candidatos se detectan con historial local de hasta 800 días y cadencia estimada de 20–400 días; solo los seleccionados se incluyen en la proyección y se etiquetan como hipótesis. La respuesta incluye corte, horizonte, divisa, ámbito, saldos desconocidos, eventos reales, compromisos puntuales, recurrencias confirmadas, candidatos y eventos recurrentes estimados.

## Privacidad y validación

El cálculo es local y determinista. No usa Ollama y no escribe en Actual. Las pruebas sintéticas cubren balances desconocidos, entradas/salidas, reserva, déficit, límites de horizonte y la separación entre recurrencias confirmadas/candidatas. Las pruebas API cubren duplicados exactos, conversiones/omisiones por divisa incompatible, selección explícita de candidatos y escenarios no persistentes.
