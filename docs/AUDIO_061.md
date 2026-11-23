# Música por mundo en proyectos privados

Mundo Engie 0.61.0 añade el formato `.mprojectmusic`. El archivo reúne la copia inmutable del proyecto para invitados, sus grabaciones cortas autorizadas cuando existen y las pistas largas que realmente referencia cada mundo.

## Recorrido

1. En MUNDO Studio importa una pista WAV desde **Audio → Música larga del mundo**.
2. Vincula la pista al mundo y elige reproducción única o en bucle.
3. Añade el mundo al proyecto. Cada mundo puede utilizar una pista distinta o compartir la misma identidad musical.
4. En **Proyecto**, usa **Exportar proyecto con audio**. Studio crea `.mprojectmusic` cuando encuentra música larga.
5. El panel del anfitrión verifica el proyecto completo antes de abrir la revisión.
6. MUNDO solicita el inventario de la revisión confirmada. Al aceptar un portal cancela la pista anterior y descarga únicamente la música del destino.

## Límites escritos

- Hasta 32 mundos por proyecto.
- Hasta 8 pistas largas distintas.
- Hasta 80 segmentos por pista.
- Hasta 128 MiB de música larga por proyecto.
- Segmentos PCM mono de 24 kHz y doce segundos como máximo.
- Ventana del reproductor limitada al segmento actual y al siguiente.

Los segmentos, el manifiesto, la pista y el proyecto se verifican antes de actualizar el catálogo privado de Studio. El servidor vuelve a comprobar las huellas y exige invitación, plaza, reserva y revisión activa.

## Demostración reproducible

`examples/audio/Ruta_musical_de_los_patios.mprojectmusic` contiene dos mundos conectados. El patio inicial y el jardín usan melodías procedurales originales distintas. Para reconstruirlo ejecuta:

```sh
node examples/audio/crear-ruta-musical.cjs
```

La comprobación automatizada cubre empaquetado, restauración en Studio, datos alterados, pistas faltantes o ajenas, autorización del servidor, cambio de revisión y descarga del primer segmento del destino.

## Continuación

`audio-04` requiere validar la salida física, pérdida de foco, suspensión, cambio de altavoz o auriculares y reconexión en Windows, Android e iOS. Estas comprobaciones dependen de los SDK y dispositivos objetivo.
