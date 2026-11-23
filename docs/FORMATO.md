# Documento de mundo

La extensión del formato propio es `.mworld`. El motor escribe enteros little-endian y números IEEE 754. Los identificadores de entidad son de 64 bits. El cero identifica la raíz virtual. `next_id` se conserva después de eliminar entidades para impedir que se reasignen los identificadores antiguos.

| Encabezado | Ancho | Contenido |
| --- | --- | --- |
| Firma | 8 bytes | ASCII MWENGIE seguido de un byte cero |
| Versión | u32 | 1 o 2 |
| Cantidad | u32 | Número de nodos |
| Próximo identificador | u64 | Valor mayor que cada identificador almacenado |

Cada nodo contiene ID u64, padre u64, tipo u8, longitud de nombre u8 y nombre UTF-8 de 1 a 95 bytes. Le siguen diez valores f64 en orden posición XYZ, cuaternión XYZW y escala XYZ. Los cinco valores de material son f32 para RGB lineal, rugosidad y metalicidad. Los tipos de nodo en orden son grupo vacío (0), caja (1), cilindro (2) y esfera (3).

En versión 2, cada nodo añade al final una clave visual u64. Cero selecciona la forma y el material originales. Un valor distinto de cero permite buscar el mismo objeto en el catálogo artístico publicado. Los archivos de versión 1 se leen con clave cero y se siguen escribiendo en versión 1 hasta que el autor vincula algún objeto a un catálogo. La clave visual no modifica la definición del cuerpo físico.

El cargador valida tamaños antes de reservar memoria y verifica el documento en una instancia nueva. Rechaza referencias de padre inexistentes, ciclos, identificadores duplicados, versiones desconocidas, cadenas UTF-8 inválidas y valores fuera de rango. Los límites iniciales son 65 536 entidades, 64 niveles de jerarquía y 24 MiB por archivo. Los archivos solo expresan datos.

Una transformación local contiene metros, rotación unitaria y escala positiva. Las matrices se componen padre por hijo. El renderizador recibe matrices relativas a la cámara para conservar precisión en mundos extensos. La base usa Y como eje vertical. Las primitivas se inscriben en un cubo de lado uno centrado en el origen.

Esta revisión introduce un formato nuevo para el motor. La migración desde documentos de aplicaciones anteriores requiere un importador explícito que preserve el archivo original. La versión del documento es independiente de la versión del motor.

## Proyecto privado de juego .mproject v1

Studio escribe este contenedor. MUNDO web, Windows, Android e iOS tienen lectores para el mismo formato. Un proyecto tiene entre 1 y 32 entradas y ocupa hasta 64 MiB en total. Cada entrada contiene los bytes exactos de una sala .mroom. En el caso de un borrador Studio crea una sala con revisión interna 1 y marca su procedencia en el índice. Al añadir una publicación conserva su revisión.

| Desplazamiento en bytes | Campo |
| --- | --- |
| 0–7 | Firma ASCII `MUNDOPRJ` |
| 8–11 | Versión 1, entero sin signo de 32 bits little-endian |
| 12–15 | Longitud del índice en bytes, entero sin signo de 32 bits little-endian, entre 1 y 16 KiB |
| 16–79 | SHA-256 de los bytes del índice, 64 caracteres hexadecimales minúsculos ASCII |
| Desde 80 | Índice JSON UTF-8 seguido de las salas en el orden del índice |

El índice contiene `name`, `start` y `worlds`. Cada fila de `worlds` contiene `id`, `source` (`draft` o `publication`), `size` en bytes y `hash` SHA-256 del archivo .mroom completo. Los ID son enteros positivos únicos representables exactamente en JavaScript, entre 1 y 9007199254740991. El campo `start` debe coincidir con un ID de la lista. La suma de cabecera, índice y tamaños debe coincidir con la longitud del archivo. La procedencia identifica cómo se capturó el mundo en Studio.

Antes de adoptar un proyecto se comprueban el índice, los límites, las huellas y los metadatos de cada sala, y se decodifica cada .mworld por turnos. El lector conserva los datos de las salas y puede recuperar el mundo inicial o reabrir otro en el editor. Para obtener los bytes que se resumen se usa el archivo o índice almacenado directamente.


## Apertura y viaje local en 0.31.0

El lector C++ recibe el flujo de archivo y un verificador de SHA-256 del sistema operativo. Comprueba el índice, la huella de cada .mroom y los bytes de mundo. Las salas v2 y v3 también llevan la huella de la selección. El lector decodifica las entradas una por una y prepara el destino al final. Comprueba la disponibilidad de las dos plazas cuando Studio definió un encuentro. El personaje local llega a la primera plaza.

La selección de destino contiene el ID del mundo y la huella del índice que el jugador abrió. Un título se puede repetir. La lista muestra también el ID. Antes de cambiar, los reproductores nativos vuelven a comprobar los contenidos del archivo. El reproductor web conserva las copias inmutables del archivo abierto y valida el destino elegido. El cambio ocurre a pie y reinicia la visita a ese mundo. El guardado de progreso móvil conserva la última posición por separado del proyecto de Studio.

## Portales locales en .mproject v2

Studio usa la revisión 2 cuando el proyecto contiene enlaces. La cabecera conserva sus 80 bytes y el índice conserva los límites de la revisión 1. La tabla `portals` contiene entre 1 y 64 registros con tres campos. Por ejemplo, `{"from":1,"tile":"181","to":2}` enlaza la entidad 181 del mundo 1 con la entrada del mundo 2. La entidad se identifica por su ID de 64 bits escrito en decimal canónico. El origen y el destino deben ser mundos distintos de la misma colección. Cada baldosa de un mundo admite un destino. Studio escribe la revisión 1 cuando la colección carece de enlaces.

Una baldosa es una caja pública en la raíz del mundo. Usa la clave visual 0 y un nombre que empieza por `Portal/` seguido de una etiqueta. Admite giro en Y, anchos y fondos de 1 a 12 m y alturas de 0,04 a 0,20 m. Conserva la geometría, el color, el historial de edición y el ID del bloque. La tabla del proyecto vincula esa pieza con otro mundo. Están excluidas las referencias a rutas, invitaciones y archivos externos. Los lectores comprueban cada enlace contra la geometría de la sala de origen antes de adoptar el proyecto.

El cruce ocurre durante un paso de movimiento con el personaje apoyado, cuando el centro de sus pies entra en la superficie orientada de una baldosa enlazada y queda a 6,5 cm o menos de su cara superior. Al comenzar, reaparecer o bajar del turismo sobre una baldosa hay que abandonarla a pie para activarla. Si coinciden varias, tiene prioridad la de menor ID. Se inicia un único viaje, vinculado al índice abierto. Un fallo de lectura conserva el mundo actual.

Al sustituir la copia de un mundo, Studio permite conservar las salidas con el mismo ID de baldosa y avisa de cuántas dejarán de existir. Al retirar un mundo elimina sus salidas y las entradas que lo señalaban. Si más tarde se reutiliza el ID de ese mundo, comienza libre de los enlaces retirados.

## Proyecto musical privado .mprojectmusic

La firma `MPMUSIC1` envuelve una copia para invitados `MUNDOPRJ` o `MPRAUD01`. La segunda opción conserva también el banco de grabaciones cortas. Los primeros 24 bytes guardan la firma, el tamaño de la base, la cantidad de pistas, el tamaño total de sus bloques y un campo reservado igual a cero. Todos los enteros usan little-endian.

Cada pista empieza con su ID u64, cantidad de segmentos u32, tamaño completo del bloque u32 y SHA-256 binario de su manifiesto. Cada segmento contiene SHA-256 binario, tamaño u32 y WAV PCM canónico. Las pistas se ordenan por ID sin duplicados. Los segmentos se ordenan desde cero. El ID se deriva de los primeros 64 bits de la huella del manifiesto y cero se sustituye por uno.

El lector admite hasta ocho pistas y 128 MiB de música. Exige correspondencia exacta entre las pistas adjuntas y los marcadores `MUNDO/Music/v1` de los mundos. Una pista compartida se almacena una sola vez. Las grabaciones, las pistas y los segmentos ajenos al proyecto provocan el rechazo completo del contenedor.

## Identidad del informe de tiempos de circuito

El panel del anfitrión exporta JSON UTF-8 con `format` igual a `MUNDO-course-timing` y `version` igual a 1. El campo `revision` contiene el SHA-256 de los bytes del mundo `.mworld`. El campo opcional `publication` contiene el SHA-256 que identifica la publicación en el registro de tiempos. Ambos se escriben en hexadecimal minúsculo.

Para una sala `.mroom`, el anfitrión calcula `publication` sobre el archivo completo. Si la sala forma parte de un proyecto, utiliza la huella de esa entrada. Así, dos publicaciones con la misma geometría pueden tener registros distintos al cambiar el turismo o el punto de encuentro. Al abrir directamente un `.mworld`, la clave de su registro coincide con `revision`. El lector admite `publication` ausente o `null` cuando se desconoce.

Para comparar dos informes, Studio coteja la revisión del mundo, el ID del turismo y las puertas en orden. Cuando uno de ellos incluye la huella de publicación, el otro debe incluir la misma huella. Las vueltas de informes antiguos que carecen de este dato siguen siendo comparables entre sí con las identidades disponibles.
