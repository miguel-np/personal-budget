# Glosario para principiantes

Términos que aparecen en la aplicación y en sus guías. No necesitas conocerlos todos para utilizar Personal Budget.

| Término | Significado sencillo |
|---|---|
| Actual Budget | Aplicación financiera que almacena las cuentas, categorías, movimientos y presupuestos. Es la fuente de verdad del proyecto. |
| API | Interfaz que permite que la web solicite datos y operaciones al backend. |
| Backend | Parte de la aplicación que procesa solicitudes, valida datos y consulta Actual. |
| Frontend | Interfaz visual que utilizas en el navegador. |
| Local-first | Diseño en el que la aplicación y sus datos se gestionan principalmente en tu propio equipo. No significa protección automática frente a malware o errores de configuración. |
| WSL2 | Entorno Linux que puedes ejecutar dentro de Windows. El proyecto recomienda Ubuntu sobre WSL2. |
| Docker | Herramienta que ejecuta servicios aislados en contenedores. Personal Budget la utiliza para Actual Budget. |
| Docker Compose | Comando que configura e inicia los servicios definidos en `compose.yaml`. |
| Node.js | Entorno que ejecuta el backend y las herramientas de desarrollo. |
| npm | Herramienta que instala las dependencias del proyecto y ejecuta sus scripts. |
| nvm | Gestor que permite instalar y seleccionar versiones de Node.js. |
| Workspace | Parte independiente del monorepo con sus propias responsabilidades y configuración. |
| Monorepo | Repositorio que contiene varios paquetes o aplicaciones relacionados. |
| Sync ID / Budget ID | Identificador del presupuesto de Actual que debe configurarse para que el adaptador sepa qué presupuesto utilizar. No es una contraseña. |
| Cuenta | Lugar financiero registrado en Actual, por ejemplo una cuenta corriente o de ahorro. |
| Movimiento | Operación de ingreso, gasto, transferencia u otro ajuste registrado en una cuenta. |
| Movimiento dividido | Operación cuyo importe se reparte entre varias categorías o líneas. |
| Transferencia interna | Dinero movido entre cuentas propias. No debe contarse como ingreso o gasto consolidado. |
| Categoría | Etiqueta que permite clasificar un movimiento, por ejemplo alimentación o transporte. |
| Sin clasificar | Movimiento que todavía no tiene una categoría asignada. |
| Presupuesto / asignación | Cantidad planificada para una categoría durante un periodo. |
| Ámbito de cuentas | Conjunto de cuentas que participan en un análisis. Puede incluir todas las abiertas o una selección. |
| Divisa nativa | Moneda original de una cuenta o movimiento. |
| Divisa de análisis | Moneda elegida para presentar los resultados. |
| Tipo de cambio | Relación utilizada para convertir una moneda a otra. En esta aplicación se declara localmente. |
| Ahorro neto | Diferencia entre ingresos y gastos contabilizados en el periodo, con las reglas de consolidación de la aplicación. |
| Pago recurrente candidato | Patrón de movimientos que parece repetirse. No confirma que exista una suscripción o un próximo cargo. |
| Previsión | Cálculo orientativo de un resultado futuro a partir de supuestos. |
| Hallazgo | Señal detectada por una regla y acompañada de evidencia y limitaciones. |
| Patrimonio | Valor neto de activos menos pasivos, cuando los datos y valoraciones permiten calcularlo. |
| Justificante | Documento privado asociado a un movimiento o elemento patrimonial. |
| Ollama | Runtime que permite ejecutar modelos de IA localmente. Es opcional. |
| Modelo local | Modelo de IA descargado y ejecutado en el equipo mediante Ollama. |
| SearXNG | Motor de metabúsqueda que puede recibir las consultas que autorices para investigación web. |
| MCP | Protocolo para que un cliente compatible invoque herramientas con contratos definidos. En este proyecto, las herramientas financieras son de solo lectura o simulación. |
| Loopback / localhost | Dirección de red que apunta al propio equipo, normalmente `127.0.0.1`. |
| Backup | Copia de seguridad que permite recuperar datos. No equivale a exportar un informe. |
| Restauración | Proceso de recuperar datos desde un backup. Puede sustituir el estado actual y exige precaución. |
| CI | Comprobaciones automáticas que se ejecutan en GitHub Actions al cambiar el repositorio. |
| E2E | Pruebas que recorren la aplicación como lo haría una persona usuaria, normalmente con navegador automatizado. |
| LTS | Versión con soporte de mantenimiento a largo plazo. |
| PR / Pull Request | Propuesta de cambios que se revisa antes de integrarse en la rama principal. |
| Issue | Tarea, error o propuesta registrada en GitHub. |

## Diferencias importantes

- **Exportar no es hacer backup:** un Excel o PDF sirve para consultar información; el backup conserva los datos necesarios para restaurar el sistema.
- **Candidato no significa confirmado:** un patrón repetido no demuestra que un pago vaya a repetirse.
- **Previsión no significa saldo bancario:** el flujo de caja es una estimación, no una garantía de dinero disponible.
- **IA local no significa IA obligatoria:** la gestión y los cálculos financieros básicos funcionan sin Ollama.
- **Local-first no significa acceso remoto:** no publiques los puertos locales en Internet o en tu red doméstica.
