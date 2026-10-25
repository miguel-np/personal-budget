# Desarrollo

## Estado actual

El paquete contiene documentación y una especificación de arquitectura. No existe todavía un código completo que permita ejecutar las pruebas descritas aquí. Esta guía define la práctica esperada cuando se implemente el repositorio.

## Entorno objetivo

- Windows + WSL2 (Ubuntu recomendado).
- Git, Node.js LTS y el gestor de paquetes seleccionado por el proyecto.
- Docker/Compose para ejecutar Actual Budget localmente si se elige esa vía.
- Ollama para las pruebas opcionales de IA.

Mantén código y dependencias dentro del filesystem Linux de WSL. No guardes datos personales en el árbol versionado.

## Organización de carpetas propuesta

```text
personal-budget/
├── apps/
│   └── web/                 # React + TypeScript
├── services/
│   ├── api/                 # Backend local
│   ├── actual-adapter/      # @actual-app/api
│   └── mcp/                 # Herramientas locales (opcional)
├── packages/
│   └── finance-core/        # Cálculos deterministas y tipos
├── docs/
├── .env.example
├── .gitignore
├── CHANGELOG.md
├── LICENSE
└── README.md
```

La estructura es una propuesta, no una descripción de directorios que ya existan.

## Pruebas de aceptación mínimas

- Sumas monetarias exactas y reglas de redondeo.
- Periodos con inicio/fin de mes, año bisiesto y zona horaria.
- Traspasos internos excluidos de gasto consolidado.
- Reembolsos, importes negativos y entradas duplicadas.
- Diferentes divisas sin sumarlas silenciosamente.
- CSV con distintos separadores, codificaciones y formato de fecha.
- Fallos de Actual/Ollama y recuperación sin perder movimientos.
- Tool calling inválido, prompt injection en conceptos y límites MCP.
- Verificación de que el backend no escucha en interfaces externas por defecto.
- Logs saneados y ausencia de secretos en el bundle del frontend.
- Copia de seguridad y restauración comprobadas.

## Scripts previstos

Los nombres definitivos dependen del package manager y de los archivos de implementación. El repositorio deberá ofrecer comandos equivalentes a instalar dependencias con lockfile, lint, typecheck, tests, build de producción y arranque local. No documentar comandos como activos hasta que estén definidos en `package.json` y hayan sido probados.
