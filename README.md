# personal-budget

**Gestión local de finanzas personales con una interfaz web y un asistente de IA ejecutado en local.**

> **Estado del proyecto: especificación inicial.** Este paquete contiene la documentación y las decisiones de diseño de `personal-budget`; no contiene todavía la implementación completa de la web, el adaptador de Actual Budget ni el servidor MCP. Las funciones descritas como objetivo no deben interpretarse como ya implementadas o validadas.

## Objetivo

`personal-budget` está pensado para registrar y analizar gastos diarios, mensuales y anuales, visualizar categorías y ahorro, importar movimientos bancarios descargados manualmente y consultar las finanzas mediante un chat. La prioridad es mantener el control de los datos: ejecución local, sin suscripción obligatoria y sin enviar movimientos financieros a una API de IA alojada por terceros.

## Funciones previstas

- Panel con ingresos, gastos, ahorro, tasa de ahorro y evolución histórica.
- Registro y edición de movimientos, con cuenta, fecha, importe, categoría y descripción.
- Informes por día, mes, año, categoría y cuenta.
- Importación de ficheros bancarios compatibles a través de Actual Budget.
- Presupuestos y seguimiento frente a gasto real.
- Asistente conversacional conectado a funciones financieras explícitas.
- Modelo de IA local mediante Ollama.
- Herramientas MCP locales, limitadas y revisadas.
- Copias de seguridad y restauración documentadas.

## Principios

1. **Local-first:** la aplicación y el modelo se ejecutan en el equipo del usuario.
2. **Una sola interfaz:** dashboard, movimientos, informes y chat se presentan en la misma aplicación web local.
3. **Actual Budget como motor financiero:** la aplicación propia consume la API oficial de Node.js de Actual; no presupone una API REST de Actual.
4. **Cálculos deterministas:** los importes y agregaciones se calculan mediante código, no se dejan a la estimación libre del modelo.
5. **Solo lectura por defecto para la IA:** las operaciones que escriban o modifiquen datos requieren confirmación explícita.
6. **Importación manual:** no se solicita la contraseña del banco ni se configura sincronización bancaria automática por defecto.
7. **Transparencia:** los límites, errores de datos y supuestos de una previsión deben hacerse visibles.

## Arquitectura prevista

```text
Navegador de Windows
  └── Aplicación web local (React + TypeScript)
       └── Backend local (Node.js + TypeScript)
            ├── Adaptador oficial @actual-app/api ── Actual Budget
            ├── Cliente local de Ollama ─────────── Ollama / modelo local
            └── Enrutador de herramientas ───────── MCP opcional por stdio
```

Consulta [Arquitectura](docs/architecture.md), [instalación en Windows + WSL2](docs/installation.md) y [estado de implementación](docs/implementation-status.md).

## Documentación

Empieza en el [índice de documentación](docs/index.md). Incluye instalación, uso, importaciones, configuración, IA local, MCP, privacidad, seguridad, copias de seguridad, desarrollo, licencia y resolución de problemas.

## Estado de funciones

Este repositorio documental describe la arquitectura objetivo, no una aplicación lista para ejecutarse. La instalación de Actual Budget y Ollama puede realizarse por separado siguiendo la guía, pero la web `personal-budget` solo podrá arrancar cuando se añada su código y los scripts correspondientes. Consulta [Implementation status](docs/implementation-status.md) antes de seguir las instrucciones de desarrollo.

## Requisitos de destino

- Windows con WSL2 y una distribución Linux, preferiblemente Ubuntu.
- Docker Desktop con integración WSL2 o Docker Engine y Docker Compose dentro de WSL.
- Node.js LTS y un gestor de paquetes compatible con el lockfile del futuro proyecto.
- Actual Budget local.
- Ollama y un modelo compatible con las funciones de conversación y, si se necesita, llamadas a herramientas.

No se exige GPU para todos los modelos; el rendimiento dependerá del modelo seleccionado y del hardware.

## Inicio rápido: componentes base

Consulta [Instalación](docs/installation.md). Como mínimo, puedes preparar Actual Budget y Ollama de forma independiente. Las instrucciones para iniciar la aplicación web propia se publicarán cuando exista la implementación correspondiente.

## Privacidad y limitaciones

La ejecución local reduce la necesidad de confiar datos financieros a proveedores externos, pero no garantiza por sí sola ausencia total de tráfico de red. La instalación inicial, descargas de modelos, actualizaciones, el propio sistema operativo y las dependencias pueden comunicarse con servicios externos. La documentación de [Privacidad](docs/privacy.md) y [Seguridad](SECURITY.md) describe las medidas y límites.

El proyecto no es un banco, asesor financiero, contable ni fiscal. Los resultados sirven para organizar información personal y no sustituyen asesoramiento profesional.

## Licencia

El código y la documentación originales se distribuyen bajo la licencia MIT incluida en [LICENSE](LICENSE). Esta elección permite reutilización amplia, incluido uso comercial y derivados bajo otros términos, a condición de conservar los avisos aplicables. No se aplica a los datos financieros del usuario ni reemplaza las licencias de Actual Budget, Ollama, los modelos o las dependencias. Consulta [Licencia y derechos sobre datos](docs/licensing.md) para conocer el alcance y las alternativas consideradas.
