# Personal Budget

**Personal Budget** es una aplicación web local para entender, organizar y planificar tus finanzas personales. Utiliza [Actual Budget](https://actualbudget.org/) como fuente de verdad para cuentas, movimientos y presupuestos, y añade informes, planificación, inteligencia financiera y patrimonio.

No necesitas saber programar para utilizarla. Sí necesitas seguir la instalación inicial y mantener una copia de seguridad. La aplicación está pensada para ejecutarse en tu propio equipo, no como un servicio web público.

## Empieza aquí

Si es la primera vez que instalas el proyecto, sigue estos pasos en orden:

1. Lee [qué necesitas antes de instalar](docs/installation.md#antes-de-empezar).
2. Sigue la [instalación paso a paso para Windows + WSL2](docs/installation.md).
3. Consulta la [guía de uso](docs/usage.md) para aprender a utilizar la aplicación.
4. Abre el [catálogo de funcionalidades](docs/features.md) si quieres saber qué hace cada sección.
5. Si algo falla, consulta [resolución de problemas](docs/troubleshooting.md).

**Tiempo de instalación:** depende de si ya tienes WSL2, Docker y Node.js instalados. La primera descarga de dependencias e imágenes puede tardar varios minutos.

## Qué puedes hacer

- Consultar ingresos, gastos, ahorro y evolución de tus finanzas.
- Gestionar y revisar movimientos, cuentas, categorías y presupuestos.
- Importar movimientos CSV y OFX con previsualización y confirmación.
- Comparar periodos y exportar informes a PDF imprimible, Excel, CSV y JSON.
- Planificar pagos recurrentes candidatos, objetivos de ahorro y compromisos futuros.
- Revisar alertas, anomalías, tendencias y propuestas presupuestarias.
- Registrar patrimonio externo y justificantes.
- Consultar un asistente opcional con Ollama local.
- Investigar información pública mediante una búsqueda web separada, desactivada por defecto y con consentimiento por consulta.
- Conectar clientes compatibles mediante MCP local de solo lectura.

Consulta el [catálogo completo](docs/features.md), con el alcance y las limitaciones de cada función.

## Requisitos

El entorno objetivo documentado es Windows + WSL2 (Ubuntu recomendado), Docker/Compose, Git y:

| Herramienta | Versión fijada |
|---|---:|
| Node.js | 26.13.1 |
| npm | 11.20.0 |
| Actual Budget server / API | 26.11.0 como versión objetivo; Compose conserva 26.10.0 como origen del flujo de actualización segura |

Las versiones exactas y sus razones están en la [baseline de versiones](docs/version-baseline.md). No actualices Actual cambiando directamente el tag de Docker: utiliza el procedimiento de [actualización segura](docs/safe-updates.md).

## Uso diario

Después de completar la instalación inicial, desde WSL y la carpeta del repositorio:

```bash
docker compose up -d actual
npm run doctor
npm run start:local
```

Abre **http://127.0.0.1:4173** en el navegador. El comando inicia la API y sirve el frontend compilado. Para detener Personal Budget, pulsa `Ctrl+C` en esa terminal. Actual puede permanecer en ejecución.

La primera instalación y la configuración del presupuesto se explican en [Instalación](docs/installation.md). No vuelvas a ejecutar `npm ci` en cada arranque: solo es necesario al instalar o cambiar dependencias.

## Qué datos salen del equipo

La aplicación está diseñada para uso local:

- Actual Budget mantiene las cuentas, categorías, movimientos y presupuestos.
- La API y la interfaz se enlazan a loopback; no están pensadas para exponerse a Internet o a la red local.
- Ollama es opcional y se configura para inferencia local.
- La búsqueda web es otro permiso: permanece desactivada por defecto y solo envía la consulta que confirmes. SearXNG y los motores upstream pueden recibir esa consulta.
- MCP se ejecuta por stdio y sus herramientas financieras son de consulta o simulación no persistente.

Lee [Privacidad](docs/privacy.md), [Seguridad](SECURITY.md) y [Búsqueda web](docs/web-search.md) antes de activar integraciones externas. No introduzcas credenciales bancarias ni compartas extractos, backups o archivos `.env` para pedir ayuda.

## Documentación por perfil

| Si eres… | Empieza por |
|---|---|
| Usuario nuevo | [Instalación](docs/installation.md) → [Guía de uso](docs/usage.md) |
| Quieres conocer todas las funciones | [Catálogo de funcionalidades](docs/features.md) |
| Necesitas configurar servicios | [Configuración](docs/configuration.md) |
| Quieres solucionar un error | [Resolución de problemas](docs/troubleshooting.md) |
| Desarrollador junior | [Guía de desarrollo](docs/development.md) |
| Colaborador | [CONTRIBUTING](CONTRIBUTING.md) |
| Necesitas detalles técnicos | [Índice de documentación](docs/index.md) |

## Arquitectura, calidad y estado

- **Actual Budget** es la fuente de verdad financiera.
- `services/actual-adapter` encapsula el SDK oficial de Actual.
- `packages/finance-core` contiene contratos y cálculos financieros deterministas.
- `services/api` ofrece la API local Fastify.
- `apps/web` contiene la interfaz React/Vite.
- Los datos propios de Personal Budget se guardan en almacenes locales separados y se incluyen en el backup unificado cuando están inventariados.

Consulta [Arquitectura](docs/architecture.md), [estado de implementación](docs/implementation-status.md) y [roadmap](docs/roadmap.md). El estado de issues y PR se consulta siempre en GitHub; no se deduce de un snapshot documental.

## Comandos útiles

| Comando | Para qué sirve |
|---|---|
| `npm run doctor` | Comprueba requisitos, configuración y servicios locales. |
| `npm run dev` | Inicia API y frontend en modo desarrollo desde una sola terminal. |
| `npm run start:local` | Compila e inicia la aplicación para uso diario. |
| `npm run dev:api` | Inicia la API en modo desarrollo de forma independiente. |
| `npm run dev:web` | Inicia Vite en modo desarrollo de forma independiente. |
| `npm run check` | Ejecuta lint, TypeScript y tests con cobertura. |
| `npm run validate` | Ejecuta la validación local completa, incluidos build, auditorías y E2E. |
| `npm run setup:e2e` | Instala Chromium para las pruebas de navegador (una vez por entorno). |
| `npm run backup:actual` | Crea un backup cifrado unificado; requiere detener Personal Budget. |
| `npm run update:actual` | Ejecuta el procedimiento de actualización segura de Actual. |

Para el modo de desarrollo, Actual se inicia por separado solo cuando necesites probar la integración financiera:

```bash
docker compose up -d actual
npm run dev
```

La validación E2E requiere haber ejecutado previamente `npm run setup:e2e`. Los comandos de backup, restauración y actualización tienen efectos sobre datos persistentes: consulta sus guías antes de ejecutarlos.
## Licencia

El código y la documentación originales están bajo MIT. Los datos financieros del usuario no forman parte de esta licencia; las dependencias, componentes, modelos y servicios de terceros conservan sus propias licencias.
