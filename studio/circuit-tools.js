"use strict";
// Only the authoring application loads these scene mutations.
window.MundoCircuitEdit = (() => {
  const {scan,validate,limit,prefix}=MundoCircuit;
  function fail(message){throw Error(message);}
  function nameAt(slot,label) { return prefix + String(slot).padStart(2,"0") + "/" + label; }
  function apply(world,id,slot,fields) {
    validate(fields);
    const half = -(fields.bearing % 360) * Math.PI / 360;
    const node = world.nodes.get(id);
    world.nodes.set(id,{...node,name:nameAt(slot,fields.label),p:fields.point.slice(),
      q:[0,Math.sin(half),0,Math.cos(half)],s:[fields.width,fields.height,1]});
  }
  function sequence(world,gates) {
    gates.forEach(({id,label},index) => {
      const node = world.nodes.get(id), name = nameAt(index+1,label);
      if (node.name !== name) world.nodes.set(id,{...node,name});
    });
  }
  function createGate(world,slot,fields) {
    validate(fields);
    const pieces=MundoWorld.empty();
    function box(name,p,s,color) {
      const part=MundoWorld.add(pieces,name,1);
      part.p=p;part.s=s;part.color=color;part.rough=.68;
    }
    for (const side of [-1,1]) box("Poste de control",[side*.515,.5,0],[.03,1,.24],[.03,.52,.45]);
    box("Travesaño",[0,1.035,0],[1.06,.07,.28],[.03,.52,.45]);
    box("Señal de sentido",[0,1.09,-.19],[.07,.04,.55],[.98,.61,.12]);
    // place reserves all five nodes and identifiers before changing the draft.
    const id=MundoWorld.place(world,pieces,nameAt(slot,fields.label),fields.point);
    apply(world,id,slot,fields);
    return id;
  }
  function add(world,fields) {
    const gates=scan(world);
    if(gates.length===limit)fail("Este mundo ya contiene 32 puertas.");
    const id=createGate(world,gates.length+1,fields);
    sequence(world,gates);
    return id;
  }
  function insert(world,id,markedPoint=null) {
    const gates=scan(world),at=gates.findIndex(g=>g.id===id);
    if(at<0 || at+1>=gates.length)fail("Elige una puerta que tenga otra a continuación.");
    if(gates.length===limit)fail("Este mundo ya contiene 32 puertas.");
    const from=gates[at],to=gates[at+1];
    const names=new Set(gates.map(g=>g.label.normalize("NFC").toLocaleLowerCase("es")));
    let number=at+2;
    while(names.has("paso "+number))++number;
    const label="Paso "+number,point=markedPoint??from.point.map((n,i)=>(n+to.point[i])/2);
    const fields={label,point,width:from.width,height:from.height,bearing:0};
    validate(fields);
    const incomingX=point[0]-from.point[0],incomingZ=point[2]-from.point[2];
    const outgoingX=to.point[0]-point[0],outgoingZ=to.point[2]-point[2];
    const firstLeg=Math.hypot(incomingX,incomingZ),lastLeg=Math.hypot(outgoingX,outgoingZ);
    if(lastLeg<.01 || firstLeg<.01)
      fail("Separa el paso al menos un centímetro de ambos extremos en el plano XZ.");
    let forwardX=outgoingX/lastLeg,forwardZ=outgoingZ/lastLeg;
    // Face the successor directly if the approach arms the server trigger.
    // At a sharp corner the bisector lets both straight legs cross the gate.
    if(incomingX*forwardX+incomingZ*forwardZ<.01){
      const x=forwardX+incomingX/firstLeg,z=forwardZ+incomingZ/firstLeg,norm=Math.hypot(x,z);
      if(norm<1e-8)fail("El desvío vuelve sobre la misma línea. Marca el paso a un lado del tramo.");
      forwardX=x/norm;forwardZ=z/norm;
      if(incomingX*forwardX+incomingZ*forwardZ<.01 || outgoingX*forwardX+outgoingZ*forwardZ<.01)
        fail("El arco necesita un centímetro de paso por cada lado. Separa el desvío de los extremos.");
    }
    fields.bearing=Math.atan2(forwardX,-forwardZ)*180/Math.PI;
    const inserted=createGate(world,at+2,fields);
    gates.splice(at+1,0,{id:inserted,label});
    sequence(world,gates);
    return inserted;
  }
  function change(world,id,fields) {
    const gate=scan(world).find(item=>item.id===id);
    if (!gate) fail("Selecciona una puerta del circuito.");
    apply(world,id,gate.slot,fields);return id;
  }
  function duplicate(world,id) {
    const gates=scan(world),at=gates.findIndex(gate=>gate.id===id);
    if(at<0)return MundoWorld.duplicate(world,id);
    if(gates.length===limit)fail("Este mundo ya contiene 32 puertas.");
    const gate=gates[at], [x,y,z]=gate.point;
    const copy=MundoWorld.duplicate(world,id,[x+gate.forwardX*5,y,z+gate.forwardZ*5]);
    gates.splice(at+1,0,{id:copy,label:gate.label});
    sequence(world,gates);return copy;
  }
  function move(world,id,delta) {
    const gates=scan(world), at=gates.findIndex(gate=>gate.id===id), to=at+delta;
    if (Math.abs(delta)!==1 || at<0 || to<0 || to>=gates.length) fail("La puerta ya está en ese extremo.");
    [gates[at],gates[to]]=[gates[to],gates[at]];
    sequence(world,gates);return id;
  }
  function remove(world,id) {
    const gates=scan(world), at=gates.findIndex(gate=>gate.id===id);
    if (at<0) fail("Selecciona la puerta que quieres quitar.");
    for(const part of MundoWorld.subtree(world,id))world.nodes.delete(part);
    gates.splice(at,1);sequence(world,gates);
    return gates[Math.min(at,gates.length-1)]?.id??null;
  }
  function practiceSnapshot(draft,firstId,lastId,requestedMode) {
    const course=MundoCircuit.read(draft.world),gates=course.gates,first=gates.findIndex(g=>String(g.id)===firstId);
    const last=gates.findIndex(g=>String(g.id)===lastId);
    if(first<0 || last<=first)fail("Elige al menos dos puertas reales en orden de paso.");
    const startMode=requestedMode===undefined?course.startMode:requestedMode;
    if(startMode!=="movement" && startMode!=="flying")fail("Elige cuándo empieza el cronómetro.");
    const copy=MundoWorld.fork(draft.world);
    if(startMode!==course.startMode){
      if(startMode==="flying")MundoWorld.add(copy,MundoCircuit.flyingMarker,0);
      else {
        const marker=[...copy.nodes.values()].find(n=>n.parent===0n && n.name===MundoCircuit.flyingMarker);
        copy.nodes.delete(marker.id);
      }
    }
    for(const [i,gate] of gates.entries()){
      if(i>=first && i<=last)continue;
      const node=copy.nodes.get(gate.id);
      // A user label can itself start with a marker namespace. Keep it behind
      // an ordinary prefix so a decorative group can never become a trigger.
      copy.nodes.set(gate.id,{...node,name:"Arco "+gate.slot+" · "+gate.label});
    }
    sequence(copy,gates.slice(first,last+1));
    const geometry=MundoGeometry.flatten(copy);
    const meetingPoint=MundoRoomFile.copyMeetingPoint(draft.meetingPoint);
    MundoMeeting.validatePublication(copy,geometry,draft.vehicleRoot,meetingPoint,true);
    const range=(first+1)+"–"+(last+1),prefix=(startMode==="flying"?"Práctica lanzada ":"Práctica ")+range+" · ";
    const original=draft.title.trim()||"Mi mundo";
    if(original.length>128 || /[\u0000-\u001f\u007f-\u009f]/u.test(original))fail("El nombre del borrador debe ser visible y tener hasta 128 caracteres.");
    let title=prefix;
    for(const symbol of original){
      if(title.length+symbol.length>128)break;
      title+=symbol;
    }
    return {bytes:MundoWorld.encode(copy),info:{title,revision:1,vehicleRoot:draft.vehicleRoot,meetingPoint},
      first:first+1,last:last+1};
  }
  async function practiceRoom(draft,firstId,lastId,current,startMode) {
    const {bytes,info,first,last}=practiceSnapshot(draft,firstId,lastId,startMode);
    info.hash=await MundoRoomFile.digest(bytes);
    if(!current())return null;
    const packed=await MundoRoomFile.seal(info,bytes);
    if(!current())return null;
    const hash=await MundoRoomFile.digest(packed);
    if(!current())return null;
    const filename="Practica_"+first+"-"+last+"_"+hash.slice(0,12)+".mroom";
    return {blob:new Blob([packed],{type:"application/vnd.mundo.room-file"}),filename,
      hash,gates:last-first+1};
  }
  return Object.freeze({add,insert,change,duplicate,move,remove,practiceRoom});
})();
