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
