# Continuidad de MUNDO

Antes de cambiar el proyecto, leer `PROJECT_RULES.md`, el ámbito pertinente de
`REGRESSION_LESSONS.md` y `planning/starred-repositories.json`. Continuar la
fuente existente y preservar MUNDO Studio, IDs, mundos, cuentas e historia.

## Los nueve favoritos del propietario

El 15 de noviembre de 2026 el propietario confirmó que quiere los nueve
repositorios como conjunto técnico de MUNDO y como referencias para sus futuras
peticiones. Consultar los nueve roles al decidir una solución; los componentes
se combinan según su función en el mismo proyecto.

| Repositorio oficial | Buscar aquí para |
| --- | --- |
| https://github.com/mrdoob/three.js | Render 3D, materiales, animación y loaders del cliente actual |
| https://github.com/godotengine/godot | Herramientas de escenas, importación/intercambio y revisión de Studio |
| https://github.com/dimforge/rapier | Física, volúmenes, colisiones y pruebas de simulación |
| https://github.com/colyseus/colyseus | Red multijugador, salas, sincronización y servidor autoritativo |
| https://github.com/isaac-mason/recast-navigation-js | Navmesh, búsqueda de caminos y navegación |
| https://github.com/donmccurdy/glTF-Transform | Preparación, validación y transformación de escenas/modelos GLB |
| https://github.com/zeux/meshoptimizer | Optimización de índices/vértices y geometría |
| https://github.com/BinomialLLC/basis_universal | Compresión de texturas y transcodificación Basis/KTX2 |
| https://github.com/open-telemetry/opentelemetry-js | Instrumentación, diagnóstico y rendimiento |

El registro JSON contiene versiones, carpetas e integración comprobada. Leer
primero el código local; usar documentación oficial de estos upstreams para
verificar APIs/versiones. No volver a confundir el repositorio propio MUNDO con
la lista de favoritos del propietario.

## Estado real que conservar

- Base 0.48.0; P49 y P50 son propuestas, no versiones productivas publicadas.
- `tools/engine/README.md` documenta el flujo conjunto de los nueve, sus pruebas
  reales y sus límites. Reutilizarlo antes de añadir otro laboratorio o backend.
- Three r160 sigue siendo el renderer del juego. Godot es una herramienta
  conectada de Studio; no reemplazar automáticamente el juego ni duplicar
  identidad/persistencia por tener dos motores disponibles.
- Rapier/Recast se ejecutan en el preflight explícito del lab Colyseus y el
  proceso local de revisión. La autoridad, movimiento y protocolo anteriores
  permanecen hasta una migración específica comprobada.
- OpenTelemetry está desactivado por defecto y sin exporter. No activar envío
  externo de datos por el mero hecho de ser un favorito.
- Distinguir código integrado, pruebas locales, servicio publicado y requisitos
  operativos. Tener nueve favoritos no prueba que los nueve estén activos en
  producción o aporten valor a cada cambio pequeño.
- Conservar las reglas previas de revisión antes de incorporar/publicar y los
  respaldos completos acumulados, con Studio en una parte separada.

## Comunicación general y respaldos del proyecto y del chat

Instrucción expresa del propietario del 15 de noviembre de 2026:

- La atribución de repositorios se aplica EN GENERAL a todo el trabajo de MUNDO
  y Studio, no solo a seguridad: gráficos, avatar, movimiento, física, red,
  navegación, activos, herramientas, optimización, diagnóstico y demás cambios.
  Indicar brevemente el repositorio/componente realmente utilizado, para qué
  sirve en ese cambio y qué parte es código propio. No inventar el uso de una
  biblioteca ni atribuirle funciones que no proporciona.
- Señalar el alcance real: propuesta, prueba local o servicio activo. Por
  ejemplo, Colyseus aporta infraestructura multijugador y OpenTelemetry aporta
  diagnóstico; eso no demuestra por sí solo cifrado o permisos correctos.
- En cada entrega de una actualización, proporcionar respaldo COMPLETO y
  acumulado de MUNDO y otro completo de MUNDO Studio en una parte separada, como
  en la entrega P50. Conservar respaldos previos, historia, fuente, recursos,
  versiones/licencias de dependencias, compilación disponible, migraciones,
  pruebas, continuidad y mundos/progreso exportados disponibles.
- No sustituir esos respaldos por parches o archivos sueltos; preservar los
  originales y no afirmar acceso a datos guardados únicamente en otro equipo.
- Incluir además el respaldo del CHAT: conservar todos los mensajes de usuario,
  respuestas y actualizaciones visibles que se puedan recuperar, más los
  registros anteriores intactos. Distinguir siempre la transcripción literal
  de los resúmenes y notas de continuidad. Señalar el corte temporal y cualquier
  tramo no recuperable; no fabricar mensajes ni llamar completo a un resumen.
- Mantener la conversación privada en los respaldos del propietario, separada
  del código. Pedir autorización específica antes de subir el chat a GitHub u
  otro destino externo; guardar una regla de trabajo no autoriza ese envío.
