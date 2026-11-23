"use strict";
const readline=require("node:readline");

function attachConsole(moderation,origin,server){
  if(!process.stdin.isTTY||!process.stdout.isTTY)return;
  const lines=readline.createInterface({input:process.stdin,terminal:false});
  console.log("Escribe ayuda para administrar la sala.");
  lines.on("line",async line=>{
    const args=line.trim().toLowerCase().split(/\s+/);
    const [verb,seat]=args;
    if(!verb)return;
    try{
      if(args.length===1){
        if(verb==="ayuda"){
          const checkpoint=moderation.status().checkpoint;
          console.log("estado · suspender · reanudar · expulsar 1|2 · invitar 1|2"+
            (checkpoint && checkpoint.canSave!==false && ["ready","saved","unavailable"].includes(checkpoint.state)?" · guardar":""));
          return;
        }
        if(verb==="estado"){
          const {admissionsOpen,seats,vehicle,checkpoint}=moderation.status();
          console.log(admissionsOpen?"Admisiones abiertas.":"Admisiones suspendidas.");
          for(const s of seats){
            let description=s.state;
            if(s.state==="caducado")description+=" · usa invitar "+s.number+" para crear otro enlace";
            if(s.state==="disponible" && Number.isFinite(s.inviteSeconds))
              description+=" · invitación válida por "+Math.ceil(s.inviteSeconds/60)+" min como máximo";
            console.log("Asiento "+s.number+" · "+description);
          }
          if(vehicle){
            const wheel=vehicle.driver===null?"volante libre":"conduce el jugador "+(vehicle.driver+1);
            const beside=vehicle.passenger===null?"plaza de pasajero libre":"pasajero "+(vehicle.passenger+1);
            console.log("Turismo "+vehicle.root+" · "+wheel+" · "+beside);
          }
          if(checkpoint && checkpoint.state!=="off"){
            const messages={ready:"Preparada para guardar.",saving:"Guardado en curso.",saved:"Copia local guardada.",
              unavailable:"Almacenamiento no disponible.",busy:"Otro anfitrión controla el guardado.",
              invalid:"No se pudo recuperar la copia de esta revisión."};
            console.log("Partida · "+(checkpoint.detail || messages[checkpoint.state] || "Estado desconocido."));
            if(checkpoint.restored)console.log("Se recuperó el progreso al abrir esta sala. Usa las invitaciones nuevas.");
            if(Number.isFinite(checkpoint.savedAt))console.log("Última copia en disco · "+new Date(checkpoint.savedAt).toLocaleString("es"));
          }
          return;
        }
        if(verb==="guardar"){
          await moderation.saveCheckpoint();
          const checkpoint=moderation.status().checkpoint;
          console.log(checkpoint?.state==="saved"?"Partida guardada en el equipo anfitrión.":
            checkpoint?.detail || "No se confirmó el guardado de la partida. Consulta estado.");
          return;
        }
        if(verb==="suspender"||verb==="reanudar"){
          moderation.setAdmissions(verb==="reanudar");
          console.log(verb==="reanudar"?"Nuevas entradas habilitadas.":"Nuevas entradas suspendidas. Los jugadores conservan sus asientos.");
          return;
        }
      }
      if(args.length===2&&/^[12]$/.test(seat)){
        const number=Number(seat);
        if(["cerrar","revocar","expulsar"].includes(verb)){
          moderation.revoke(number);
          console.log("Asiento "+number+" cerrado. Su invitación queda revocada.");
          return;
        }
        if(["reabrir","invitar"].includes(verb)){
          moderation.issue(number);
          const invite=moderation.invitation(number);
          console.log("Nueva invitación para el asiento "+number+" · "+origin+"/mundo/MUNDO.html#seat="+invite);
          return;
        }
      }
      console.log("Comando desconocido. Escribe ayuda.");
    }catch(error){
      console.error(error.message);
    }
  });
  server.once("close",()=>lines.close());
}

module.exports={attachConsole};
