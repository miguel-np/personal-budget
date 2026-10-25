# Roadmap

El roadmap refleja prioridades propuestas. No implica que una función ya esté implementada.

## Fase 0 — Especificación

- [x] Definir objetivo local-first y alcance personal.
- [x] Documentar arquitectura, límites de privacidad y uso.
- [x] Definir Actual Budget como fuente financiera inicial.
- [x] Definir herramientas MCP previstas y política de solo lectura.

## Fase 1 — Base financiera

- [ ] Preparar repositorio ejecutable y entorno de desarrollo.
- [ ] Configurar Actual Budget y crear un presupuesto de prueba.
- [ ] Implementar el adaptador oficial `@actual-app/api`.
- [ ] Validar consulta de cuentas, categorías y movimientos con datos sintéticos.
- [ ] Añadir pruebas de sumas, traspasos, reembolsos y divisiones por divisa.

## Fase 2 — Aplicación web

- [ ] Implementar dashboard y selección de periodos.
- [ ] Implementar lista, búsqueda y registro de movimientos.
- [ ] Implementar informes de categorías, comparativas y ahorro.
- [ ] Añadir importación/conciliación con revisión de duplicados a través de Actual.

## Fase 3 — Asistente local

- [ ] Conectar Ollama local.
- [ ] Implementar funciones financieras deterministas.
- [ ] Añadir herramientas MCP opcionales en modo de solo lectura.
- [ ] Probar tool calling, errores, timeouts y prompt injection.
- [ ] Añadir preparación de cambios con confirmación explícita, sin escrituras autónomas.

## Fase 4 — Seguridad y fiabilidad

- [ ] Revisar tráfico de red y dependencia/telemetría.
- [ ] Añadir copias de seguridad cifradas y probar restauración.
- [ ] Añadir lint, pruebas, análisis de dependencias y builds reproducibles.
- [ ] Documentar versiones soportadas y procedimiento de actualización.

## Fuera del alcance inicial

- Conexión bancaria automática.
- Acceso remoto público o multiusuario.
- Pagos, transferencias bancarias, inversión o asesoramiento fiscal.
- Funciones de IA que escriban o borren información sin aprobación.
- Sincronización a servicios de nube de terceros como valor predeterminado.
