# Música larga segmentada · entrega 0.59.0

Esta entrega incorpora la ventana de reproducción de `audio-03` al mezclador C++, al DSP del navegador, a la salida Web Audio, al reproductor web y a la sesión nativa compartida por Windows, Android e iOS.

## Contrato de reproducción

- Cada pista tiene un identificador de sesión distinto de cero y una secuencia de índices de 32 bits.
- Cada segmento conserva su identidad de contenido y el decodificador nativo verifica su WAV canónico antes de entregarlo al mezclador.
- El mezclador mantiene como máximo dos segmentos. Uno se reproduce y el siguiente queda preparado.
- El índice esperado debe ser exacto. Se rechazan saltos, repeticiones, sesiones antiguas y datos posteriores al segmento final.
- La frontera entre dos segmentos consecutivos conserva el orden de las muestras.
- Si el siguiente segmento llega tarde, la reproducción espera en silencio sin descartar el índice pendiente.
- Una revisión nueva restablece la pista y rechaza los segmentos que terminen de llegar desde la revisión anterior.
- La pausa general congela la pista junto con las demás fuentes. El bus de música y el volumen general se aplican por muestra.

Los segmentos usan PCM mono de 24 kHz y 16 bits, con el mismo límite individual de 384.000 muestras que las grabaciones anteriores. La ventana máxima del mezclador es de dos segmentos decodificados. Las fuentes antiguas de ambiente, efectos, voces y clips conservan su formato.

## Comprobaciones locales

- Pruebas JavaScript del DSP, la salida, el reproductor y Studio. 29 aprobadas de 29 ejecutadas.
- Mezclador C++20 y sesión nativa con dispositivo simulado. Ambos aprobados.
- Comparación C++ y navegador. 720.896 muestras de canal idénticas, diferencia absoluta máxima cero.
- Sanitizadores AddressSanitizer y UndefinedBehaviorSanitizer aprobados con detección de fugas desactivada. LeakSanitizer no puede operar bajo el `ptrace` del entorno.
- Integridad de parches comprobada con `git diff --check`.

CMake no está instalado en este entorno. Las unidades nativas se compilaron directamente con `g++`. No se comprobó salida física en Windows, Android o iOS.

## Continuación de audio-03

El núcleo de reproducción segmentada queda escrito y verificado por software. Falta integrar en la publicación de Studio el manifiesto autorizado de la pista, ofrecer sus segmentos desde el servidor y mantener una precarga de dos elementos mediante la reserva y revisión de la sala. Esa continuación debe verificar que cada invitado recibe únicamente los segmentos de su mundo confirmado.

`audio-04` mantiene la validación de interrupciones, auriculares, altavoces y cambios de ruta en dispositivos físicos.
