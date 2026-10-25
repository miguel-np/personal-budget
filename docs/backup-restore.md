# Copias de seguridad y restauración

Los presupuestos y las exportaciones bancarias son datos sensibles. La estrategia de copias debe estar activa antes de utilizar el sistema con datos reales.

## Qué respaldar

- Exportación del presupuesto de Actual Budget realizada mediante sus funciones oficiales.
- Directorio persistente del servidor Actual, detenido o respaldado mediante un procedimiento compatible con la versión utilizada.
- Configuración no secreta necesaria para reconstruir la aplicación.
- Configuración local de la aplicación, si se desea conservar.

No es necesario respaldar los modelos descargados para recuperar los datos financieros; pueden descargarse otra vez. La configuración `.env` debe protegerse aparte y nunca subirse al repositorio.

## Política inicial sugerida

- Copia automática diaria cuando el sistema se utilice regularmente.
- Copia manual antes de actualización, importación masiva o migración.
- Al menos una copia cifrada en un dispositivo distinto.
- Retención rotativa (por ejemplo, copias diarias recientes y copias semanales/mensuales), ajustada a la capacidad y necesidad personal.
- Verificación periódica de integridad y prueba de restauración.

La copia fuera del equipo mejora la recuperación, pero deja de ser estrictamente local. Si se utiliza, debe ir cifrada antes de transferirse y no depender de un proveedor sin revisar sus condiciones.

## Restaurar

1. Detén la aplicación y el servicio que modifique el presupuesto.
2. Conserva intacta la copia actual por si el proceso falla.
3. Sigue el procedimiento de exportación/importación oficial de Actual para la versión instalada.
4. Si se restaura el directorio de datos del servidor, evita mezclar archivos de diferentes copias/versiones.
5. Abre el presupuesto, comprueba cuentas, categorías y saldos contra el inventario esperado.
6. Prueba un conjunto de movimientos y los informes principales antes de volver al uso normal.

## No hacer

- No copies SQLite o ficheros internos activos sin una estrategia de backup compatible.
- No asumas que una carpeta sincronizada equivale a una copia consistente.
- No subas copias a GitHub, cloud drive sin cifrado o tickets de soporte.
- No consideres comprobada la restauración hasta ejecutar una prueba real con datos no productivos.

Consulta la [documentación de instalación y gestión de datos de Actual](https://actualbudget.org/docs/).
