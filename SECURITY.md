# Política de seguridad

## Alcance y límites de la evidencia

Esta política define requisitos de diseño y operación. **No certifica que una versión esté libre de vulnerabilidades.** El carácter local-first reduce ciertas exposiciones, pero no protege frente a malware local, acceso al sistema operativo, dependencias comprometidas, pérdida de backups o errores de configuración.

## Evidencia automatizada de referencia

**Ejecución auditada:** 15-nov-2026, commit [`98bdbb270101116f1fb5fe032101e78558c63035`](https://github.com/miguel-np/personal-budget/commit/98bdbb270101116f1fb5fe032101e78558c63035), antes de esta intervención documental.

- [CI, run 43718412265](https://github.com/miguel-np/personal-budget/actions/runs/43718412265): `quality`, `browser-e2e`, `actual-container-smoke`, `windows-quality` y `actual-update-acceptance` completados correctamente.
- [Security, run 43718412220](https://github.com/miguel-np/personal-budget/actions/runs/43718412220): `dependency-and-secret-scan` completado correctamente.
- `npm audit --audit-level=moderate`: 0 vulnerabilidades conocidas reportadas por la base de avisos consultada en esa ejecución.
- `npm audit --omit=dev --audit-level=moderate`: 0 vulnerabilidades conocidas reportadas para dependencias de producción en esa ejecución.
- Gitleaks: el escaneo de los cambios incluidos en el commit de referencia no encontró secretos. El workflow analiza el rango entrante; no equivale a auditar de nuevo todo el historial Git.
- Cobertura Vitest V8 reportada en el job `quality`:

| Métrica | Resultado observado | Umbral configurado |
|---|---:|---:|
| Statements | 86,59 % | 80 % |
| Branches | 76,67 % | 75 % |
| Functions | 90,50 % | 80 % |
| Lines | 90,73 % | 80 % |

En ese SHA histórico, el alcance de instrumentación incluía `packages/finance-core/src`, `services/actual-adapter/src` y `services/api/src`, excluyendo los entrypoints `index.ts` y `main.ts`. Ese dato describe únicamente la configuración de aquel commit. La instrumentación vigente y sus exclusiones se mantienen en [docs/test-coverage.md](docs/test-coverage.md); no deben inferirse desde esta ejecución histórica. La cobertura mide ejecución de código, no probabilidad de ausencia de vulnerabilidades ni suficiencia de pruebas de seguridad.

Estas métricas describen una ejecución y un SHA concretos. No se deben copiar como métricas actuales de otro commit: consulta el workflow correspondiente al HEAD que se vaya a integrar.

## Evidencia de cobertura ampliada — 23-nov-2026

Ejecución reproducible sobre el commit [`c33f8592f4c21fd23968fe692dfad94e36a29788`](https://github.com/miguel-np/personal-budget/commit/c33f8592f4c21fd23968fe692dfad94e36a29788):

- [CI, run 45207041952](https://github.com/miguel-np/personal-budget/actions/runs/45207041952): jobs `quality`, `browser-e2e`, `actual-container-smoke`, `windows-quality` y `actual-update-acceptance` completados correctamente.
- [Security, run 45207041872](https://github.com/miguel-np/personal-budget/actions/runs/45207041872): CodeQL y dependency/secret scan completados correctamente.
- Vitest V8: 51 ficheros de test pasaron y 3 se omitieron; 501 tests pasaron y 4 se omitieron deliberadamente.
- Cobertura global: 86,09 % statements, 76,37 % branches, 90,56 % functions y 90,22 % lines; se mantuvieron los umbrales 80/75/80/80.
- Área MCP (`server.mjs`, configuración, definiciones y ejecutores): 85,83 % statements, 71,11 % branches, 93,97 % functions y 91,32 % lines. Las métricas por área son informativas; los umbrales configurados se aplican al conjunto global.
- `npm audit` y `npm audit --omit=dev` informaron cero vulnerabilidades conocidas durante esa ejecución. Esto describe la base de avisos consultada en ese momento y no acredita ausencia de vulnerabilidades.

El mapa de instrumentación, las exclusiones y la separación entre Vitest, `node:test` y Playwright se mantienen en [docs/test-coverage.md](docs/test-coverage.md). La cobertura no mide por sí sola calidad de aserciones, conformidad WCAG ni ausencia de vulnerabilidades.

## Revisiones manuales y aceptación

La documentación previa registra verificaciones manuales del entorno objetivo WSL2: binding de servicios a `127.0.0.1`, rechazo CORS de orígenes no permitidos, saneamiento de errores y exclusión de prompts/detalles de movimientos de logs. Es evidencia de esa sesión, no una comprobación repetida por cada CI.

Las pruebas sintéticas de prompt injection, herramientas MCP desconocidas, confirmación de escrituras y aislamiento de datos son controles de regresión. No sustituyen pruebas de penetración, revisión independiente ni aceptación manual de una instalación concreta.

## Frontera de seguridad del runtime local (#130)

La API y el frontend compilado deben escuchar solo en loopback. El gate HTTP de la API valida el Host contra los hostnames/puertos loopback configurados y comprueba Origin, Referer y Fetch Metadata antes del parseo del cuerpo y de los controladores. Los orígenes de navegador se comparan exactamente con `APP_ALLOWED_ORIGINS`; CORS no se utiliza como mecanismo de autorización.

El frontend servido por Vite Preview aplica una CSP efectiva: scripts, hojas de estilo, conexiones y recursos se restringen al mismo origen (con `data:`/`blob:` solo para imágenes y fuentes necesarias); se bloquean objetos, framing y bases/formularios externos. No se permite `unsafe-eval` ni `unsafe-inline` en scripts o elementos de estilo. La única excepción es `style-src-attr 'unsafe-inline'`, limitada a atributos dinámicos utilizados por las barras de progreso de React; no habilita scripts inline ni elementos/hojas de estilo inline. La API conserva cabeceras HTTP defensivas, pero la CSP que protege el documento se entrega desde el servidor del frontend. Helmet desactiva explícitamente HSTS porque el runtime sirve HTTP en loopback; el frontend Preview tampoco emite esa cabecera.

Las peticiones locales sin Origin, Referer ni Fetch Metadata se admiten para clientes de automatización no navegador. Esto es compatibilidad, no autenticación: cualquier proceso con acceso a la misma cuenta del sistema puede conectarse al loopback. Las defensas de navegador tampoco protegen frente a malware, extensiones privilegiadas o un origen legítimo comprometido.

### Modelo de amenazas y riesgo residual

| Actor | Activo/ruta de ataque | Controles | Riesgo residual |
|---|---|---|---|
| Sitio remoto abierto en el mismo navegador | Formularios, solicitudes simples, navegación o contenido embebido hacia la API local | Host loopback exacto; Origin/Referer y Fetch Metadata; CSP; no se habilita CORS genérico | El navegador, sus extensiones y el origen permitido siguen siendo parte de la base de confianza |
| Origen local no autorizado | Usar otro puerto/alias local o DNS rebinding para alcanzar la API | Host restringido a loopback y puertos configurados; comparación exacta del origen; aliases DNS arbitrarios rechazados | Un proceso local puede acceder directamente a loopback sin simular un navegador |
| Dispositivo de la LAN | Acceso a API, frontend, Actual u Ollama desde otro equipo | Listeners locales ligados a loopback; puertos de servicios no publicados a interfaces externas por defecto | Túneles, proxy inverso o cambios manuales de binding pueden ampliar la exposición |
| Proceso/usuario local distinto o malware | Lectura/escritura de ficheros, llamadas directas a la API y acceso a secretos del usuario | Permisos mínimos de ficheros, secretos locales y límites de la API | No existe autenticación de procesos ni aislamiento entre procesos con la misma cuenta |
| Dependencia o herramienta comprometida | Código con privilegios de ejecución durante build/CI | Acciones fijadas por SHA; npm audit; Gitleaks fijado por digest, sin red, capacidades ni escritura del filesystem | Auditorías no prueban ausencia de vulnerabilidades; una dependencia ejecutada puede actuar con los permisos del job |

La imagen del escáner se fija como `ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854`. La ejecución del contenedor usa red deshabilitada, capacidades eliminadas, filesystem de solo lectura y un `/tmp` efímero limitado. Para actualizarla se verifica la versión y el digest publicados por el registro oficial y se revisa el cambio explícitamente.

No se afirma que CORS, CSP o loopback protejan frente a malware/procesos locales ni que esta aplicación sea multiusuario o segura para exposición pública.

## Informar una vulnerabilidad

No publiques detalles explotables, extractos financieros, archivos de presupuesto ni credenciales en issues públicas. Utiliza la función de comunicación privada de vulnerabilidades de GitHub si está habilitada. En otro caso, acuerda un canal privado con el propietario antes de compartir detalles.

## Requisitos de seguridad

- Mantener la aplicación accesible solo desde `localhost` por defecto.
- No publicar los puertos de Actual Budget, Ollama, backend o MCP en interfaces de red externas.
- No exponer herramientas para ejecutar shell, SQL arbitrario, código o rutas de archivo controladas por el modelo.
- Utilizar una lista permitida explícita de herramientas MCP.
- Validar y limitar entradas, fechas, importes, tamaño de archivos, número de resultados y duración de peticiones.
- Tratar CSV, OFX, QIF, QFX y CAMT como datos no confiables; validar estructura, codificación, tamaño y campos antes de procesarlos.
- Mantener secretos en archivos locales excluidos de Git. No incluir contraseñas bancarias.
- Enmascarar secretos en logs y errores. Evitar registrar descripciones y contenido íntegro de transacciones.
- Mantener dependencias actualizadas y ejecutar auditorías antes de integrar o publicar cambios.
- Respaldar los datos y probar la restauración. Las copias contienen información financiera sensible.
- Mantener los permisos de CI en mínimo privilegio y fijar las Actions de terceros a SHA completo.

## Modelo de amenazas mínimo

Las amenazas incluyen acceso desde otro dispositivo en la red, malware local, extensión de navegador maliciosa, dependencia comprometida, prompt injection en descripciones de movimientos, acceso excesivo del modelo a herramientas, pérdida o robo de copias y errores de importación que dupliquen movimientos.

El carácter local no protege frente a alguien que ya tenga acceso a la cuenta de Windows/WSL o a archivos sin cifrar. Utiliza cifrado de disco, una cuenta del sistema protegida y copias cifradas.


## Gates automatizados de CI

El workflow de seguridad ejecuta CodeQL para JavaScript/TypeScript con la Action fijada a un SHA completo, además de las auditorías npm y Gitleaks. Los permisos de escritura de resultados de CodeQL se conceden solo al job que publica el análisis; el resto del workflow conserva lectura de contenido.

Gitleaks analiza el rango de commits entrante en pull requests y pushes. Las ejecuciones programadas y manuales omiten el rango incremental para volver a inspeccionar el historial Git completo. Esto puede volver a detectar secretos históricos aunque se hayan eliminado del árbol actual; una detección debe investigarse y corregirse mediante el procedimiento privado de incidentes.

La auditoría automática no sustituye revisión de código, pruebas de penetración ni análisis de riesgos de despliegue. Los resultados de CodeQL y npm deben revisarse para el SHA que se pretenda integrar.
