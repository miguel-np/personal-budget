# Adopción de GitHub Spec Kit

**Estado**: iniciada en la rama `chore/adopt-spec-kit`; integración CLI pendiente de ejecutar y verificar en el checkout local.

## Decisión

Spec Kit sí aplica a Personal Budget. El repositorio ya tiene arquitectura, ADR, roadmap, criterios de calidad, Skills financieras e Impeccable, pero no tenía un proceso uniforme que conectara una necesidad nueva con especificación, plan, tareas, implementación y convergencia.

Se adopta Spec Kit para el ciclo de vida de cambios funcionales y técnicos. No sustituye:
- Issues y PR para planificación y revisión.
- ADR para decisiones arquitectónicas duraderas.
- Skills financieras para instrucciones de dominio.
- Impeccable para trabajo UX/UI.
- Pruebas, CI y controles de seguridad como evidencia real.

## Versión e integración seleccionadas

- Spec Kit: release fijada `v1.0.6`.
- Agente: Codex.
- Layout Codex: skills en `.agents/skills/speckit-*/SKILL.md`.
- Invocación: `$speckit-constitution`, `$speckit-specify`, `$speckit-clarify`, `$speckit-plan`, `$speckit-tasks`, `$speckit-analyze`, `$speckit-implement` y `$speckit-converge`.
- Extensiones adicionales (bug fixing, idea assessment), presets y eventos automáticos quedan fuera de la primera adopción.

La integración Codex de Spec Kit es compatible con el directorio compartido `.agents/skills/` y se declara multi-install safe. Los nombres `speckit-*` no colisionan con las Skills financieras ni con `impeccable`.

## Protección de los hooks existentes

Impeccable ya aporta `.codex/hooks.json`. Para no añadir una segunda capa de eventos de Spec Kit ni alterar el detector visual, la instalación de Codex debe hacerse con eventos de Spec Kit desactivados:

```bash
--integration-options="--skills --events false"
```

No modificar ni reemplazar `.codex/hooks.json`. Los comandos de Spec Kit se invocarán explícitamente como Skills.

## Instalación de CLI e integración

Requisitos oficiales: `uv`, Python 3.11 o superior y Codex CLI.

Instalar la release fijada desde el repositorio oficial:

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.6
specify version
```

Desde la raíz del repositorio, en una rama con baseline revisable:

```bash
specify init --here --force --integration codex --integration-options="--skills --events false"
specify integration status
specify check
```

La opción `--force` solo debe ejecutarse sobre una rama limpia y revisable: la inicialización en un proyecto existente puede reemplazar archivos gestionados en rutas coincidentes. Revisar el diff completo antes de integrar. Comprobar que:
- Se han generado los archivos compartidos `.specify/`.
- Se han instalado las Skills `speckit-*` sin sobrescribir Skills existentes.
- La constitución de este repositorio se conserva.
- `.codex/hooks.json` sigue siendo el de Impeccable y no aparecen handlers de Spec Kit en `.codex/config.toml`.
- No se han modificado código de aplicación, dependencias npm, lockfiles ni datos.

## Primer uso: cambio acotado

La issue #85 (proveedores intercambiables) es una candidata adecuada para probar el método, pero no debe abordarse de una sola vez: mezcla contrato, adaptadores, configuración, credenciales, consentimiento, capacidades, enrutamiento y costes.

La primera especificación piloto es `specs/001-ollama-provider-boundary/spec.md`. Delimita una primera fase segura: crear una frontera de proveedor y encapsular Ollama, sin implementar todavía OpenAI/xAI ni enviar datos a cloud.

Flujo para continuar en Codex, después de instalar las Skills:

1. Revisar/ratificar la constitución con `$speckit-constitution`.
2. Refinar la especificación con `$speckit-clarify` y resolver los puntos `NEEDS CLARIFICATION`.
3. Generar `plan.md` y los artefactos técnicos con `$speckit-plan`.
4. Generar tareas verificables con `$speckit-tasks`.
5. Ejecutar `$speckit-analyze` antes de implementar.
6. Implementar solo tras revisar y aprobar especificación, plan y tareas.
7. Cerrar con `$speckit-converge` y los controles habituales de CI.

No se debe usar el primer piloto para documentar retrospectivamente todo el sistema.

## Política de persistencia de especificaciones

Propuesta inicial: cada carpeta `specs/NNN-.../` conserva el registro de una entrega. Una especificación completada no se reescribe para describir silenciosamente cambios posteriores; una evolución material crea una nueva especificación enlazada a la anterior y a su issue/PR. Las correcciones de documentación pueden actualizarse durante la entrega antes de merge.

La decisión queda pendiente de confirmación al completar el primer piloto.

## Límites de la adopción actual

La constitución y la primera especificación se han preparado en la rama de adopción siguiendo la estructura y los templates oficiales de Spec Kit v1.0.6. El CLI no se ha ejecutado desde este entorno; por tanto, la instalación de las Skills, generación de scripts/templates, registro de integración y verificación de hooks siguen pendientes. No afirmar que Codex ya reconoce los comandos hasta completar los pasos locales anteriores.
