# Música larga publicada por Studio · entrega 0.60.0

Esta entrega conecta el núcleo segmentado de la 0.59.0 con MUNDO Studio, el archivo privado de sala, el anfitrión y el reproductor web usado en PC y móvil.

## Recorrido implementado

1. Studio acepta WAV PCM mono o estéreo de 8 a 96 kHz y hasta 64 MiB o 16 minutos.
2. El importador mezcla los canales, remuestrea a PCM mono de 24 kHz y divide la pista en segmentos de 12 segundos. El último puede ser menor.
3. Cada segmento recibe una huella SHA-256. La lista ordenada recibe otra huella y un identificador de 64 bits distinto de cero.
4. El marcador `MUNDO/Music/v1` guarda el identificador, el nombre visible y la elección de repetir o terminar. No guarda rutas, nombres privados de archivo ni código ejecutable.
5. La exportación `.mroommusic` envuelve una sala `.mroom`, `.mroom3d` o `.mroomaudio` ya sellada y adjunta únicamente la pista vinculada.
6. El anfitrión vuelve a calcular las huellas y comprueba que el identificador corresponde al marcador del mundo antes de abrir la sala.
7. Un jugador admitido consulta el inventario con su revisión. Cada descarga exige su reserva, revisión, identificador de pista e índice exactos.
8. El reproductor verifica la huella del WAV antes de decodificarlo. Mantiene como máximo dos segmentos en el mezclador y solicita el siguiente cuando queda espacio.
9. Salir, perder la oferta o cambiar de revisión aborta la transferencia y cancela la sesión musical. Una pista configurada en bucle vuelve al índice cero después del segmento final.

El catálogo de Studio conserva hasta 16 pistas y 128 MiB por origen. El paquete de una sala admite hasta 80 segmentos y 48 MiB de música canónica. Los clips cortos, los modelos 3D y las salas históricas conservan sus formatos.

## Verificación local

- El paquete rechaza un segmento alterado, un inventario cuya identidad no coincide y datos sobrantes.
- El servidor rechaza otra plaza, una revisión antigua, un índice fuera del inventario y una pista ajena.
- Dos segmentos ocupan toda la ventana. El tercero solo se acepta después de liberar uno.
- La reproducción en bucle reinicia el índice y la salida de la sala cancela la sesión.
- Studio importa una pista de 25 segundos, crea tres segmentos, guarda sus ajustes, exporta `.mroommusic`, vuelve a abrirlo y restaura el catálogo privado.
- Las pruebas anteriores de audio corto, proyectos, anfitrión, reproductor, DSP y formatos permanecen activas.

Las comprobaciones son de software local. No acreditan escucha física, latencia, FPS ni compatibilidad en un dispositivo Windows, Android o iOS.

## Continuación

`audio-03` continúa con un contenedor de proyecto capaz de autorizar una pista distinta por cada mundo confirmado. La 0.60.0 bloquea la exportación de música larga dentro de `.mprojectaudio` para impedir una publicación silenciosa sin sus segmentos. Las salas individuales funcionan con `.mroommusic`.

Después corresponde `audio-04`, con interrupciones, suspensión, altavoz, auriculares y cambios reales de ruta de salida en dispositivos físicos.
