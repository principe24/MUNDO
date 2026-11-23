"use strict";
// Only the admitted player's snapshots can move a window. Keep the last adjacent
// window briefly while interpolating; a teleport discards it immediately.
window.MundoRoomResidence=(()=>{
  const cell=MundoZones.cell;
  function windowAt(old,x,z,radius,now){
    const window=MundoZones.roomWindow(x,z,radius,old);
    const cx=window.x,cz=window.z;
    if(old && (cx!==old.x || cz!==old.z)){
      if(Math.max(Math.abs(cx-old.x),Math.abs(cz-old.z))===1){
        window.previous=[old.x-radius,old.x+radius,old.z-radius,old.z+radius];window.until=now+150;
      }
    }else if(old?.until>now){
      window.previous=old.previous;window.until=old.until;
    }
    return window;
  }
  function floorAt(terrain,x,z,y,padding,tolerance){
    for(const box of terrain.region(x-padding,x+padding,z-padding,z+padding)){
      if(x+padding>=box.min[0] && x-padding<=box.max[0] && z+padding>=box.min[2] && z-padding<=box.max[2] &&
          Math.abs(box.max[1]-y)<=tolerance)return true;
    }
    return false;
  }
  function supported(terrain,self,state,car,aboard){
    if(aboard && car){
      return car.contacts.every(([i,j])=>{
        const [x,z]=car.point(i,j,state.x,state.z,state.yaw);
        return floorAt(terrain,x,z,car.base,.001,.04);
      });
    }
    const [x,y,z]=self.position;
    return !self.grounded || floorAt(terrain,x,z,y,.30,.35);
  }
  return class {
    constructor(world,roots,geometry,cars=null){
      this.radius=window.MundoView?.mobile===false?2:1;
      this.next=world.next;this.sources=new Map();
      this.global={byId:new Map(),objects:[]};
      const owners=new Map(),buckets=new Map();
      const anchor=geometry.objects.find(object=>object.n.shape)?.n.id;
      // Source families retain only node records from the authenticated document.
      // Transformed matrices and collision boxes for far cells are disposable.
      for(const node of world.nodes.values()){
        let parent=node;
        const path=[];
        while(parent.parent && !owners.has(parent.id)){path.push(parent.id);parent=world.nodes.get(parent.parent);}
        const root=owners.get(parent.id)??parent.id;
        for(const id of path)owners.set(id,root);
        const local=roots.get(root);
        if(!local)continue;
        if(node.id===anchor || node.name==="Chasis" || (!node.parent &&
          (node.name.startsWith(MundoCircuit.prefix) || node.name.startsWith(MundoProject.tilePrefix))))
          throw Error("El índice asignó una familia permanente a un barrio.");
        const [cx,cz]=local,key=cx+","+cz;
        if(node.shape || node.visual){
          const object=geometry.byId.get(node.id);
          if(!object || ![0,2].every((axis,i)=>cell(object.center[axis]-object.extent[axis])===local[i] &&
              cell(object.center[axis]+object.extent[axis])===local[i]))
            throw Error("Una pieza está fuera del barrio declarado.");
        }
        buckets.set(node.id,key);
        if(!this.sources.has(key))this.sources.set(key,new Map());
        this.sources.get(key).set(node.id,node);
      }
      for(const [id,object] of geometry.byId)if(!buckets.has(id))this.global.byId.set(id,object);
      for(const object of geometry.objects)if(!buckets.has(object.n.id))this.global.objects.push(object);
      this.cars=cars??MundoDriving.discover(this.global);
      if(this.cars.some(car=>!this.global.byId.has(car.rootId) ||
          car.parts.some(part=>!this.global.byId.has(part.entry.n.id))))
        throw Error("El índice separó al turismo de las familias permanentes.");
      this.clear();
    }
    clear(){
      this.feet=null;this.vehicle=null;this.layers=new Map();this.active=null;this.rejected=null;this.retryAfter=0;
    }
    collect(window,keys){
      const add=(left,right,back,front)=>{
        for(let x=left;x<=right;x++)for(let z=back;z<=front;z++){
          const key=x+","+z;if(this.sources.has(key))keys.add(key);
        }
      };
      add(window.left,window.right,window.back,window.front);
      if(window.previous)add(...window.previous);
    }
    prepare(keys,signature,car){
      const geometry={byId:new Map(this.global.byId),objects:this.global.objects.slice()},layers=new Map();
      for(const key of keys){
        const layer=this.layers.get(key)??MundoGeometry.flatten({next:this.next,nodes:this.sources.get(key)});
        if(signature!==null)layers.set(key,layer);
        for(const [id,object] of layer.byId)geometry.byId.set(id,object);
        for(const object of layer.objects)geometry.objects.push(object);
      }
      const solid=car?geometry.objects.filter(object=>!car.partIds.has(object.n.id)):geometry.objects;
      return {geometry,terrain:new MundoWalk(solid,false),signature,layers};
    }
    whole(car){
      if(this.active?.signature!==null)this.active=this.prepare(this.sources.keys(),null,car);
      this.layers=this.active.layers;
      return this.active;
    }
    select(self,state,now){
      const car=state?this.cars.find(item=>String(item.rootId)===state.root):null;
      if(state && !car)throw Error("El turismo no está en las familias permanentes.");
      const aboard=state && (state.driver===self.id || state.passenger===self.id);
      const valid=n=>Number.isFinite(n) && Math.abs(n)<=1e15;
      if(!valid(self.position[0]) || !valid(self.position[2]) || (aboard && (!valid(state.x) || !valid(state.z)))){
        this.feet=null;this.vehicle=null;this.rejected=null;
        return this.whole(car);
      }
      this.feet=windowAt(this.feet,self.position[0],self.position[2],this.radius,now);
      this.vehicle=aboard?windowAt(this.vehicle,state.x,state.z,this.radius,now):null;
      const keys=new Set();this.collect(this.feet,keys);
      if(this.vehicle)this.collect(this.vehicle,keys);
      const signature=Array.from(keys).sort().join(";");
      let next=this.active;
      const retry=this.rejected===signature && now>=this.retryAfter && this.active &&
        supported(this.active.terrain,self,state,car,aboard);
      if(keys.size<this.sources.size && (this.rejected!==signature || retry)){
        if(next?.signature!==signature)next=this.prepare(keys,signature,car);
        if((next.terrain.grid.size || next.terrain.large.length) && supported(next.terrain,self,state,car,aboard)){
          this.rejected=null;this.active=next;this.layers=next.layers;return next;
        }
        this.rejected=signature;this.retryAfter=now+1000;
      }else if(keys.size===this.sources.size)this.rejected=null;
      return this.whole(car);
    }
  };
})();
