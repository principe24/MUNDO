# Transiciones del mezclador · entrega 0.58.0

Esta entrega añade automatización de ganancia al subsistema modular de audio existente. El volumen general y cada bus —ambiente, efectos, música y voces— pueden cambiar inmediatamente o recorrer una rampa lineal de hasta sesenta segundos. La rampa usa el reloj de muestras del mezclador, por lo que el resultado no depende del tamaño de los bloques que entregue el dispositivo.

En **MUNDO Studio → Audio del mundo → Niveles de escucha**, el control **Transición de niveles** elige entre cero y cinco segundos. Mientras se escucha una fuente o la mezcla guardada, mover un nivel aplica esa transición. Este ajuste pertenece a la escucha del editor y no modifica la publicación ni los ajustes personales del jugador.

El reproductor nativo dispone de `PlaybackAudio::transition_levels`. Una pausa congela la transición y la reanudación continúa desde la misma muestra. Cambiar de mundo conserva los niveles personales, mientras que las voces y grabaciones del mundo anterior siguen descartándose como en la entrega 0.57.0.

## Evidencia ejecutada

- El mezclador C++ se compiló directamente con GCC y superó escenas, continuidad, espacialización, pausas, clips y limitador.
- El mezclador JavaScript y Studio superaron 26 pruebas. Incluyen rampas por muestra, independencia del tamaño de bloque, reloj detenido durante la pausa, catálogo WAV, exportación y recuperación de salas.
- La comparación entre C++ y JavaScript verificó 720 896 muestras de canal con diferencia máxima cero.
- El ciclo del dispositivo nativo simulado comprobó apertura, pérdida de ruta, recuperación, buses, silencio y una transición que llega a silencio.

La compilación mediante CMake no se ejecutó porque ese programa no está instalado en este entorno. Se utilizó el compilador C++ disponible con los mismos archivos del núcleo necesarios para estas pruebas. No se verificaron altavoces, auriculares ni dispositivos físicos.

## Continuación

La clave siguiente sigue siendo `audio-03`. Debe incorporar música larga por segmentos, mantener una cola y memoria acotadas, cancelar descargas al cambiar de revisión y entregar únicamente segmentos autorizados. Después corresponde `audio-04`, que exige verificar interrupciones y cambios reales de salida en Windows, Android e iOS.
