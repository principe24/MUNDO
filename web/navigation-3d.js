"use strict";
(() => {

// Feet are in world metres (+Y up). Static collision uses the world-space
// bounds of physical shapes, as in MundoWalk. Decorative meshes have no proxy.
const EPS = 1e-8;
const RANGE = 1e8;
const MAX_SPAN = 32;
const MAX_OBSTACLES = 128;
const OUT_OF_WORK = Symbol("navigation work budget");
const directions = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]];

function vector(value, count) {
  return Array.isArray(value) && value.length === count &&
    value.every(v => Number.isFinite(v) && Math.abs(v) <= RANGE);
}

function option(value, fallback, low, high) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < low || value > high) throw new RangeError("Perfil de navegación inválido.");
  return value;
}

function budget(units) {
  return cost => { units -= cost; if (units < 0) throw OUT_OF_WORK; };
}

// One proxy occupies at most four buckets. Giant ground planes and distant
// small props can coexist without populating a grid across the whole map.
class CollisionIndex {
  constructor(objects) {
    this.levels = new Map();
    for (const object of objects) {
      if (!object.n.shape) continue;
      const {center, extent} = object;
      const min = center.map((v,i) => v - extent[i]);
      const max = center.map((v,i) => v + extent[i]);
      if (!min.every(Number.isFinite) || !max.every(Number.isFinite) ||
          [0,2].some(i => max[i] < -RANGE - 3 || min[i] > RANGE + 3)) continue;
      const span = Math.max(4, max[0] - min[0], max[2] - min[2]);
      const size = 2 ** Math.ceil(Math.log2(span));
      let buckets = this.levels.get(size);
      if (!buckets) this.levels.set(size, buckets = new Map());
      const box = {min,max};
      for (let x = Math.floor(Math.max(-RANGE-3,min[0])/size); x <= Math.floor(Math.min(RANGE+3,max[0])/size); ++x) {
        for (let z = Math.floor(Math.max(-RANGE-3,min[2])/size); z <= Math.floor(Math.min(RANGE+3,max[2])/size); ++z) {
          const key = x + "," + z;
          let bucket = buckets.get(key);
          if (!bucket) buckets.set(key, bucket = []);
          bucket.push(box);
        }
      }
    }
  }

  query(left, right, back, front, spend) {
    const found = new Set();
    for (const [size,buckets] of this.levels) {
      for (let x = Math.floor(left/size); x <= Math.floor(right/size); ++x) {
        for (let z = Math.floor(back/size); z <= Math.floor(front/size); ++z) {
          const bucket = buckets.get(x + "," + z);
          spend(1 + (bucket?.length ?? 0));
          if (!bucket) continue;
          for (const box of bucket) {
            if (box.min[0] <= right && box.max[0] >= left &&
                box.min[2] <= front && box.max[2] >= back) found.add(box);
          }
        }
      }
    }
    return [...found];
  }
}

class Frontier {
  constructor() { this.items = []; }
  push(node) {
    const items = this.items;
    let i = items.length;
    items.push(node);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].priority <= node.priority) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = node;
  }
  pop() {
    const items = this.items, first = items[0], last = items.pop();
    if (!items.length) return first;
    let i = 0;
    while (2*i + 1 < items.length) {
      let child = 2*i + 1;
      if (child + 1 < items.length && items[child+1].priority < items[child].priority) ++child;
      if (last.priority <= items[child].priority) break;
      items[i] = items[child];
      i = child;
    }
    items[i] = last;
    return first;
  }
}

function dynamicObstacles(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OBSTACLES ||
      !value.every(b => b && vector(b.min,3) && vector(b.max,3) && b.min.every((v,i) => v <= b.max[i]))) return null;
  return value;
}

function overlap(box, x, z, radius) {
  return x + radius > box.min[0] && x - radius < box.max[0] &&
         z + radius > box.min[2] && z - radius < box.max[2];
}

// A usable support covers an area under the centre, including shared edges.
// A pair of platforms touching at a single diagonal corner is not a bridge.
function supportsCentre(solid,x,z,low,high) {
  let sectors = 0;
  for (const b of solid) {
    if (b.max[1] < low-EPS || b.max[1] > high+EPS ||
        x < b.min[0]-EPS || x > b.max[0]+EPS || z < b.min[2]-EPS || z > b.max[2]+EPS) continue;
    const left=x>b.min[0]+EPS, right=x<b.max[0]-EPS;
    const back=z>b.min[2]+EPS, front=z<b.max[2]-EPS;
    sectors |= (left && back ? 1:0) | (right && back ? 2:0) |
               (right && front ? 4:0) | (left && front ? 8:0);
    if ((sectors & ((sectors << 1) | (sectors >> 3))) !== 0) return true;
  }
  return false;
}

// Find the time interval during which a line crosses the (expanded) footprint.
// These exact events partition the segment into intervals of constant occupancy.
// A narrow wall or gap therefore cannot fall between fixed-distance samples.
function crossings(box, radius, x, z, dx, dz, events) {
  let enter = 0, exit = 1;
  for (const [i,origin,delta] of [[0,x,dx],[2,z,dz]]) {
    const low = box.min[i]-radius, high = box.max[i]+radius;
    if (delta === 0) { if (origin < low || origin > high) return; }
    else {
      const a = (low-origin)/delta, b = (high-origin)/delta;
      enter = Math.max(enter,Math.min(a,b));
      exit = Math.min(exit,Math.max(a,b));
      if (enter > exit) return;
    }
  }
  events.push(enter,exit);
}

function createNavigation(objects, profile = {}) {
  const radius = option(profile.radius, 0.28, 0.02, 2);
  const height = option(profile.height, 1.68, 0.2, 5);
  const step = option(profile.maxStep, 0.26, 0, height/2);
  const drop = option(profile.maxDrop, 0.48, 0, height/2);
  const cell = option(profile.cellSize, 0.8, 0.1, 4);
  const snap = option(profile.snap, 0.65, 0, 2);
  const index = new CollisionIndex(objects);

  function levelAt(x,z,y,up,down,solid,moving,spend) {
    spend(1 + 3*solid.length + moving.length);
    let level = -Infinity;
    // All candidates within the permitted step/drop band are closer than
    // body height for normal walkers. The highest touching support is decisive.
    for (const b of solid) {
      const top = b.max[1];
      if (top > level && top >= y-down-EPS && top <= y+up+EPS && overlap(b,x,z,radius)) level = top;
    }
    if (!Number.isFinite(level)) return null;
    // The body may straddle a stair edge, but its centre must have support
    // below it. A global fallback floor would join isolated platforms.
    if (!supportsCentre(solid,x,z,level-Math.max(step,drop),level)) return null;
    const hits = b => overlap(b,x,z,radius) && b.max[1] > level+EPS && b.min[1] < level+height-EPS;
    if (solid.some(hits) || moving.some(hits)) return null;
    return [x,level,z];
  }

  function projectInner(feet,moving,spend) {
    const [x,y,z] = feet;
    const solid = index.query(x-radius,x+radius,z-radius,z+radius,spend);
    return levelAt(x,z,y,snap,snap,solid,moving,spend);
  }

  function sweep(from,x,z,moving,spend) {
    const dx = x-from[0], dz = z-from[2];
    if (Math.hypot(dx,dz) > MAX_SPAN) return null;
    const left = Math.min(x,from[0])-radius, right = Math.max(x,from[0])+radius;
    const back = Math.min(z,from[2])-radius, front = Math.max(z,from[2])+radius;
    const solid = index.query(left,right,back,front,spend);
    const near = moving.filter(b => b.min[0] <= right && b.max[0] >= left && b.min[2] <= front && b.max[2] >= back);
    spend(moving.length);
    const events = [0,1];
    for (const b of solid) {
      crossings(b,0,from[0],from[2],dx,dz,events);
      crossings(b,radius,from[0],from[2],dx,dz,events);
    }
    for (const b of near) crossings(b,radius,from[0],from[2],dx,dz,events);
    spend(events.length);
    events.sort((a,b) => a-b);
    let feet = levelAt(from[0],from[2],from[1],0,0,solid,near,spend);
    if (!feet) return null;
    let last = 0;
    for (const end of events) {
      if (end <= last) continue;
      const middle = (last+end)*0.5;
      feet = levelAt(from[0]+middle*dx,from[2]+middle*dz,feet[1],step,drop,solid,near,spend);
      if (!feet) return null;
      feet = levelAt(end===1?x:from[0]+end*dx,end===1?z:from[2]+end*dz,feet[1],step,drop,solid,near,spend);
      if (!feet) return null;
      last = end;
    }
    return feet;
  }

  function bounded(call) {
    try { return call(budget(100000)); }
    catch (error) { if (error === OUT_OF_WORK) return null; throw error; }
  }

  function project(feet, options = {}) {
    const moving = dynamicObstacles(options.obstacles);
    if (!moving || !vector(feet,3)) return null;
    return bounded(spend => projectInner(feet,moving,spend));
  }

  function advance(from,toXZ,options = {}) {
    const moving = dynamicObstacles(options.obstacles);
    if (!moving || !vector(from,3) || !vector(toXZ,2)) return null;
    return bounded(spend => sweep(from,toXZ[0],toXZ[1],moving,spend));
  }

  function canTraverse(from,to,options = {}) {
    if (!vector(to,3)) return false;
    const end = advance(from,[to[0],to[2]],options);
    return !!end && Math.abs(end[1]-to[1]) <= EPS;
  }

  function plan(from,to,options = {}) {
    let visited = 0;
    const failure = status => ({status,points:[],visited});
    const moving = dynamicObstacles(options.obstacles);
    const maxNodes = options.maxNodes ?? 1800;
    if (!moving || !vector(from,3) || !vector(to,3) || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 8192)
      return failure("invalid");
    const spend = budget(Math.min(500000,Math.max(1024,maxNodes*360)));
    try {
      const start = projectInner(from,moving,spend), goal = projectInner(to,moving,spend);
      if (!start || !goal) return failure("unreachable");
      const distance = (x,z) => Math.hypot(x-goal[0],z-goal[2]);
      const frontier = new Frontier(), costs = new Map();
      function enqueue(i,j,feet,cost,parent) {
        const key = i + "," + j + "," + feet[1];
        if ((costs.get(key) ?? Infinity) <= cost+EPS) return;
        costs.set(key,cost);
        frontier.push({key,i,j,feet,cost,parent,priority:cost+distance(feet[0],feet[2])});
      }
      enqueue(0,0,start,0,null);
      while (frontier.items.length) {
        const node = frontier.pop();
        if (node.cost !== costs.get(node.key)) continue;
        if (visited >= maxNodes) return failure("budget");
        ++visited;
        const p = node.feet;
        if (distance(p[0],p[2]) <= (node.parent ? cell*Math.SQRT2+EPS : MAX_SPAN)) {
          const end = sweep(p,goal[0],goal[2],moving,spend);
          if (end && Math.abs(end[1]-goal[1]) <= EPS) {
            const points = [];
            if (p.some((v,i) => v !== goal[i])) points.push(goal);
            for (let current=node; current; current=current.parent) points.push(current.feet);
            return {status:"ok",points:points.reverse(),visited};
          }
        }
        for (const [di,dj] of directions) {
          const i = node.i+di, j = node.j+dj;
          const x = start[0]+i*cell, z = start[2]+j*cell;
          if (Math.abs(x)>RANGE || Math.abs(z)>RANGE) continue;
          const feet = sweep(p,x,z,moving,spend);
          if (feet) enqueue(i,j,feet,node.cost+Math.hypot(di,dj)*cell+Math.abs(feet[1]-p[1]),node);
        }
      }
      return failure("unreachable");
    } catch (error) {
      if (error === OUT_OF_WORK) return failure("budget");
      throw error;
    }
  }
  return {project,advance,canTraverse,plan};
}

const api = Object.freeze({createNavigation});
if (typeof module === "object" && module.exports) module.exports = api;
else window.MundoNavigation3D = api;
})();
