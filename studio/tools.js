"use strict";
// Commands propose metadata. Studio validates it before the editor records a change.
window.MundoStudioTools=(()=>{
  const meetingTools=Object.freeze({
    "meeting-by-car":Object.freeze({
      label:"Encuentro junto al turismo",
      available:({car})=>Boolean(car),
      propose({car}){
        if(!car)throw new Error("Elige un turismo compatible para colocar el punto de encuentro.");
        const [x,z]=car.point(-car.width-.65,0);
        return {vehicleRoot:String(car.rootId),meetingPoint:[x,car.base,z]};
      }
    })
  });

  function prepareMeeting(id,scene,car,world=null){
    if(!Object.hasOwn(meetingTools,id))throw new Error("Herramienta de encuentro desconocida.");
    const start=world && MundoCircuit.readGrid(world)?
      MundoDriving.roomStart(world,scene,car?String(car.rootId):null):null;
    const proposal=meetingTools[id].propose({scene,car:start?.car??car});
    const meetingPoint=MundoRoomFile.copyMeetingPoint(proposal.meetingPoint);
    const vehicleRoot=proposal.vehicleRoot??null;
    const seats=start?MundoMeeting.plan(start.road,start.car,meetingPoint).initial:MundoMeeting.preview(scene,vehicleRoot,meetingPoint);
    return {vehicleRoot,meetingPoint,seats};
  }
  return Object.freeze({meetingTools,prepareMeeting});
})();
