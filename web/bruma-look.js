"use strict";
// Public identifiers describe admission to an optional appearance; geometry is a separate owner asset.
globalThis.MundoBrumaLook=(()=>{
  const modelName="Bruma · Serie 1";
  const component=new Map([["Chasis",45101],["Carrocería",45102]]);
  for(const end of ["delantera","trasera"]){
    for(const [side,tire,rim] of [["izquierda",45103,45105],["derecha",45104,45106]]){
      component.set("Rueda "+end+" "+side,tire);
      component.set("Llanta "+end+" "+side,rim);
    }
  }
  const slots=Array.from(new Set(component.values())), metadata=new WeakMap();
  const key=slot=>"bruma-v1:"+slot;

  // Car.parts is a snapshot of the already validated, currently installed physics family.
  function profile(car){
    if(!car || car.name!==modelName)return null;
    if(metadata.has(car))return metadata.get(car);
    let result=null;
    if(car.parts.length===component.size && car.parts.every(({entry:{n}})=>{
      const slot=component.get(n.name);
      return slot!==undefined && n.shape===(slot<=45102?1:2) && n.visual===0n;
    })){
      const body=car.parts.find(part=>part.entry.n.name==="Carrocería");
      const frontRims=car.axles.slice(0,2).map(axle=>{
        const hub=axle.rotating.find(part=>part.entry===axle.wheel);
        const rim=axle.rotating.find(part=>part.entry!==axle.wheel);
        return {wheel:axle.wheel,entry:rim.entry,dx:rim.rest[12]-hub.rest[12],dz:rim.rest[14]-hub.rest[14]};
      });
      result={body,frontRims};
    }
    metadata.set(car,result);
    return result;
  }
  function isBruma(car){return !!profile(car);}
  function bind(car){
    if(!isBruma(car))return false;
    for(const {entry} of car.parts){
      entry.appearanceKey=key(component.get(entry.n.name));
      entry.originalFinish=true;
    }
    return true;
  }
  // Seat pivots are in the authored body's normalized coordinates. Car.point uses the
  // live (or interpolated presentation) chassis pose, including a custom starting grid.
  function seat(car,passenger){
    const data=profile(car);
    if(!data)return null;
    const m=data.body.rest, x=(passenger ? .38 : -.38)/1.80, y=(.50-.745)/1.10, z=.10/3.76;
    const axis=i=>m[i]*x+m[i+4]*y+m[i+8]*z+m[i+12];
    const [worldX,worldZ]=car.point(axis(0),axis(2));
    return [worldX,axis(1),worldZ];
  }
  function steerRims(car){
    const data=profile(car);
    if(!data || car.steer===0)return;
    const c=Math.cos(car.yaw+car.steer),s=Math.sin(car.yaw+car.steer);
    // A Bruma spoke lies outside its tyre's centre plane. Rotate that offset
    // around the steered axle, keeping each rim concentric with its tyre.
    for(const {wheel,entry,dx,dz} of data.frontRims){
      entry.center[0]=entry.m[12]=wheel.center[0]+c*dx-s*dz;
      entry.center[2]=entry.m[14]=wheel.center[2]+s*dx+c*dz;
    }
  }
  function install(view){
    let generation=0,installed=false;
    function clearBruma(){
      ++generation;
      if(!installed)return;
      const next=new Map(view.catalog);
      for(const slot of slots)next.delete(key(slot));
      view.setCatalog(next);installed=false;
    }
    async function applyBruma(bytes,current=()=>true){
      const turn=++generation;
      if(!current())return false;
      if(!(bytes instanceof Uint8Array)||bytes.byteLength!==866629)
        throw Error("El archivo no corresponde al cupé Bruma de esta edición.");
      const digest=await MundoRoomFile.digest(bytes);
      if(turn!==generation||!current())return false;
      if(digest!=="a970977b2fd78a69cb411c58565b1f8a0a9fbc107472fe04d34f911b10c766ce")
        throw Error("La apariencia de Bruma no coincide con la del catálogo.");
      const art=MundoGeometry.readCatalog(bytes,1), next=new Map(view.catalog);
      if(art.size!==slots.length || !slots.every(slot=>art.has(BigInt(slot))))
        throw Error("Faltan piezas de la carrocería o de las ruedas de Bruma.");
      for(const slot of slots)next.set(key(slot),art.get(BigInt(slot)));
      view.setCatalog(next);installed=true;
      return true;
    }
    return Object.freeze({applyBruma,clearBruma});
  }
  return Object.freeze({modelName,isBruma,bind,seat,steerRims,install});
})();
