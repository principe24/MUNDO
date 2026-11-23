# Recuperación de la salida de audio nativa

Mundo Engie 0.62.0 incorpora la parte verificable por software de `audio-04`. La mezcla conserva su escena, cursores, música segmentada y niveles de perfil cuando el sistema operativo cambia el dispositivo físico de salida.

## Recorrido implementado

1. `PlaybackAudio::output_changed()` destruye la salida de plataforma y mantiene intacto el mezclador.
2. El siguiente cuadro con una persona admitida abre una salida nueva y continúa desde el estado retenido.
3. Windows atiende cambios de nodos, llegada y retirada de dispositivos mediante `WM_DEVICECHANGE`.
4. Android registra `AudioDeviceCallback`, invalida la salida nativa, abandona el foco anterior y solicita uno nuevo cuando la partida todavía necesita sonido.
5. La salida AAudio comprueba también que el flujo permanezca iniciándose o iniciado. Un flujo detenido deja de considerarse sano.
6. iOS atiende `AVAudioSessionRouteChangeNotification`, interrupciones y reinicios de servicios multimedia.
7. La salida Audio Queue consulta `kAudioQueueProperty_IsRunning`. Una cola detenida se retira en el cuadro siguiente.
8. Salir, perder el foco o pasar a segundo plano conserva el cierre anterior. Un callback de una generación retirada no puede reactivar el sonido.

## Verificación local

- El test nativo de ciclo de vida se compiló directamente con C++20 y pasó usando un dispositivo simulado.
- La simulación comprobó apertura, suspensión idempotente, cambio de ruta, reapertura inmediata, salida no disponible, reintento, ruta rota, cambio de mundo y destrucción sin callback activo.
- Las 65 pruebas de audio, Studio, servidor y reproductor web pasaron.
- `git diff --check` pasó.

El entorno de esta entrega no contiene CMake. La compilación del test común se realizó directamente con `g++`. Tampoco contiene los SDK y dispositivos necesarios para construir y escuchar las salidas específicas de Windows, Android e iOS.

## Pendiente de `audio-04`

- Compilar los tres clientes con sus SDK objetivo.
- Escuchar una misma sala en altavoz y auriculares.
- Retirar y conectar la ruta durante efectos cortos y música segmentada.
- Interrumpir con llamada, asistente de voz o pérdida de foco y comprobar el retorno autorizado.
- Confirmar en cada dispositivo que los niveles guardados se conservan.
- Registrar cualquier ruta que el sistema operativo no notifique y añadir su adaptador específico.

Estas comprobaciones físicas son el criterio restante para cerrar `audio-04`. La entrega no atribuye compatibilidad física, latencia ni calidad acústica a una plataforma todavía no escuchada.
