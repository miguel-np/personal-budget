# Licencia y derechos sobre datos

## Recomendación para `personal-budget`

La propuesta inicial es **MIT para el código y la documentación originales**. Es una licencia permisiva, breve y adecuada si el objetivo es publicar una aplicación local-first que otras personas puedan instalar, adaptar y redistribuir sin obligaciones de copyleft. Exige conservar los avisos de copyright y la licencia en copias o partes sustanciales, pero permite distribuir versiones modificadas bajo otras condiciones, incluso propietarias. Consulta el resumen de [MIT en Choose a License](https://choosealicense.com/licenses/mit/).

Esta decisión presupone que el propietario quiere permitir reutilización y uso comercial por terceros. Si no desea conceder esos permisos, no debe publicar el proyecto con MIT. En ese caso, puede mantener el repositorio privado o elegir una licencia distinta después de definir qué reutilización quiere permitir.

## Alternativas consideradas

| Licencia | Cuándo encaja | Consecuencia principal |
| --- | --- | --- |
| **MIT (recomendada)** | Se priorizan simplicidad, adopción y reutilización amplia. | Permite uso comercial, forks y derivados bajo otros términos; conserva el aviso de licencia. |
| **Apache-2.0** | Se desea una licencia permisiva con concesiones expresas de patentes y condiciones más detalladas. | También permite derivados propietarios; pide conservar avisos y atender sus condiciones de redistribución. |
| **GPL-3.0-only** | Se quiere que las versiones modificadas distribuidas sigan ofreciendo el código fuente bajo copyleft. | Impone condiciones de licencia y entrega de fuente al redistribuir obras cubiertas. |
| **AGPL-3.0-only** | Se desea que el copyleft también cubra ciertos usos modificados a través de una red. | Añade condiciones para ofrecer el código fuente de versiones modificadas usadas por usuarios mediante red. No parece necesario para la finalidad local de este proyecto, salvo que evolucione a un servicio alojado. |
| **Sin licencia** | El repositorio es público solo para inspección y no se quieren conceder permisos generales de reutilización. | Se aplican las reglas de copyright predeterminadas; la visibilidad pública no equivale a una licencia de código abierto. |

Fuentes para la elección: [GitHub: licenciar un repositorio](https://docs.github.com/es/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository), [Choose a License: MIT](https://choosealicense.com/licenses/mit/), [Apache-2.0](https://choosealicense.com/licenses/apache-2.0/), [GPL-3.0](https://choosealicense.com/licenses/gpl-3.0/) y [AGPL-3.0](https://choosealicense.com/licenses/agpl-3.0/).

## Alcance de `LICENSE`

El archivo `LICENSE` concede la licencia MIT sobre el código y la documentación originales cubiertos por el titular de derechos. No concede derechos sobre marcas, datos personales, extractos bancarios, activos de terceros, dependencias, imágenes de contenedor ni pesos de modelos. Revisa los archivos `LICENSE`, `NOTICE` y términos de cada dependencia o modelo concreto antes de redistribuirlo.

## Datos financieros y privacidad

La licencia del proyecto no se aplica a los extractos bancarios, cuentas, transacciones ni datos personales introducidos por el usuario. **No incluyas datos financieros reales, bases de datos, extractos, credenciales, exportaciones, logs sensibles ni copias de seguridad en el repositorio.** El `.gitignore` proporciona exclusiones, pero no sustituye una revisión antes de cada commit.

## Componentes y modelos de terceros

Actual Budget, Node.js, React, Ollama, las bibliotecas npm, las imágenes de contenedor y el modelo descargado conservan sus propias licencias y avisos. La licencia de `personal-budget` no reemplaza ni amplía esas licencias.

- Actual Budget declara usar MIT en su [repositorio oficial](https://github.com/actualbudget/actual). Esto no elimina la obligación de conservar sus avisos cuando se incorpore o redistribuya código suyo.
- Revisa la licencia del modelo exacto que descargues y las condiciones del proveedor del runtime. Que un modelo se ejecute localmente o se descargue gratis no significa que sus pesos estén bajo MIT ni que carezcan de condiciones.
- Genera un inventario de dependencias y conserva los avisos exigidos por sus licencias.
- No distribuyas pesos, imágenes ni código de terceros salvo que sus licencias lo permitan.
- No presentes el proyecto como oficial ni afiliado a Actual Budget, Ollama u otros proveedores.

La implementación prevista integra Actual Budget mediante su API documentada; eso no implica que el repositorio redistribuya el código de Actual. Si se incorpora código de terceros, hay que revisar y mantener los avisos y las condiciones aplicables.

## Confirmación antes de publicar versiones

La recomendación MIT solo es apropiada si el propietario acepta que otras personas usen, modifiquen, publiquen y comercialicen derivados sin obligación general de divulgar sus cambios. Si ese resultado no es deseable, cambia la elección de licencia **antes de distribuir**. Esta documentación es orientación técnica general y no asesoramiento jurídico.
