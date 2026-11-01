# Alertas presupuestarias locales (#74)

## Alcance

Las alertas son reglas deterministas calculadas cuando se consulta el periodo de Presupuestos. Se muestran dentro de la aplicación; no hay push, correo, notificaciones del sistema operativo, daemon ni ejecución residente. Una regla nunca modifica asignaciones de Actual Budget.

## Métricas

Cada regla se asocia a una categoría de gasto, periodo mensual y métrica:

| Métrica | Umbral | Activación |
|---|---|---|
| Porcentaje consumido | 1–500 % | Gasto / asignación explícita × 100 alcanza o supera el umbral. |
| Exceso relativo sobre presupuesto | 1–500 % | (Gasto − asignación) / asignación × 100 alcanza o supera el umbral; solo cuando la asignación es positiva. |
| Importe restante | Importe en unidades menores, >= 0 | Asignación menos gasto es igual o inferior al umbral. |
| Exceso sobre presupuesto | Importe en unidades menores, > 0 | Gasto supera la asignación al menos en el umbral. |

Las reglas usan la respuesta presupuestaria de Actual del mes seleccionado y la divisa nativa del presupuesto. Los importes monetarios se introducen en esa divisa. La API devuelve `evaluatedAt` para mostrar cuándo se calculó la respuesta; no es un proceso en segundo plano.

## Datos ausentes y casos límite

La API distingue asignación positiva, asignación explícita cero, categoría sin asignación y dato desconocido cuando la versión del adaptador proporciona filas de asignación explícitas. Las reglas de porcentaje no dividen por cero. Una asignación cero puede producir una alerta de exceso absoluto si hay gasto y la regla de exceso tiene un umbral positivo. La desviación relativa no se calcula con presupuesto cero, para evitar dividir por cero. Categorías sin asignación explícita, desconocidas u ocultas se omiten; no se inventa presupuesto cero.

## Deduplicación y decisiones

La identidad del evento se deriva de regla + categoría + mes. Reconsultar Presupuestos no crea avisos duplicados para el mismo cruce. El usuario puede silenciar el aviso para ese periodo o posponerlo (7 días en la UI; la API limita el aplazamiento a 90 días). El aviso vuelve a mostrarse al expirar el aplazamiento, salvo que se silencie. Un periodo nuevo tiene una identidad nueva.

Las reglas se pueden crear, editar, activar/desactivar y eliminar. Al editar una regla se genera una nueva identidad; las decisiones de la regla anterior no se heredan a un umbral distinto. Eliminar o reemplazar reglas retira las decisiones de eventos vinculadas a reglas que dejan de existir. Las reglas desactivadas no disparan alertas.

## API y almacenamiento

- `GET /api/v1/budget-alerts?month=YYYY-MM`: evalúa y devuelve reglas, categorías, advertencias y avisos activos.
- `PUT /api/v1/budget-alerts/rules`: reemplaza el conjunto de reglas.
- `PATCH /api/v1/budget-alerts/events/:eventId`: silencia o pospone un evento con comprobación de identidad.

Reglas, eventos revisados, clasificaciones de categorías y escenarios de mejora se guardan localmente en `financial-actions.json`, con versión, validación, límites, escritura atómica y permisos restrictivos. El almacén está incluido en la whitelist del backup cifrado unificado. No almacena movimientos financieros.
