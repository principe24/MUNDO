# Los dos patios

Abre `Los_dos_patios.mproject` en MUNDO Studio para editar las dos salas. El guía del patio camina entre dos puntos separados por un muro, espera en cada extremo y regresa. La baldosa turquesa conecta con el jardín, donde otro guía se acerca a un visitante, se detiene a su lado y vuelve a su punto de encuentro cuando deja de tener un visitante a quien seguir.

Para jugar en el equipo anfitrión, desde la raíz del motor ejecuta lo siguiente.

```sh
node server/room.cjs examples/navigation/Los_dos_patios.mproject
```

Abre la invitación individual que imprime el anfitrión. Para una segunda plaza, abre la otra invitación. Ambos participantes deben entrar en la misma revisión y estar listos para viajar al cruzar el portal. El anfitrión simula los personajes. Finaliza la sala con Ctrl+C.

El ejemplo y sus piezas son originales. Puedes reconstruir el proyecto en un archivo nuevo y comprobar el recorrido local con estos comandos.

```sh
node examples/navigation/generate.cjs Mi_copia.mproject
node --test tests/npc-room.cjs
```
