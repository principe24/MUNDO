"use strict";
// The studio preview and authoritative room use the walking controller's static proxies.
window.MundoMeeting = (() => {
  const halfWidth = .28, height = 1.68, epsilon = .001;
  const spacing = .8, rings = 3, radius = spacing * rings, levelTolerance = .5;
  const samples = [];
  for (let i = -rings; i <= rings; ++i) {
    for (let j = -rings; j <= rings; ++j) {
      if (i * i + j * j <= rings * rings) samples.push([i, j]);
    }
  }
  samples.sort(([i, j], [k, l]) => (i*i+j*j) - (k*k+l*l) || i-k || j-l);

  function contains(box, x, z) {
    return x >= box.min[0] && x <= box.max[0] && z >= box.min[2] && z <= box.max[2];
  }

  // Within a one-metre vertical search, a higher overlapping top blocks a lower
  // standing position. Examine that highest top, then check clearance and support.
  function surface(boxes, road, x, desiredY, z) {
    const column = [];
    let floor = -Infinity;
    for (const box of boxes) {
      if (!road.overlaps(box, x, z)) continue;
      column.push(box);
      const top = box.max[1];
      if (Math.abs(top - desiredY) <= levelTolerance) floor = Math.max(floor, top);
    }
    if (!Number.isFinite(floor)) return null;
    const probes = [[x,z], [x-halfWidth,z-halfWidth], [x+halfWidth,z-halfWidth],
      [x-halfWidth,z+halfWidth], [x+halfWidth,z+halfWidth]];
    let support = 0;
    for (const box of column) {
      if (box.max[1] > floor + epsilon && box.min[1] < floor + height) return null;
      if (Math.abs(box.max[1] - floor) <= epsilon) {
        for (let i = 0; i < probes.length; ++i)
          if (contains(box, probes[i][0], probes[i][1])) support |= 1 << i;
      }
    }
    return support === 31 ? [x, floor, z] : null;
  }

  function blockedByCar([x,y,z], car) {
    return car && y < car.top && y + height > car.base && car.intersects({
      min: [x-halfWidth,y,z-halfWidth], max: [x+halfWidth,y+height,z+halfWidth]
    });
  }

  function overlapsPlayer(a, b) {
    return Math.abs(a[0]-b[0]) < 2*halfWidth && Math.abs(a[2]-b[2]) < 2*halfWidth &&
      Math.abs(a[1]-b[1]) < height;
  }

  function plan(road, car, point) {
    if (!Array.isArray(point) || point.length !== 3 ||
        ![0,1,2].every(i => Number.isFinite(point[i]) && Math.abs(point[i]) <= 1e6))
      throw Error("Las coordenadas del punto de encuentro son inválidas.");
    const [x,y,z] = point, extent = radius + halfWidth;
    const boxes = Array.from(road.region(x-extent,x+extent,z-extent,z+extent))
      .filter(box => box.max[1] >= y-levelTolerance-epsilon && box.min[1] < y+levelTolerance+height);
    const candidates = [];
    for (const [i,j] of samples) {
      const feet = surface(boxes, road, x+i*spacing, y, z+j*spacing);
      if (feet) candidates.push(feet);
    }

    // Distinct samples have at least .8 m between centres on one horizontal axis.
    // Cache static candidates. Chassis and player positions can change between joins.
    const initial = candidates.filter(feet => !blockedByCar(feet, car)).slice(0, 2);
    if (initial.length !== 2)
      throw Error("El punto de encuentro necesita suelo y espacio libre para dos jugadores en la misma zona.");
    function position(seat, otherFeet, reservePair = !otherFeet, clear = null) {
      const available = feet => !blockedByCar(feet, car) && (!otherFeet || !overlapsPlayer(feet, otherFeet)) && (!clear || clear(feet));
      if (!reservePair) {
        if (available(initial[seat])) return initial[seat].slice();
        const replacement = candidates.find(available);
        return replacement ? replacement.slice() : null;
      }
      const free = candidates.filter(available);
      return free.length >= 2 ? free[seat].slice() : null;
    }
    return {initial, position};
  }

  function validatePublication(world,scene,vehicleRoot,point,needsCar){
    // Legacy publications without an authored arrival only need vehicle identity.
    const start=point || window.MundoCircuit.readGrid(world)?
      window.MundoDriving.roomStart(world,scene,vehicleRoot):{car:window.MundoDriving.roomCar(scene,vehicleRoot)};
    if(needsCar && !start.car)throw Error("El circuito de práctica necesita un turismo de sala disponible.");
    if(point)plan(start.road,start.car,point);
  }

  function preview(scene, vehicleRoot, point) {
    const car = window.MundoDriving.roomCar(scene, vehicleRoot);
    const terrain = car ? scene.objects.filter(obj => !car.partIds.has(obj.n.id)) : scene.objects;
    return plan(new window.MundoWalk(terrain, false), car, point).initial;
  }
  return Object.freeze({preview, plan, overlapsPlayer, validatePublication});
})();
