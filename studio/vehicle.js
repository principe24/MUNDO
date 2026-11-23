"use strict";

const element = id => document.getElementById(id);
const scene = element("scene");
const brush = scene.getContext("2d");
const controls = ["name", "length", "width", "wheel", "paint"].map(element);
const cube = [
  [-.5,-.5,-.5], [.5,-.5,-.5], [.5,.5,-.5], [-.5,.5,-.5],
  [-.5,-.5,.5], [.5,-.5,.5], [.5,.5,.5], [-.5,.5,.5]
];
const boxFaces = [[3,2,1,0], [4,5,6,7], [0,4,7,3], [1,2,6,5], [3,7,6,2], [0,1,5,4]];
const diameterSegments = 18;
let heading = -.69;
let elevation = .34;

function properties() {
  return {
    name: element("name").value.trim(),
    length: Number(element("length").value),
    width: Number(element("width").value),
    wheel: Number(element("wheel").value),
    paint: element("paint").value
  };
}

// The native cylinder's axle is Y. A quarter turn around Z aligns the wheel with X.
function worldPoint(part, unit) {
  const [x,y,z] = unit.map((v,i) => v * part.size[i]);
  const p = part.position;
  return part.shape === 2 ? [p[0]-y,p[1]+x,p[2]+z] : [p[0]+x,p[1]+y,p[2]+z];
}

function cylinder() {
  const points = [];
  for (const y of [-.5,.5]) {
    for (let i=0; i<diameterSegments; ++i) {
      const a = 2*Math.PI*i/diameterSegments;
      points.push([.5*Math.cos(a),y,.5*Math.sin(a)]);
    }
  }
  const ring = Array.from({ length: diameterSegments }, (_, i) => i);
  const faces = [ring, ring.map(i => i+diameterSegments).reverse()];
  for (const i of ring) {
    const j = (i+1)%diameterSegments;
    faces.push([i,i+diameterSegments,j+diameterSegments,j]);
  }
  return { points, faces };
}

const drum = cylinder();
function rgb(color) {
  return [1,3,5].map(i => parseInt(color.slice(i,i+2),16));
}

function draw() {
  const settings = properties();
  for (const key of ["length","width","wheel"])
    element(key+"Value").textContent = settings[key].toLocaleString("es", {minimumFractionDigits:2, maximumFractionDigits:2})+" m";
  if (!brush) return;
  const width = scene.clientWidth, height = scene.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  scene.width = Math.round(width*dpr);
  scene.height = Math.round(height*dpr);
  brush.setTransform(dpr,0,0,dpr,0,0);
  const scale = Math.min(width*.72/(settings.length+.8), height*.49/(settings.length*.5+1));
  const cx = Math.cos(heading), sx = Math.sin(heading), cy = Math.cos(elevation), sy = Math.sin(elevation);
  function project(point) {
    const [x,y,z] = point;
    const forward = -x*sx+z*cx;
    return [width*.5+(x*cx+z*sx)*scale,height*.60-(y*cy-forward*sy)*scale, y*sy+forward*cy];
  }
  function path(points) {
    brush.beginPath();
    brush.moveTo(points[0][0],points[0][1]);
    for (const p of points.slice(1)) brush.lineTo(p[0],p[1]);
  }
  brush.strokeStyle = "#60808544";
  brush.lineWidth = 1;
  for (let i=-8; i<=8; ++i) {
    path([project([i,0,-8]),project([i,0,8])]); brush.stroke();
    path([project([-8,0,i]),project([8,0,i])]); brush.stroke();
  }
  const surfaces = [];
  for (const part of MundoVehicleModel.vehicle(settings)) {
    const mesh = part.shape === 2 ? drum : { points:cube, faces:boxFaces };
    const world = mesh.points.map(p => worldPoint(part,p));
    const points = world.map(project);
    const color = rgb(part.color);
    for (const face of mesh.faces) {
      const polygon = face.map(i => points[i]);
      const [p,q,r] = face.map(i => world[i]);
      const a = q.map((n,i)=>n-p[i]), b = r.map((n,i)=>n-p[i]);
      const n = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      const facing = -sx*cy*n[0]+sy*n[1]+cx*cy*n[2];
      if (facing <= 0) continue;
      const shade = .76 + .27*(-.40*n[0]+.84*n[1]+.36*n[2])/Math.hypot(...n);
      const fill = "rgb("+color.map(v=>Math.min(255,Math.round(v*shade))).join(",")+")";
      const depth = polygon.reduce((sum,v)=>sum+v[2],0)/polygon.length;
      surfaces.push({ polygon, depth, fill });
    }
  }
  surfaces.sort((a,b)=>a.depth-b.depth);
  for (const { polygon,fill } of surfaces) {
    path(polygon); brush.closePath();
    brush.fillStyle = fill; brush.fill(); brush.strokeStyle = "#14232a62"; brush.lineWidth = .7; brush.stroke();
  }
}

let drag;
scene.addEventListener("pointerdown", event=>{
  drag = { id:event.pointerId, x:event.clientX, y:event.clientY };
  scene.setPointerCapture(event.pointerId);
});
scene.addEventListener("pointermove", event=>{
  if (!drag || drag.id!==event.pointerId) return;
  heading += (event.clientX-drag.x)*.009;
  elevation = Math.max(.12, Math.min(1.1,elevation+(event.clientY-drag.y)*.006));
  drag.x=event.clientX; drag.y=event.clientY; draw();
});
scene.addEventListener("lostpointercapture", ()=>{ drag=undefined; });
function rotate(delta) { heading+=delta; draw(); }
element("left").onclick = ()=>rotate(-Math.PI/8);
element("right").onclick = ()=>rotate(Math.PI/8);
scene.onkeydown = event=>{
  if (!["ArrowLeft","ArrowRight"].includes(event.key)) return;
  event.preventDefault(); rotate(event.key==="ArrowLeft" ? -.15 : .15);
};
controls.forEach(control=>control.addEventListener("input",draw));
element("export").onclick = ()=>{
  try {
    const settings = properties();
    const name="MUNDO_"+(settings.name || "Turismo");
    MundoWorld.download(MundoVehicleModel.vehicleWorld(settings),name);
    element("status").textContent="Descarga solicitada · "+name+".mworld";
  } catch(error) {
    element("status").textContent=error.message || "No se pudo preparar el mundo.";
  }
};
window.addEventListener("resize",draw);
draw();

const practiceTrack=()=>MundoVehicleModel.practiceTrack(properties());
const meetAtCar=element("meetAtCar");
function trackSession(){
  const track=practiceTrack();
  if(!meetAtCar.checked)return track;
  const scene=MundoGeometry.flatten(track.world);
  const {vehicleRoot,meetingPoint}=MundoStudioTools.prepareMeeting("meeting-by-car",scene,MundoDriving.roomCar(scene));
  return {...track,vehicleRoot,meetingPoint};
}
MundoPrepararSala(element("drive"),trackSession,message=>{element("status").textContent=message;});
element("saveTrack").onclick=()=>{
  try{
    const {world,title}=practiceTrack();MundoWorld.download(world,title);
    element("status").textContent=meetAtCar.checked
      ?"Descarga de la pista y el carro solicitada. Para guardar también el encuentro, prepara la sala .mroom."
      :"Descarga de la pista y el carro solicitada.";
  }catch(error){element("status").textContent=error.message;}
};

const prepareRoom=element("prepareRoom"), downloadRoom=element("downloadRoom");
let trackGeneration=0, roomUrl=null;
function invalidateRoom(){
  ++trackGeneration;
  if(roomUrl)URL.revokeObjectURL(roomUrl);
  roomUrl=null;
  downloadRoom.hidden=true;
  downloadRoom.removeAttribute("href");
  if(prepareRoom.disabled)element("status").textContent="La pista cambió. Puedes preparar una nueva revisión.";
  prepareRoom.disabled=false;
}
controls.forEach(control=>control.addEventListener("input",invalidateRoom));
meetAtCar.addEventListener("change",invalidateRoom);
window.addEventListener("pagehide",invalidateRoom);
prepareRoom.onclick=async ()=>{
  const generation=trackGeneration;
  prepareRoom.disabled=true;
  try{
    const {world,title,vehicleRoot,meetingPoint}=trackSession();
    const {id}=await MundoPublications.publish(world,title,vehicleRoot,meetingPoint);
    if(generation!==trackGeneration)return;
    const info=await MundoPublications.get(id);
    const {filename,blob}=await MundoPublications.roomDownload(info);
    if(generation!==trackGeneration)return;
    roomUrl=URL.createObjectURL(blob);
    downloadRoom.href=roomUrl;
    downloadRoom.download=filename;
    downloadRoom.hidden=false;
    element("status").textContent=info.title+" · v"+info.revision+" preparada. Descarga la sala y elige "+filename+" en el panel del anfitrión.";
  }catch(error){
    if(generation!==trackGeneration)return;
    prepareRoom.disabled=false;
    element("status").textContent="No se pudo preparar la sala. "+error.message+
      " También puedes usar Guardar pista con el carro.";
  }
};
