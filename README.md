# Mundo Engie

**Versión privada 0.60.0 · MUNDO ENTERTAINMENT LLC · 23 de noviembre de 2026**

Mundo Engie es el motor de MUNDO Studio, la aplicación de creación, y de MUNDO, la plataforma donde la gente entra a jugar las experiencias en línea. Los creadores pueden diseñar mapas de géneros y estilos distintos. El formato `.mworld` guarda sus escenas. Las casas, los vehículos y los objetos pueden utilizar modelos tridimensionales con superficies y materiales propios. El detalle gráfico se ajusta por dispositivo.

**Meta del propietario.** Desarrollar un motor propio de propósito general con un alcance comparable a Unreal. MUNDO y MUNDO Studio son las primeras aplicaciones del motor.

## Música larga de Studio a una sala privada · 0.60.0

Studio importa una pista WAV de hasta 16 minutos, la convierte a PCM mono de 24 kHz y la divide en segmentos de 12 segundos identificados por SHA-256. El archivo `.mroommusic` conserva la sala sellada y su inventario ordenado. El anfitrión entrega solamente los segmentos de la revisión admitida y el reproductor conserva una ventana máxima de dos segmentos, cancela las descargas al salir y puede repetir la pista desde el principio.

[Publicación, autorización y pruebas de música larga](docs/AUDIO_060.md)

## Ventana acotada para música larga · 0.59.0

El motor nativo y el reproductor web aceptan música como una secuencia ordenada de segmentos PCM verificados. Conservan únicamente el segmento que suena y el siguiente, continúan en la frontera de muestra y descartan la cola cuando cambia la revisión. Esta entrega cerró el núcleo de reproducción de `audio-03`.

[Estado, límites y comprobaciones de música segmentada](docs/AUDIO_059.md)

## Transiciones del mezclador · 0.58.0

Los buses de ambiente, efectos, música y voces, además del volumen general, admiten cambios inmediatos o transiciones con duración acotada. El motor nativo y el mezclador web calculan las mismas ganancias por muestra. Studio permite escuchar los cambios con una transición configurable sin alterar la escena publicada.

[Configurar y verificar las transiciones](docs/AUDIO_058.md)

## Audio de Studio a la partida · 0.57.0

La **Plaza del carillón** es una sala privada para dos jugadores. Lleva viento en 2D, agua y maquinaria en 3D, y una campana original importada como WAV. Studio permite colocar fuentes, escuchar la mezcla desde la cámara y publicar los sonidos seleccionados de una sala o de un proyecto con portales.

[Usar el panel de audio y abrir la plaza](docs/AUDIO_057.md) · [Descargar la sala de ejemplo](examples/audio/Plaza_del_carillon.mroomaudio)

## Navegación y personajes de sala · 0.56.0

En Studio, abre **Personajes y rutas a pie** para colocar puntos sobre el suelo, ordenar las paradas, asignar la ruta a un personaje y comprobar el recorrido. El guía de **Los dos patios** rodea un muro y hace una pausa. Al cruzar al jardín, el segundo guía acompaña a un visitante.

[Proyecto jugable y comando de anfitrión](examples/navigation/README.md) · [Funcionamiento, verificaciones y continuación](docs/NAVEGACION_056.md)

## Edición de escenas, documentos y plugins · 0.55.0

El anfitrión puede abrir una sala por su identificador, editarla en un solo lote y guardar el borrador en una copia nueva del proyecto. Studio permite añadir plantillas locales de componentes mediante archivos `.mplugin`. El archivo de proyecto conserva los componentes de las piezas después de retirar la extensión del editor.

[Editar escenas y recuperar proyectos](docs/FUNDAMENTOS_055.md) · [Usar y actualizar plugins locales](docs/PLUGINS.md) · [Abrir el Taller de señales](examples/plugins/Taller_de_senales.mproject) · [Reconstruir la entrega privada](docs/RESPALDAR_ENTREGA.md)

## Prioridades del propietario y componentes de autor · 0.54.0

Studio incluye un inspector de componentes por pieza. El archivo de proyecto conserva su clave, versión y campos de autor. Mundo IA reconoce tres tareas ya integradas en la historia de esta entrega. En la entrega 0.54.0, la siguiente clave era `navegacion-01`, para crear rutas de puntos de paso en Studio.

[Orden de trabajo, estado y recuperación](docs/MUNDO_IA_ORDEN_054.md)

## Mundo IA y el desarrollo continuo · 0.53.0

El taller privado incluye una primera cola de 29 tareas para 14 áreas de Mundo Engie. El proceso de escritura prepara un commit y su respaldo antes de pasar al siguiente cambio. El presupuesto inicial es de 120 jornadas activas de ocho horas por área y se conserva al reanudar. La primera área continúa el recorrido de los modelos de Studio hacia los jugadores de Windows, Android e iOS.

[Preparar el asistente privado, consultar las jornadas y recuperar sus cambios](docs/MUNDO_IA_CONTINUA_053.md)

## Modelos del creador en Studio y en MUNDO · 0.52.0

El editor privado importa geometría OBJ, guarda su catálogo y permite colocar varias instancias en un mapa. Incluye una lámpara original y un inspector de triángulos con tres vistas. La publicación opcional `.mroom3d` reúne el mapa con sus modelos. El anfitrión elige si los jugadores admitidos pueden recibir esas mallas en MUNDO web. El mismo archivo permite reabrir la escena en otro Studio.

[Crear, trasladar y compartir un modelo original](docs/MODELOS_DE_CREADOR_052.md) · [Las 14 áreas del motor](docs/ALCANCE_Y_PLAZOS_051.md)

## Colocar y compartir el cupé Bruma · 0.51.0

Abre `propietario/MUNDO_Studio_0.51.0.html` y elige **Crear pista con Bruma**. La pista es editable y ya tiene seleccionado un turismo para dos plazas. En un mundo propio abre **Escena → Modelos 3D**, elige **Cupé Bruma · dos plazas** y colócalo en una superficie. Puedes girar o duplicar el grupo y elegir qué ejemplar estará disponible en la partida. El mapa conserva las piezas, sus transformaciones y la selección al publicar la revisión.

En el panel local del anfitrión, prepara el archivo de sala y activa **Compartir el modelo de Bruma en esta sala web** para ofrecer el acabado detallado a los invitados. Los jugadores ocupan asientos distintos. Las ruedas siguen la dirección y la distancia del turismo que controla el servidor. La geometría tiene tres niveles de detalle. El editor privado incluye el catálogo del propietario. El editor ordinario admite seleccionarlo desde un archivo local. Las fuentes de Windows, Android e iOS incorporan el catálogo al construir la edición del propietario.

El panel de Mundo IA incluye un plan para la importación de modelos propios en Studio y sesiones configurables en horas. Esta entrega deja ese plan en archivo. La compilación, ejecución, corrección de fallos y medición quedan aplazadas por decisión del propietario.

[Parte por parte y tiempos de desarrollo orientativos](docs/ALCANCE_Y_PLAZOS_051.md) · [Autoría del vehículo](authoring/bruma/ARTE.md)

## Modelos reutilizables en Studio · 0.50.0

En **MUNDO Studio → Escena → Modelos 3D** puedes colocar una maceta de terracota o una baliza de paseo en tu propio mapa, moverlas y guardar la experiencia. **Patio de cerámica** es una plantilla editable que usa ambos objetos. Una publicación puede recomendar a Inés como personaje. El panel del anfitrión muestra la elección y permite autorizar la distribución de su apariencia para la sala.

## Inés y el cupé Bruma

El panel del anfitrión permite vestir los avatares de una sala web privada con la malla articulada de **Inés**, la mecánica del puerto. La vista del propietario en Bajamar la encuadra delante de **Bruma**, un cupé original con carrocería curva. El vehículo está estacionado en esta escena. Dentro del ZIP se puede abrir `propietario/Bajamar_Visor_0.50.0.html` para explorar el modelo y la luz. El acceso a la partida multijugador sigue siendo por invitación.

[Colocar modelos en Studio, llevar la experiencia a MUNDO y explorar Bajamar](docs/BAJAMAR_050.md)

## Asistente privado de desarrollo · 0.49.0

**Mundo IA** procesa un plan de tareas con un modelo de programación que reside en el equipo del propietario. Cada tarea trabaja sobre el último cambio aceptado en una rama local. La bitácora y los respaldos permiten recuperar la cola, el código y los intentos interrumpidos. El asistente se distribuye como una herramienta del propietario junto a las fuentes del motor. [Abrir el agente y recuperar una sesión](docs/MUNDO_IA_049.md)

## Elegir desde dónde sale el turismo · 0.48.0

MUNDO Studio guarda la posición y el rumbo del turismo en el mundo. La práctica del **Andén** utiliza esa parrilla para salir hacia la primera puerta de la Lonja. Se puede conducir en solitario o llevar a un pasajero en la misma sala. [Jugar desde el Andén](https://mundo-lonja-salida-lanzada.kyjhv6fcgk.chatgpt.site/anden/) · [Colocar la parrilla en Studio](docs/PARRILLA_048.md)

## Compartir el turismo de la Lonja · 0.47.0

En la portada de la partida privada, **Crear sala para dos** abre el asiento del conductor. Desde el panel de la sala puedes copiar la invitación del pasajero. Los dos ven el mismo turismo, la puerta alcanzada y el tiempo de la vuelta. Sigue disponible **Jugar** para la práctica individual. Al seleccionar la revisión original de la avenida en su proyecto editable, Studio también ofrece abrir la partida alojada. [Entrar y administrar las plazas](docs/PARTIDA_047.md)

## Conducir la práctica de salida lanzada · 0.46.0

En **Avenida de la Lonja** tomas el volante diez metros antes de la salida. Al cruzar el primer arco empieza la vuelta. La dirección asistida sigue las curvas mientras mantienes el acelerador. Puedes girar tú, frenar, dar marcha atrás y comparar la siguiente vuelta con tu marca. La práctica en línea tiene una plaza. MUNDO Studio y el anfitrión también admiten esta modalidad en sus propias publicaciones. [Abrir la partida y consultar los controles](docs/SALIDA_046.md) · [Publicación y proyecto de Studio](examples/primera-partida/Practica_Lanzada_Avenida.md)

## Comparar vueltas y practicar un tramo · 0.45.0

El servidor marca el paso del turismo por cada puerta. El marcador de los dos ocupantes muestra el parcial y la diferencia frente a la mejor vuelta disponible al arrancar. El anfitrión puede exportar las vueltas y abrirlas en Studio para localizar un tramo, consultar su terreno o preparar una sala de práctica. Dentro del ZIP, **Practica_4-6_y_Plaza_Brisa.mproject** contiene las tres últimas puertas de Avenida de la Lonja y el portal de regreso. [Guía de tiempos y práctica](docs/PARCIALES_045.md) · [Proyecto de ejemplo](examples/primera-partida/Practica_4-6_Avenida_de_la_Lonja.md)

## Conducir por una esquina y editar el recorrido · 0.44.0

Al cruzar una esquina con el turismo, MUNDO puede reutilizar los documentos de terreno descargados antes de llegar al primer barrio y guardar el resto para el destino. Studio permite comparar el salto directo y los dos caminos posibles por perfil, consultar qué bytes llegaron a usarse durante una partida y añadir una puerta al tramo. El proyecto privado **Avenida de la Lonja** incluye seis puertas, una avenida diagonal y el portal a Plaza Brisa. [Guía de la avenida](examples/primera-partida/Avenida_de_la_Lonja.md) · [Uso, formatos y pendientes](docs/DIAGONAL_044.md)

## Ver qué terreno se aprovechó en un cruce · 0.43.0

El anfitrión puede guardar un registro privado de las ofertas de precarga del turismo. MUNDO registra qué archivos verificó cada plaza y cuáles llegaron a instalarse en el terreno jugable. Studio abre el registro local, compara los cruces con la previsión de la misma publicación y permite contrastar PC y móvil en un mismo borde. Una oferta puede quedar sin informe del cliente si la conexión se pierde.

[Qué registra cada contador y cómo abrirlo en Studio](docs/REGISTRO_043.md)

## Anticipar el terreno del turismo · 0.42.0

Cuando un conductor o un pasajero se aproxima al borde de un barrio, su cliente puede empezar a descargar las celdas que necesitará después. La sala calcula el próximo cruce con la posición, el rumbo y la velocidad del turismo. En Studio se puede elegir un tramo entre dos paradas, moverse hasta un cruce y comparar las celdas y los bytes previstos para móvil y PC. El comparador del circuito lleva directamente al cruce examinado con más bytes pendientes para cada perfil.

[Precarga durante la partida, inspector de Studio y trabajo pendiente](docs/ANTICIPACION_042.md)

## Entrar y conducir con terreno descargado por sectores · 0.41.0

En una publicación que admite sectores, MUNDO puede entrar con el terreno de aparición y la posición confirmada por la sala. Cuando el jugador avanza, el cliente pide las familias de piezas que faltan alrededor de su nueva posición. Un turismo compartido respeta el terreno confirmado por sus dos ocupantes. En Studio se pueden comparar dos paradas por perfil, y en el mapa local del anfitrión se puede consultar el límite confirmado de cada jugador. La implementación abarca el servidor y los clientes web, Windows, Android e iOS. La validación en partida queda pendiente.

[Funcionamiento, límites y siguiente paso](docs/SECTORES_041.md)

## Conducir por los cuatro barrios · 0.40.0

MUNDO puede activar y retirar familias de piezas con sus colisiones mientras se recorre una publicación en línea. El punto de referencia es la posición que confirma la sala. En Studio se puede comparar cuántas entidades quedarían activas si un jugador se detiene en cada puerta. El panel local del anfitrión muestra el avance de los dos ocupantes y el turismo. La nueva vuelta tiene nueve puertas y conserva el portal a Plaza Brisa. [Guía del recorrido](examples/primera-partida/Ruta_de_los_Cuatro_Barrios.md) · [Alcance y pendientes](docs/RECORRIDO_040.md)

## Llegada al Distrito del Taller · 0.39.0

La sala puede enviar primero la geometría y las colisiones cercanas a cada jugador. MUNDO muestra esa zona durante la descarga. Caminar, conducir y cruzar portales requieren la revisión completa y el estado del servidor. El **Distrito del Taller** añade cuatro barrios conectados a la pista. Studio puede abrirlo como proyecto junto a Plaza Brisa. [Guía del distrito](examples/primera-partida/Distrito_del_Taller.md) · [Alcance de la entrega](docs/ENTRADA_039.md)

## Continuar una partida del taller · 0.38.0

Una revisión del taller puede recuperar el turismo y una vuelta interrumpida al abrirla de nuevo en el mismo anfitrión. El panel identifica la copia local y permite entregar invitaciones nuevas por plaza. Los reproductores de Windows, Android, iOS y web pueden reanudar por partes una descarga del mundo si se interrumpe la conexión. [Alcance, controles y límites de la entrega](docs/CONTINUIDAD_038.md)

## Circuito compartido · 0.37.0

La pista del taller ya tiene puertas que se editan en Studio. El servidor calcula el paso del turismo por las tres puertas y comparte el resultado con ambos ocupantes. El proyecto **examples/primera-partida/Circuito_en_linea.mproject** abre la ruta desde Plaza Brisa. La publicación **examples/primera-partida/Pista_compartida_v2.mroom** abre directamente la pista con el mismo turismo y la misma marca local.

El hito incluye las fuentes de los cuatro reproductores y el panel del anfitrión. La compilación y la ejecución permanecen aplazadas. [Recorrido, reglas y 30 pasos de código](docs/CIRCUITO_037.md)

## Partida exclusivamente en línea · 0.36.0

La entrada de MUNDO para Windows, Android, iOS y web requiere una invitación y una actualización del servidor. Studio prepara la escena en el panel local del anfitrión. El anfitrión escoge la red y entrega una invitación a cada jugador. Una sala puede anunciar un dominio HTTPS configurado por su propietario. El motor conserva perfiles gráficos independientes, resolución opcional hasta 8K y límite de FPS configurable dentro de la partida. [Recorrido de Studio al servidor, configuración y fuentes](docs/SALA_Y_PERFILES_036.md)

La 0.36.0 estableció el recorrido en línea y dejó la edición de puertas para la 0.37.0. Los experimentos visuales y los recorridos individuales anteriores se conservan en el archivo histórico.

<details>
<summary>Entregas anteriores y documentación histórica hasta la 0.35.0</summary>

## Bajamar · 0.35.0

Al abrir **Bajamar**, Inés aparece frente al muelle. En PC se camina con WASD o con las flechas. En móvil se usa la palanca izquierda. Arrastra la calle para girar la cámara. **Dar un paseo** hace una ida y una vuelta, y **Cámara** recorre el perfil, el primer plano y la espalda. Dentro de **Ajustes** se eligen la resolución y la distancia. [Jugar en privado](https://mundo-darsena-azul.kyjhv6fcgk.chatgpt.site/)

El barrio, el carro estacionado e Inés son modelos tridimensionales originales. El HTML autónomo y el video de 11 segundos están en `propietario/` dentro del ZIP. El historial completo está en `historial/Mundo_Engie.bundle`. La prueba es de un jugador. La meta gráfica del propietario es el realismo reconocible de un videojuego urbano en tercera persona.

## Dársena Azul · 0.34.0

Inés camina por un muelle mojado y regresa con **Ida y vuelta**. **Ver rostro** cambia el encuadre. Los controles de pantalla y las teclas W y S permiten moverla directamente. El menú de resolución está dentro de la partida. [Abrir el estudio anterior](https://mundo-darsena-azul.kyjhv6fcgk.chatgpt.site/archivo-034/)

En el ZIP tienes la copia autónoma `propietario/Darsena_Azul_Privada.html`, el MP4 y el historial recuperable. El estudio visual combina un escenario fotográfico con un personaje frontal articulado en 2.5D. Los archivos maestros y la procedencia quedan en `authoring/darsena-azul`. El recorrido se comprobó en navegador de escritorio. Queda pendiente validar un teléfono físico. La resolución de dibujo opcional llega a 8K. Las texturas tienen las dimensiones originales documentadas en el estudio.

## Jugar desde el móvil · 0.33.1

Abre el enlace privado de **Ruta del taller** que acompaña la entrega. Si el navegador pide iniciar sesión, utiliza la cuenta de ChatGPT del propietario. Toca **Jugar** para entrar en Plaza Brisa. El primer objetivo es cruzar el arco turquesa a pie. [Abrir Ruta del taller](https://mundo-ruta-del-taller-privada.kyjhv6fcgk.chatgpt.site)

La copia local está en `local/MUNDO_Primera_Partida_Ruta_del_Taller_0.33.1.html`. Al abrirla en un navegador compatible, el juego y el circuito viajan dentro del archivo. Una vista previa que bloquea los scripts muestra **Abrir la partida privada**. Ese enlace también figura en el respaldo TXT independiente. La copia inicial de la 0.33.0 está en Mundo_Engie_0.33.0_Privado.zip y en este ZIP bajo su nombre original.

## Primera partida privada · 0.33.0

Abre `local/MUNDO_Primera_Partida_Ruta_del_Taller_0.33.0.html` en un navegador con JavaScript y pulsa **Jugar**. El archivo contiene la partida completa. Camina hasta el arco turquesa de Plaza Brisa, sube al turismo y cruza las puertas ámbar, azul y lima en orden. Frena, baja y vuelve a pie por el arco coral. Al terminar verás el tiempo de la vuelta y podrás jugar de nuevo. En PC usa WASD o las flechas para moverte, E para subir o bajar y espacio para frenar. En móvil usa los controles de pantalla y arrastra para mirar.

La geometría de esa misma pista está en `examples/primera-partida/Circuito_del_taller.mproject`. Puedes abrirla en Studio para mover piezas o en el panel del anfitrión para preparar una sala. El contador de puertas y el cronómetro pertenecen al juego temporal de un jugador. El visor de sala recibe las posiciones y el turismo desde el anfitrión.

El anfitrión ahora admite proyectos con varios mundos. Cuando un jugador a pie cruza un portal, cada plaza ocupada prepara el destino. El anfitrión cambia de mundo al recibir sus confirmaciones. Si alguna plaza rechaza la carga o vence el plazo, la partida continúa en el origen. El flujo está integrado en las fuentes de servidor, web, Windows, Android e iOS. El recorrido del juego temporal se completó en una simulación local de JavaScript. La presentación en pantalla, la sala en red y las aplicaciones nativas siguen pendientes de ejecución.

## Ruta del taller · 0.32.0

El ZIP incluye un proyecto de bloques con dos mundos y el turismo del taller. Abre `local/MUNDO_Studio.html`, elige **Proyecto de juego → Abrir proyecto** y selecciona `examples/Ruta_del_Taller.mproject`. **Jugar proyecto en MUNDO** abre una copia del proyecto en otra ventana. También puedes abrir el mismo archivo desde **Abrir mundo** en `local/MUNDO.html`.

La partida empieza en Plaza Brisa. La baldosa bajo el arco turquesa lleva a la pista. El turismo está junto a la entrada de la pista y el arco coral lleva de vuelta a la plaza al cruzarlo a pie.

Para crear tu propia ruta, elige **Colocar baldosa en el suelo** y toca la cara superior de un bloque. Añade ese borrador al proyecto o sustituye su copia. Selecciona el mundo de origen, la baldosa y el destino. **Guardar destino** prepara el enlace y **Guardar proyecto** escribe el archivo. Cada dirección usa una baldosa propia. El editor anuncia cuántos enlaces se retiran al eliminar un mundo.

La ruta está implementada en los cuatro reproductores. Se empaquetaron las páginas web y las fuentes nativas. Las compilaciones, la ejecución del recorrido y las mediciones quedan pendientes por indicación del propietario.

## Volver al punto de encuentro · 0.30.0

En una sala privada con un encuentro publicado, un jugador a pie puede confirmar el regreso desde **Sala → Volver al punto de encuentro** o **F7** en Windows. En Android e iOS puede pulsar **Encuentro** en la partida. En el navegador, usa el botón de regreso que aparece en la partida y confirma en el diálogo. El anfitrión busca un lugar libre cerca del punto. Si no lo encuentra, el jugador conserva su posición. Quien viaja en el turismo debe bajar primero.

Las versiones antiguas de la sala y las publicaciones con aparición automática conservan su forma de entrada. La compilación y la partida real entre dispositivos están pendientes de autorización.

## Complementos privados de Studio

En el editor, elige un turismo en **Publicaciones privadas** y pulsa **Encuentro junto al turismo**. Studio calcula un punto al lado del conductor y comprueba dos plazas. Puedes deshacer la asignación completa en un paso. El taller usa el mismo complemento para preparar la pista que se abre en MUNDO. Para añadir otra herramienta local al catálogo, consulta la sección de complementos privados en [Dependencias](docs/DEPENDENCIAS.md).

## Guardar un juego con varios mundos

En **Proyecto de juego**, pon nombre a tu juego y pulsa **Añadir borrador** o **Añadir publicación elegida** por cada mundo que quieras incluir. Elige uno y pulsa **Hacer inicial**. Para modificar una copia que ya está en la colección, usa **Editar mundo elegido** y después **Sustituir con el borrador**. **Guardar proyecto** descarga el archivo .mproject con los mundos incluidos.

Los cuatro reproductores tienen una ruta en código para abrir el mismo proyecto de hasta 32 mundos y 64 MiB. Al entrar se carga el mundo inicial, con el turismo y el encuentro que guardó Studio. Para cambiar de mundo en una partida local con varios destinos, baja del carro y elige una entrada. En Windows se usa **Mundo → Mundos del proyecto**. En Android e iOS se usa **Abrir**. En la web se usa **Ajustes → Mundos del proyecto**. Cada visita empieza en la posición de entrada del destino. En móvil, la reapertura de la última partida recupera el mundo visitado y su posición guardada cuando corresponden al mismo proyecto.

En **Proyecto de juego**, **Compartir proyecto…** entrega el archivo al selector del sistema si el navegador admite ese tipo de archivo. **Guardar proyecto** permite descargarlo y abrirlo después desde MUNDO. La entrega reúne las fuentes privadas del chat original y su continuación. El origen del borrador web y del prototipo P83 figura en [Procedencia](docs/PROCEDENCIA.md). El ZIP incluye también las fuentes históricas P83, y el TXT independiente conserva ambos registros de conversación disponibles. La 0.31.0 se entrega en código. La compilación, la ejecución de una partida y las mediciones siguen aplazadas.

## Elegir dónde empieza la partida · 0.29.0

Abre **Publicaciones privadas → Punto de encuentro** en el editor de mundos. Pulsa **Marcar sobre el suelo** y toca una plataforma, o escribe sus coordenadas X, Y y Z en metros. Studio muestra la plaza 1 en turquesa y la 2 en naranja. Si falta suelo o altura para alguno de los jugadores, el editor explica el problema antes de publicar.

Elige una plaza y usa **Recorrer en MUNDO** para inspeccionar la llegada en el borrador. También puedes elegir una plaza para **Jugar esta versión en MUNDO** desde una publicación guardada. Para invitar a los dos jugadores, exporta el archivo **.mroom** y prepáralo en el panel del anfitrión. Si más tarde cambias el punto, las revisiones anteriores conservan el suyo.

En el **Taller de vehículos**, activa **Reunir a los jugadores junto al turismo** antes de usar **Conducir en MUNDO** o **Preparar sala privada**. El taller toma como referencia la puerta del conductor del carro que acabas de diseñar. La descarga **Guardar pista con el carro** conserva la pista editable en .mworld.

## Encontrarse en el turismo del taller

La sala de la 0.28.0 cuenta las plazas que ya informan que han cargado la revisión. Los jugadores a pie ven una distancia aproximada al carro y una indicación relativa a su cámara, por ejemplo «20 m · a la derecha». En Windows se muestra en el título de la ventana. En móvil y web se muestra en la interfaz de la partida. La guía sigue al vehículo si otro jugador lo mueve.

## Invitar por QR en Android e iOS · 0.28.0

En el panel de una sala de red local, pulsa **Mostrar QR** en la plaza de quien va a entrar. En MUNDO para Android o iPhone abre **Sala → Escanear QR**, apunta al código y confirma la dirección del anfitrión. El código contiene la misma invitación individual que **Copiar invitación**. Este recorrido está integrado en las fuentes. La compilación y su uso con una cámara real siguen pendientes.

## Anfitrión de una partida privada · 0.26.0

El ZIP incorpora `Abrir_panel_del_anfitrion.cmd` para Windows con Node.js 22 o posterior. Abre el panel en el navegador del anfitrión. También puedes soltar sobre ese archivo una publicación .mroom de Studio. En otros equipos con Node se inicia con `node server/host-panel.cjs`.

El panel permite preparar una publicación, identificar su revisión y su turismo, elegir la red de juego y abrir la sala. Cada jugador tiene un botón para copiar su propia invitación. En Android, el reproductor incorpora **Compartir → MUNDO** para un enlace recibido como texto y pide confirmar la dirección antes de entrar. Las instrucciones de red y gestión de plazas están en [Salas privadas](docs/SALAS.md). La 0.26.0 se entrega en código fuente. Su ejecución en navegador, Windows, Android e iOS queda pendiente.

## Comparar bloques y realismo en privado

Abre `propietario/Inspector_de_apariencias.html` después de extraer el ZIP. El poste de referencia se abre en bloques. Pulsa **Realismo privado** para comparar sus dos modelos desde la misma cámara. Puedes girar la pieza con el ratón, con el dedo o con las flechas. **Abrir mundo** permite inspeccionar un archivo de Studio y **Siguiente pieza** recorre sus objetos. Cada mundo se abre en bloques. La clave visual 41001 tiene tres niveles de detalle por estilo. Las piezas sin variante conservan su aspecto.

El inspector contiene el recurso privado y debe permanecer con el propietario. La carpeta `local/` contiene las entradas para jugador y creadores. La elección del inspector dura solo durante la vista. La imagen `propietario/Comparacion_del_poste.png` muestra ambas mallas con la misma cámara y los shaders del motor, rasterizadas por software.

### Conducir el turismo del taller

En el inspector, pulsa **Abrir pista del taller** y **Conducir**. Puedes alternar **Realismo privado** mientras aceleras, giras o frenas. WASD y las flechas controlan el carro, la barra espaciadora frena y los botones táctiles admiten giro y aceleración simultáneos. **Dejar de conducir** devuelve el control a la inspección. La variante conserva la pintura elegida en el taller. Usa **Guardar pista con el carro** en el taller y **Abrir mundo** en el inspector para conducir uno personalizado.

Las 18 piezas del turismo usan ocho geometrías privadas reutilizables, cada una con tres niveles de detalle. El controlador mantiene la física de la partida y calcula el giro visual de las ruedas con la distancia recorrida. Las piezas usan sus formas públicas en el reproductor normal. El modelo original de autoría está en `authoring/touring-car/master.py`. Para regenerar su catálogo usa `python3 -B authoring/touring-car/master.py`.

`examples/Pista_Turismo.mworld` es el archivo exportado por el taller, jugable en MUNDO e inspeccionable por el propietario. `propietario/Comparacion_del_turismo.png` muestra las dos apariencias dibujadas por software con la misma cámara. La conducción de esta vista utiliza WebGL 2. Los clientes nativos incluyen código para comparar las apariencias. La comprobación visual en sus pantallas sigue pendiente.

Para volver a generar el inspector, ejecuta `python3 tools/package_owner.py ../edicion-propietario`. La prueba `node --test tests/owner-inspector.cjs` empaqueta las cuatro páginas en un directorio temporal y recorre el cambio de estilo y la apertura de mundos.

## Turismo en el reproductor nativo de Windows

La variante de propietario abre la pista del taller en bloques. **E** permite subir o bajar, **WASD** conduce, **Espacio** frena y **F4** cambia la apariencia del turismo durante la partida. **Ctrl+O** permite abrir otra pista guardada por Studio. Al cargar un mundo se vuelve al estilo de bloques. El menú **Propietario** permite regresar a la pista inicial.

El ZIP incluye el código fuente de Windows. La compilación del núcleo y las pruebas de conducción se ejecutaron en Linux. Queda pendiente ejecutar el reproductor con Filament, el SDK y la pantalla de un equipo Windows. La edición web del inspector sigue disponible en `propietario/`. Las opciones para compilar las dos ediciones nativas en directorios independientes están en `docs/DESARROLLO.md`.

## Turismo en Android · 0.19.0

La edición de propietario abre la pista del taller en bloques en su primera instalación. En **Carro** puedes subir al turismo, escoger la apariencia o volver a cargar la pista. Arrastra en la mitad izquierda para acelerar, dar marcha atrás y girar. Arrastra en la derecha para mirar. Puedes mantener **Frenar** con otro dedo y volver a acelerar al soltarlo. **Abrir** carga la pista que guardaste desde Studio con tu pintura y dimensiones.

El ZIP entrega el código Android ARM64 y el verificador del contenido del APK. Las sesiones pública y privada se probaron en Linux con la lógica C++ de la aplicación y una pantalla de prueba. La compilación e instalación en Android, la entrada táctil física y el renderizado de Filament quedan pendientes. Para preparar y comprobar ambas ediciones consulta `docs/MOVIL.md`.

### Verificar la partida en Android

Al conducir, un indicador sobre **Frenar** muestra la velocidad del turismo en km/h. Desaparece al bajar. El proyecto incorpora una prueba Android que importa una pista de Studio, sube al carro desde el menú e inyecta dos contactos de pantalla para acelerar, frenar y volver a acelerar. En la edición del propietario, la prueba compara píxeles de la superficie de juego al cambiar el modelo y comprueba la vuelta a los bloques.

Con el entorno Android listo, `python3 tools/run_android_tour.py --build-only` construye e inspecciona las dos ediciones. Para ejecutar el recorrido en un Android ARM64, usa `--serial SERIAL_ADB` en su lugar. El programa instala las copias de validación con sus propios identificadores y conserva los datos del jugador habitual. Los requisitos y el alcance de los resultados figuran en `docs/MOVIL.md`.

## Turismo en iOS · 0.21.0

El cliente para iPhone y iPad tiene dos ediciones. La pública abre Plaza Brisa en una instalación nueva. La del propietario abre la pista del taller en bloques y añade un botón para alternar la apariencia del turismo en plena marcha. Cada edición guarda sus ajustes y su partida bajo un identificador de aplicación propio.

En el taller, usa **Guardar pista con el carro**. En el reproductor, usa **Abrir** para importar ese archivo. **Carro** permite subir junto a la puerta. Mantén un dedo en la mitad izquierda para acelerar o girar y pulsa **Frenar** con otro. El indicador muestra la velocidad simulada en km/h. En la edición del propietario, el botón de apariencia cambia las mallas de las 18 piezas del turismo. Al abrir otro mundo, vuelve el estilo de bloques.

La prueba en Linux exportó un turismo azul desde el código de Studio, lo importó en la sesión C++ y comprobó sus dimensiones, pintura, controles y reapertura. Se utilizó una superficie de dibujo de prueba. El ZIP contiene el proyecto iOS en código fuente. La compilación con Xcode, la imagen de Metal y los controles en pantalla siguen pendientes. Los comandos de compilación e inspección están en `docs/MOVIL.md`.

## Abrir la edición local

Descomprime el ZIP completo. La carpeta `local/` contiene tres HTML autocontenidos que se abren en un navegador moderno con JavaScript. Cada archivo reúne su interfaz, sus scripts y los recursos de bloques que utiliza. Las restricciones del navegador pueden afectar la apertura de archivos y ventanas, en particular desde un visor de documentos móvil.

| Archivo del ZIP | Qué puedes hacer |
| --- | --- |
| `local/MUNDO_Studio.html` | Editar Plaza Brisa, crear un mundo vacío, añadir piezas, moverlas, escalarlas, girarlas y cambiar su color. La búsqueda y la jerarquía permiten seleccionar una pieza. Guardar crea un archivo de mundo. |
| `local/Taller_de_carros.html` | Ajustar el tamaño, la pintura y las ruedas de un carro de bloques. Guardar el vehículo crea un modelo de 18 piezas que puedes colocar con **Insertar modelo** en Studio. |
| `local/MUNDO.html` | Recorrer Plaza Brisa o abrir otro mundo. En PC se camina con WASD o flechas y se salta con la barra espaciadora. En pantallas táctiles aparecen controles. Arrastra para mirar. Abre **Ajustes** dentro de la partida para cambiar resolución, detalle y FPS. |
| `examples/Plaza_Brisa.mworld` | Copia independiente del mundo inicial, con 180 entidades y su fuente de autoría en `authoring/plaza-brisa/`. |

Desde el editor, **Recorrer en MUNDO** abre la aplicación de juego con una copia del mundo tal como está en ese momento. Si el navegador bloquea la nueva ventana o aísla sus archivos locales, guarda el `.mworld` y usa **Abrir mundo** dentro de MUNDO. Los clientes nativos de Android y iOS se incluyen como fuente. El empaquetado para instalación y las comprobaciones en equipos reales siguen pendientes.

## Salas privadas en Studio y MUNDO · 0.25.0

En **Publicaciones privadas**, elige una revisión guardada y pulsa **Exportar sala privada (.mroom)**. El archivo contiene el título, el número de revisión y los bytes del mundo que publicaste. Puedes continuar editando el borrador mientras esa sala conserva su revisión. El servidor local admite este nuevo paquete y los archivos `.mworld` anteriores.

Con Node.js 22 o posterior, la orden de uso prevista para el anfitrión es:

```sh
node server/room.cjs "/ruta/Mi_mundo-v1.mroom"
```

El anfitrión recibe dos invitaciones individuales. En Windows se pegan en **Sala → Entrar con invitación** (F6). En Android e iOS se usa **Sala**. En el navegador se abre el enlace de un asiento. Los clientes nativos incluyen código para caminar, correr, saltar y ver al compañero en la revisión compartida. El servidor calcula el movimiento y las colisiones. Al salir desde un reproductor nativo se recupera la partida individual que quedó en el dispositivo.

En la terminal del servidor, **estado** enumera los asientos. **suspender** cierra las nuevas entradas, **reanudar** las abre, **expulsar 2** libera ese asiento e invalida su enlace, e **invitar 2** emite uno nuevo. El anfitrión puede administrar el otro asiento con el número 1. Para conectar equipos distintos se usa una dirección IPv4 privada y un certificado HTTPS de confianza. Las opciones de red por plataforma y el alcance del protocolo figuran en [Salas privadas](docs/SALAS.md).

### Elegir el turismo de una publicación

Abre el mundo en el editor de Studio. En **Publicaciones privadas → Turismo compartido del borrador** puedes elegir un carro por nombre e ID. **Localizar turismo en la escena** centra la vista sobre la elección. Publica el borrador y exporta la sala desde la revisión elegida. Cambiar solo el turismo crea otra revisión. Deshacer y Rehacer recuperan la elección anterior. Si eliminas el turismo designado, el editor te pide elegir otro o volver a **Automático** antes de publicar.

El archivo `.mroom` guarda la revisión con la elección. **Abrir** en Studio recupera ambos como borrador. **Guardar** descarga la geometría editable en `.mworld`. Los mapas y salas automáticos conservan el criterio del ID de raíz más bajo. El anfitrión 0.25.0 admite los paquetes anteriores y los nuevos.

### Compartir el turismo del taller

En **Taller de carros**, elige la pintura y las dimensiones. **Preparar sala privada** guarda una revisión de la pista y habilita **Descargar sala (.mroom)**. El anfitrión abre ese archivo con el servidor local. También puedes preparar un mundo más grande con **Guardar pista con el carro**, editarlo en Studio y exportar una de sus publicaciones. El editor indica el nombre y el ID del turismo que corresponde a la revisión elegida.

Los dos invitados pueden viajar en el mismo turismo. Con el carro detenido, uno solicita el volante y el otro la plaza de pasajero. Ambos pueden mover su propia cámara. En Windows y web, **E** pide el volante libre, sube al lado del conductor si ya está ocupado, o baja si ya estás dentro. **G** permite subir de pasajero en un carro vacío o tomar el volante si estás de pasajero y quedó libre. En Android e iOS se elige la acción en **Plazas**. Si el conductor sale de la sala, el carro se estaciona y el pasajero conserva su plaza. El anfitrión puede consultar ambas en la consola. Cada cliente dibuja el carro usando las piezas y la pintura del mundo creado en Studio.

El propietario solicita completar su motor de juegos privado en un mes desde el 22 de noviembre de 2026 y dedicar una etapa posterior a las correcciones. La primera partida entre PC y móvil es un hito intermedio. Las fuentes integran el panel del anfitrión, las invitaciones y el vehículo compartido. La compilación y la ejecución en equipos siguen pendientes. El plazo expresa la prioridad del propietario y carece de una previsión técnica validada.

## Publicaciones privadas del editor

**Publicar borrador en este dispositivo** conserva una copia de la escena en el navegador. El nombre del mundo agrupa sus versiones. Cambiarlo empieza una serie distinta. Publicar dos veces el mismo contenido con el mismo nombre conserva una sola revisión consecutiva. Puedes continuar editando y seleccionar una versión anterior para jugarla, descargar su .mworld o recuperarla como borrador. La recuperación se puede deshacer. Descarga las revisiones que quieras conservar fuera del perfil del navegador: borrar sus datos también borra el catálogo local.

La publicación registra los metadatos y la escena en una transacción IndexedDB y comprueba el SHA-256 antes de abrir la copia. El archivo exportado contiene los nodos y las claves de apariencia del formato .mworld. Los modelos maestros del propietario permanecen en el proyecto privado.

## Partidas por zonas

En el editor web, **Exportar partida por zonas** genera un archivo local `.mzones`. En el reproductor web, usa **Abrir mundo** para elegirlo. Conserva el `.mworld` como original editable de Studio.

El paquete contiene un índice y bloques independientes. MUNDO lee la parte permanente y solicita las zonas cercanas al peatón o al carro mediante rangos del archivo local. Las celdas miden 64 unidades por lado. El perfil móvil abarca hasta 3 × 3 celdas y el de PC hasta 5 × 5. El cambio de zona retiene las celdas comunes y espera las nuevas antes de reanudar el movimiento y las colisiones. El jugador conserva su posición, velocidad y cámara.

Cada grupo raíz se conserva entero. Un grupo que cruza un límite, el grupo de aparición y los carros del taller permanecen cargados. Para que un mapa grande se pueda descargar por partes, organiza los barrios como grupos raíz separados en Studio. Una escena agrupada bajo una única raíz que abarca varios barrios permanece residente. El reproductor nativo de Windows incorpora la apertura de .mzones con Ctrl+O y desde la línea de comandos. El núcleo lee el directorio, conserva la parte permanente y reutiliza las zonas comunes al cruzar celdas. Android e iOS aceptan el mismo paquete con el selector de documentos. Los tres clientes nativos preparan las nuevas zonas y sus colisiones en segundo plano. Se mantiene visible la última escena mientras el movimiento espera. En móvil la partida se importa a almacenamiento privado para poder recuperarla al reabrir MUNDO. Las mediciones y la comprobación en equipos reales quedan pendientes.

## Conducir el carro del taller

En el taller, **Conducir en MUNDO** abre una pista con el carro que acabas de diseñar. **Guardar pista con el carro** permite llevar el mismo circuito al editor o al reproductor. En la edición web de MUNDO, acércate al carro y pulsa **Subir al carro** o **E**. Acelera con W, gira con A/D y frena con Espacio. S frena y después activa la marcha atrás. En pantalla táctil, utiliza las flechas y **Frenar**. Detén el carro y pulsa **Bajar del carro** para volver a caminar.

Para llevar la pista al reproductor nativo, usa **Guardar pista con el carro** y abre el archivo desde MUNDO. En Windows, **E** cambia entre peatón y conductor, WASD conduce, Espacio frena y F3 cambia la vista. En Android e iOS, toca **Carro** para subir o bajar. Arrastra el lado izquierdo para acelerar, girar o dar marcha atrás. Mantén **Frenar** con otro dedo para detener el vehículo sin perder el gesto de dirección. En modo peatón, ese botón vuelve a **Saltar**.

El controlador C++ trabaja con pisos planos y carros de bloques del taller. Admite traslación y giro horizontal del grupo que contiene el carro, con escala horizontal uniforme en los grupos superiores. Al salir, la posición del carro se conserva durante la sesión. Al reabrir el archivo, los carros vuelven al diseño guardado en Studio. Si el móvil se cierra durante la conducción, el punto de recuperación es la posición del peatón al subir. La comprobación en hardware sigue pendiente.

## Avatar de bloques

La partida empieza en tercera persona. El avatar original mueve las piernas y los brazos según la distancia recorrida y recoge las piernas al saltar. En Windows, F3 cambia entre primera y tercera persona. En Android, iOS y el reproductor web 3D, usa **Cámara**. La vista adapta su distancia a las paredes. En el ZIP, la edición local está en `local/MUNDO.html`. [Animación del jugador](docs/AVATAR.md)

## MUNDO móvil

Al volver al juego, los clientes móviles recuperan el último mundo importado y la posición guardada. En una instalación nueva cargan Plaza Brisa y aceptan un archivo .mworld desde el selector del sistema. Comparten el controlador nativo de C++ con Windows. Los controles, dependencias y alcance de esta entrega están en [MUNDO móvil](docs/MOVIL.md).

## Motor y arte

- `include/mundo/` y `src/` contienen el núcleo C++20 y los adaptadores de renderizado Filament, físicas Jolt, reglas locales Luau y validación de arte firmado con Monocypher.
- `apps/windows/` contiene el primer reproductor nativo de escritorio en C++ y Win32. Abre Plaza Brisa o un archivo de Studio, usa Filament y el controlador de personaje del núcleo para caminar, correr y saltar. F2 alterna la cámara libre de inspección. El reproductor ofrece pantalla completa y permite ajustar el vídeo en la partida. La versión entregada es fuente. La construcción del ejecutable y del instalador está pendiente.
- La cámara nativa usa el tamaño proyectado de cada objeto para elegir su malla. La edición local usa WebGL 2, dibujo por instancias y una vista en planta 2D cuando el navegador no puede abrir la vista 3D.
- El perfil de vídeo de móvil y el de PC se guardan por separado. Se puede elegir una resolución interna de hasta 7680 × 4320 en horizontal o 4320 × 7680 en vertical, dentro de los límites de la pantalla, la GPU y el presupuesto. Cero desactiva el limitador interno de FPS. El navegador y el sistema operativo controlan la presentación.
- `authoring/street-post/vault/` guarda el maestro OpenUSD y las mallas de la versión realista del bolardo 41001. El bolardo es el primer objeto con arte completo en ambos estilos. Los HTML de juego y edición solo incorporan el catálogo de bloques. Este ZIP incluye el archivo privado de arte del propietario.
- `historial/Mundo_Engie.bundle` guarda el historial Git. Para restaurarlo desde la carpeta principal se puede usar `git clone historial/Mundo_Engie.bundle MundoEngie-trabajo`. Las ocho dependencias externas tienen revisiones fijas y se obtienen por módulo con `tools/sources.py`. Para volver a empaquetar los tres HTML desde las fuentes se usa Python 3.9 o posterior y `python3 tools/package_local.py local`.

Esta entrega contiene código fuente y una edición local. En 0.15.0 se comprobó la lógica de publicación con almacenamiento simulado y se compiló el lector C++ en Linux. El lector abrió una exportación de 181 entidades. Una comprobación adicional cargó y liberó una zona con su terreno en segundo plano. La interfaz Chromium, los clientes en hardware físico y las mediciones siguen pendientes. El informe registra las tareas abiertas y las condiciones de los plazos.

[Controlador nativo 0.5](docs/PERSONAJE.md) · [Estado y plazos de 0.4](docs/ESTADO_0.4.md) · [Arte y publicación](docs/ARTE_Y_CALIDAD.md) · [Perfiles de vídeo](docs/PERFILES.md) · [Desarrollo](docs/DESARROLLO.md) · [Formato de mundo](docs/FORMATO.md) · [Dependencias](docs/DEPENDENCIAS.md) · [Continuidad](docs/CONTINUIDAD.md)

</details>
