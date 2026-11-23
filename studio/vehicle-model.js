"use strict";
window.MundoVehicleModel=(()=>{
  const wheelRotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const identity = [0, 0, 0, 1];
  function vehicle(settings) {
    const { length, width, wheel, paint } = settings;
    const parts = [];
    function add(name, size, position, color, shape = 1, metallic = .12, roughness = .45) {
      parts.push({ name, size, position, color, shape, metallic, roughness });
    }
    const deck = wheel * .5 + .15;
    add("Chasis", [width * .88,.18,length * .87], [0,deck-.12,0], "#35434a");
    add("Carrocería", [width,.46,length], [0,deck+.15,0], paint);
    add("Cabina", [width*.76,.57,length*.43], [0,deck+.65,.08*length], "#769399", 1, .30, .26);
    add("Techo", [width*.78,.13,length*.44], [0,deck+.97,.08*length], paint);
    add("Parachoques delantero", [width*.92,.13,.14], [0,deck-.01,-length*.50], "#435159");
    add("Parachoques trasero", [width*.92,.13,.14], [0,deck-.01,length*.50], "#435159");
    for (const side of [-1,1]) {
      const label = side < 0 ? "izquierda" : "derecha";
      add("Luz delantera " + label, [width*.22,.13,.04], [side*width*.32,deck+.24,-length*.503], "#ffe8a0");
      add("Luz trasera " + label, [width*.20,.12,.04], [side*width*.32,deck+.22,length*.503], "#e35f58");
      for (const end of [-1,1]) {
        const wheelName = (end < 0 ? "delantera " : "trasera ") + label;
        const axle = [side*width*.50,wheel*.5,end*length*.32];
        add("Rueda " + wheelName, [wheel,.24,wheel], axle, "#262e32", 2, .02, .94);
        add("Llanta " + wheelName, [wheel*.56,.035,wheel*.56],
            [axle[0]+side*.125,axle[1],axle[2]], "#c3cbd0", 2, .75, .28);
      }
    }
    return parts;
  }

  function vehicleWorld(settings) {
    const world=MundoWorld.empty();
    const group=MundoWorld.add(world,settings.name || "Turismo",0);
    group.color=[1,1,1]; group.rough=.55;
    for (const part of vehicle(settings)) {
      const node=MundoWorld.add(world,part.name,part.shape,group.id);
      node.p=part.position; node.s=part.size;
      node.q=part.shape===2 ? wheelRotation.slice() : identity.slice();
      node.color=MundoWorld.fromHex(part.color); node.rough=part.roughness; node.metal=part.metallic;
    }
    return world;
  }

  function placeBruma(world, point) {
    const placement=MundoWorld.add(world,"Bruma",0);
    placement.p=point.slice();
    const rig=MundoWorld.add(world,MundoBrumaLook.modelName,0,placement.id);
    function part(name,shape,position,size,color,rough,metal){
      const node=MundoWorld.add(world,name,shape,rig.id);
      node.p=position;node.s=size;node.color=MundoWorld.fromHex(color);
      node.rough=rough;node.metal=metal;
      if(shape===2)node.q=wheelRotation.slice();
    }
    // The collision volumes and wheel pivots use metres. The distribution
    // mesh is attached in the renderer so these files still use regular tourism nodes.
    part("Chasis",1,[0,.217,0],[1.48,.10,2.48],"#35434a",.58,.24);
    part("Carrocería",1,[0,.745,0],[1.80,1.10,3.76],"#548282",.28,.45);
    for(const side of [-1,1]){
      const sideName=side<0?"izquierda":"derecha";
      for(const [end,z] of [["delantera",-1.09],["trasera",1.12]]){
        const suffix=end+" "+sideName;
        part("Rueda "+suffix,2,[side*.7275,.315,z],[.63,.204,.63],"#393c40",.93,.02);
        part("Llanta "+suffix,2,[side*.7885,.315,z],[.444,.102,.444],"#c4cbc7",.28,.77);
      }
    }
    return {placement:placement.id,vehicleRoot:rig.id};
  }

  function practiceTrack(settings,placeCar) {
    const world=MundoWorld.empty();
    function block(name,position,size,color){
      const node=MundoWorld.add(world,name,1);
      node.p=position;node.s=size;node.color=MundoWorld.fromHex(color);
    }
    block("Pista",[0,-.2,0],[48,.4,48],"#566469");
    for(const sign of [-1,1]){
      block("Barrera lateral",[sign*23.8,.35,0],[.4,.7,48],"#e59056");
      block("Barrera de fondo",[0,.35,sign*23.8],[47.2,.7,.4],"#e59056");
    }
    for(let i=0;i<4;i++)block("Baliza "+(i+1),[(i%2?3:-3),.55,3-i*5],[.8,1.1,.8],"#f9b465");
    // The player starts at z=9 alongside the driver's door.
    const point=[2.4,0,9];
    if(placeCar)return {world,title:"Pista · "+settings.name,...placeCar(world,point)};
    MundoWorld.place(world,vehicleWorld(settings),settings.name||"Turismo",point);
    return {world,title:"Pista · "+(settings.name||"Turismo")};
  }
  function brumaTrack(){return practiceTrack({name:"Bruma"},placeBruma);}
  return {vehicle,vehicleWorld,practiceTrack,placeBruma,brumaTrack};
})();
