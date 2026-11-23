# Audio del mundo · entrega 0.57.0

En MUNDO Studio, abre **Audio del mundo**. Puedes colocar una fuente de agua junto a una fuente de piedra, un motor dentro de un taller o una voz detrás de una puerta. El modo 3D usa la posición y la orientación del oyente. El modo 2D mantiene el sonido centrado aunque el jugador se aleje.

## Escuchar la plaza

1. Abre **Abrir panel del anfitrión** en el equipo que aloja la sala.
2. Selecciona `examples/audio/Plaza_del_carillon.mroomaudio`, prepara el archivo y abre la sala privada.
3. Entra en MUNDO con la invitación de esa plaza. Si el navegador lo solicita, pulsa **Activar audio**.
4. Desde el punto de llegada encontrarás agua a la izquierda, el motor del taller a la derecha y la campana cerca del arco. El viento de fondo está en 2D. Gira la cámara y acércate al arco para escuchar la diferencia.

Para comprobar un viaje, abre `examples/audio/Patios_del_carillon.mprojectaudio`, reúne a los dos jugadores y cruza el portal. Cada destino usa una campana original diferente. La grabación nueva se descarga cuando se confirma el cambio de mundo.

En el cliente Windows, **F8** abre el mezclador y **F9** alterna el silencio. Los clientes móviles incluyen controles para la misma mezcla y guardan sus propios ajustes. En el motor se puede pausar una sola fuente por identificador, conservar su punto de reproducción y seguir mezclando las demás.

La muestra estéreo que acompaña a la entrega dura doce segundos. Se generó por separado con el mezclador de MUNDO. El generador reproducible está en `examples/audio/render-demo.cjs`.

## Crear y publicar

El panel de Studio permite crear, colocar, copiar, editar y quitar fuentes, deshacer y rehacer cambios. La escucha individual permite ajustar un sonido. La escucha desde la cámara combina las fuentes de la escena. Hay ganancia general y controles para música, efectos, voces y ambiente. Cada emisor guarda posición, volumen, alcance, modo espacial, velocidad de reproducción y bucle o disparo. Una velocidad mayor eleva el tono y acorta la grabación.

La biblioteca del editor almacena grabaciones WAV en el navegador y reconoce la misma grabación por su contenido. Se aceptan archivos PCM enteros de 8, 16, 24 o 32 bits y flotantes de 32 bits, mono o estéreo, de 8 a 96 kHz. Para esta entrega se admite hasta 16 segundos por grabación. Studio las convierte a PCM mono de 24 kHz para situarlas en el espacio. Hay hasta 16 emisores por mundo y hasta 8 MiB de grabaciones por paquete. El emisor puede volver a utilizar una grabación incluida una sola vez.

| Lo que quieres compartir | Archivo y contenido |
|---|---|
| Un mundo con sonidos sintetizados | La revisión `.mroom` guarda los emisores. |
| Un mundo con tus grabaciones | La exportación `.mroomaudio` incluye los WAV usados por esa revisión. |
| Grabaciones y modelos de autor en una sala | En Studio, marca la opción de incluir modelos al exportar. El anfitrión decide si los comparte con la partida. |
| Un juego de varios mundos con grabaciones | En el panel de proyectos, autoriza los sonidos y exporta o prepara el `.mprojectaudio`. Incluye una copia para invitados de cada mundo y las grabaciones que referencian. |
| Un proyecto editable | El `.mproject` habitual conserva el contenido de autor y las referencias a grabaciones. Para trasladar las grabaciones a otro catálogo, conserva también el paquete con audio. |

En una partida, el anfitrión entrega sonidos a una plaza admitida y comprueba la revisión solicitada. Con portales, las grabaciones de destino pasan a estar disponibles al confirmarse el viaje. Cada cliente comprueba el SHA-256 completo del WAV antes de instalarlo. La descarga de grabaciones se realiza aparte de la de geometría. El catálogo local, otras grabaciones y el nombre original de los WAV quedan fuera de la respuesta de juego.

## Implementación y evidencia

El código de mezcla es propio. Los sonidos de viento, agua, motor y la campana de la plaza son originales. La importación PCM, el remuestreo, los contenedores y la mezcla usan código del proyecto. La salida web usa Web Audio. Windows usa waveOut, Android usa AAudio e iOS usa AudioQueue. Estos cambios no incorporan paquetes de audio externos ni pesos de inferencia. En un reproductor nativo, la obtención de audio usa el mismo transporte de sala autenticado que la partida.

Las pruebas publicadas cubren paridad de muestras entre C++ y JavaScript, panorama, atenuación, pausa, bucles y disparos, tasas de salida distintas, WAV rechazados, importación y recuperación de proyectos, consentimiento para mallas, dos plazas y cambios de mundo. Se ejecutaron Linux, HTTP local y PCM real. Se usaron adaptadores de salida para las interfaces de dispositivo y del navegador. El árbol incluye pruebas de navegador para un entorno que pueda iniciar Chromium. Los SDK de los tres destinos y sus dispositivos físicos quedan pendientes de validación.

## Continuación

Los primeros hitos del programa privado son `audio-01` (mezclar en el reproductor) y `audio-02` (crear y publicar desde Studio). La siguiente clave, `audio-03`, corresponde a música larga por segmentos, con memoria acotada y cancelación al cambiar de mundo. Después sigue la verificación de interrupciones y cambios de salida en dispositivos reales. El alcance general de MUNDO Engine sigue abierto.
