"use strict";

// null is a verified full world (also used by legacy seats). undefined is waiting for the first square.
function fits(square,x,z,halfX=.28,halfZ=.28) {
  if(square===null)return true;
  if(!square)return false;
  const reach=(square.radius+.5)*64;
  return Math.abs(x-square.cx*64)+halfX<=reach && Math.abs(z-square.cz*64)+halfZ<=reach;
}

function fitsCar(square,car,x=car.x,z=car.z,yaw=car.yaw) {
  if(square===null)return true;
  const c=Math.abs(Math.cos(yaw)),s=Math.abs(Math.sin(yaw));
  const w=car.width+.04,l=car.length+.04;
  // Include the standing-body footprint of both seated positions even for very narrow cars.
  const rx=Math.max(c*w+s*l,.28+c*car.width*.36);
  const rz=Math.max(s*w+c*l,.28+s*car.width*.36);
  return fits(square,x,z,rx,rz);
}

module.exports={fits,fitsCar};
