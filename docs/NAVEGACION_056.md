# Navegación a pie y personajes de MUNDO 0.56.0

## Crear y jugar

Abre el proyecto original [Los dos patios](../examples/navigation/Los_dos_patios.mproject) en el editor de mundos de Studio. En **Personajes y rutas a pie**, elige posiciones en el terreno o escribe X, Y y Z en metros. Y es la altura de los pies. Una ruta admite entre uno y 32 puntos. Puedes asignar una misma ruta a varios personajes, cambiar su velocidad y la duración de sus paradas. Cada sala admite 16 rutas y ocho NPC. **Comprobar recorrido guardado** usa el planificador del anfitrión e identifica el tramo o el origen que requiere atención. En una patrulla incluye el regreso al origen. Para un seguidor comprueba la aparición, ya que el destino depende del visitante.

Guarda el borrador o prepara su publicación por el flujo habitual. El archivo conserva los marcadores como grupos vacíos. Los proyectos anteriores se abren con sus datos originales. El arte y los componentes privados conservan su propio mecanismo de autorización.

Desde la raíz de la entrega, abre una sala con Node:

```sh
node server/room.cjs examples/navigation/Los_dos_patios.mproject
```

La invitación que emite el anfitrión abre la partida en MUNDO. El mapa del panel local muestra la altura y el estado de cada NPC, incluso el motivo de un bloqueo si el personaje todavía no pudo aparecer.

## Simulación y guardado

El planificador consulta el volumen de colisión de los objetos, transformado a coordenadas del mundo. Busca suelo a la altura correcta, despeje para el cuerpo y transiciones posibles entre superficies. Usa coordinación en X, Y y Z para distinguir dos alturas con idéntica posición horizontal. Los barridos comprueban el camino entre posiciones, incluidos los pasos estrechos y los cambios de escalón. Una ruta larga se divide en tramos. Cada búsqueda tiene un presupuesto. El estado de diagnóstico permite distinguir una búsqueda que agotó su presupuesto de un destino al que no se encontró acceso.

El anfitrión avanza patrullas y seguidores en pasos de 50 ms. La patrulla recorre sus puntos, espera y vuelve. Un seguidor elige un visitante próximo alcanzable y regresa al origen cuando deja de acompañarlo. Los clientes reciben los identificadores de 64 bits, la pose y el estado. Un cliente compatible solicita la extensión mediante `x-mundo-npcs: 1`. El servidor mantiene los mensajes binarios anteriores para las demás plazas y limita las poses visibles a la zona de terreno confirmada. La frecuencia de simulación de NPC es independiente de los FPS del reproductor.

Al aparcar un mundo o reabrir una partida guardada, el servidor recupera el punto de destino, la posición, la orientación y la pausa restante. Valida los datos contra la revisión del mundo y vuelve a planificar con las colisiones actuales. Las sesiones anteriores sin datos de NPC conservan la aparición que escribió el creador.

## Verificación y continuación

Las pruebas locales cubren el archivo de Studio y su exportación para invitados, sala HTTP con dos plazas, desplazamiento y reaparición tras reconectar, viaje con votos entre salas y restauración. El decodificador C++ se probó en Linux, incluida la lectura de cuatro variantes producidas por el servidor. Los recorridos web del editor y del reproductor se probaron con DOM y dibujo simulados. Queda pendiente observar píxeles en un navegador gráfico y ejecutar las compilaciones de Windows, Android e iOS en sus plataformas.

Las claves de trabajo iniciales `navegacion-01` y `navegacion-02` tienen commits registrados en Mundo IA. La siguiente clave es `navegacion-03`, que añade altura continua sobre rampas a la física compartida y verifica las pendientes. Después viene `navegacion-04` para enlaces de escalera entre plantas. La entrega 0.56.0 emplea las cajas de colisión del motor, con escalones y descansos. Siguen pendientes las superficies inclinadas de precisión, los enlaces especiales y las mediciones en el hardware objetivo.
