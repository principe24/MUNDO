"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const {createNavigation} = require("../server/navigation-3d.cjs");

function box(min,max,shape=1) {
  return {n:{shape},center:min.map((v,i)=>(v+max[i])/2),extent:min.map((v,i)=>(max[i]-v)/2)};
}
const floor = (x0,z0,x1,z1,y=0) => box([x0,y-0.2,z0],[x1,y,z1]);
const platform = floor(-6,-5,6,5);
function assertRoute(nav,start,goal,options) {
  const route=nav.plan(start,goal,options);
  assert.equal(route.status,"ok",JSON.stringify(route));
  assert.deepEqual(route.points[0],nav.project(start,options));
  assert.deepEqual(route.points.at(-1),nav.project(goal,options));
  for(let i=1;i<route.points.length;i++) {
    const a=route.points[i-1], b=route.points[i];
    assert.equal(nav.canTraverse(a,b,options),true);
    // Follow the same route at sub-cell increments, as the authoritative tick does.
    let feet=a;
    const count=Math.max(1,Math.ceil(Math.hypot(a[0]-b[0],a[2]-b[2])/0.075));
    for(let s=1;s<=count;s++) {
      const t=s/count;
      feet=nav.advance(feet,[a[0]+(b[0]-a[0])*t,a[2]+(b[2]-a[2])*t],options);
      assert.ok(feet,"continuous grounded movement must succeed on every returned edge");
    }
    assert.ok(Math.abs(feet[1]-b[1])<1e-7);
  }
  return route;
}

test("direct grounded route preserves unsnapped XZ and ignores decorative shapes",()=>{
  const nav=createNavigation([platform,box([0,0,-5],[1,2,5],0)]);
  const route=assertRoute(nav,[-3.12,.15,-1.34],[2.51,.16,3.04]);
  assert.equal(route.points.length,2);
  assert.deepEqual(nav.plan([.5,0,.5],[.5,0,.5]).points,[[.5,0,.5]]);
  assert.equal(nav.project([0,3,0]),null);
});
test("thin obstacle forces a reproducible detour and every returned edge is traversable",()=>{
  const nav=createNavigation([platform,box([0,0,-2],[.008,4,2])]);
  assert.equal(nav.canTraverse([-4,0,0],[4,0,0]),false);
  const route=assertRoute(nav,[-4,0,0],[4,0,0]);
  assert.ok(route.points.some(p=>Math.abs(p[2])>2.28));
  assert.deepEqual(nav.plan([-4,0,0],[4,0,0]),route);
});
test("a narrow wall-to-wall slit and a diagonal wall corner do not pass the footprint",()=>{
  const nav=createNavigation([floor(-4,-4,4,4),
    box([-.1,0,-4],[.1,3,-.24]),box([-.1,0,.24],[.1,3,4])]);
  assert.equal(nav.plan([-2,0,0],[2,0,0]).status,"unreachable");
  const corner=createNavigation([platform,box([0,0,-6],[1,2,0]),box([-6,0,0],[0,2,1])]);
  assert.equal(corner.canTraverse([-1,0,-1],[1,0,1]),false);
});
test("unsupported slits and diagonal-only platform contact have no route",()=>{
  const gap=createNavigation([floor(-4,-2,0,2),floor(.008,-2,4,2)]);
  assert.equal(gap.canTraverse([-2,0,0],[2,0,0]),false);
  assert.equal(gap.plan([-2,0,0],[2,0,0]).status,"unreachable");
  const touching=createNavigation([floor(-3,-3,0,0),floor(0,0,3,3)]);
  assert.equal(touching.canTraverse([-2,0,-2],[2,0,2]),false);
  assert.equal(touching.plan([-2,0,-2],[2,0,2]).status,"unreachable");
});
test("stacked decks stay distinct without stairs and a ceiling controls headroom",()=>{
  const nav=createNavigation([platform,floor(-4,-3,4,3,2)]);
  assertRoute(nav,[-3,0,0],[3,0,0]);
  assertRoute(nav,[-3,2,0],[3,2,0]);
  assert.equal(nav.canTraverse([0,0,0],[0,2,0]),false);
  assert.equal(nav.plan([0,0,0],[0,2,0]).status,"unreachable");
  const tunnel=createNavigation([platform,box([-.5,1.64,-5],[.5,1.9,5])]);
  assert.equal(tunnel.plan([-2,0,0],[2,0,0]).status,"unreachable");
});
test("stairs change layers in both directions; max drop is directional",()=>{
  const nav=createNavigation([floor(-3,-1,0,1),floor(0,-1,.9,1,.2),floor(.9,-1,1.8,1,.4),floor(1.8,-1,4,1,.6)]);
  assertRoute(nav,[-2,0,0],[3,.6,0]); assertRoute(nav,[3,.6,0],[-2,0,0]);
  const ledge=createNavigation([floor(-2,-1,0,1,.4),floor(0,-1,2,1)]);
  assert.equal(ledge.plan([1,0,0],[-1,.4,0]).status,"unreachable");
  assertRoute(ledge,[-1,.4,0],[1,0,0]);
  const high=createNavigation([floor(-2,-1,0,1,.65),floor(0,-1,2,1)]);
  assert.equal(high.plan([-1,.65,0],[1,0,0]).status,"unreachable");
});
test("dynamic occupancy never becomes support and removal reopens a route",()=>{
  const nav=createNavigation([floor(-4,-1,4,1)]);
  const obstacles=[{min:[0,0,-1],max:[.2,1.7,1]}];
  assert.equal(nav.plan([-2,0,0],[2,0,0],{obstacles}).status,"unreachable");
  assert.equal(nav.project([.1,1.7,0],{obstacles}),null);
  assertRoute(nav,[-2,0,0],[2,0,0]);
});
test("large ground does not require a dense map; bounded searches distinguish exhaustion",()=>{
  const nav=createNavigation([floor(-2e6,-2e6,2e6,2e6),box([0,0,-5],[1,3,5])]);
  const result=nav.plan([-4,0,0],[4,0,0],{maxNodes:1});
  assert.deepEqual(result,{status:"budget",points:[],visited:1});
  assertRoute(nav,[99999,0,-99999],[99998,0,-100000]);
  for (const start of [[NaN,0,0],[Infinity,0,0],[],null]) assert.equal(nav.plan(start,[0,0,0]).status,"invalid");
  assert.equal(nav.plan([0,0,0],[1,0,1],{obstacles:[{}]}).status,"invalid");
  assert.equal(nav.plan([0,0,0],[1,0,1],{maxNodes:0}).status,"invalid");
  const dense=createNavigation(Array(6000).fill(platform));
  assert.equal(dense.plan([0,0,0],[1,0,1],{maxNodes:1}).status,"budget");
});
test("a kilometre-long open route uses bounded, continuously validated segments",()=>{
  const nav=createNavigation([floor(-1010,-10,1010,20)]);
  const route=nav.plan([-531,0,2],[654,.1,9],{maxNodes:16});
  assert.equal(route.status,"ok");
  assert.equal(route.visited,1);
  assert.ok(route.points.length>30);
  for(let i=1;i<route.points.length;i++) {
    const a=route.points[i-1], b=route.points[i];
    assert.ok(Math.hypot(a[0]-b[0],a[2]-b[2])<=32);
    assert.equal(nav.canTraverse(a,b),true);
  }
});
test("long corridors detour around an interior wall and never cross a sealed barrier",()=>{
  const floorBox=floor(-200,-5,200,5);
  const a=[-140,0,0],b=[128,0,0];
  const detour=createNavigation([floorBox,box([.01,0,-2],[.02,4,2])]);
  const route=assertRoute(detour,a,b,{maxNodes:600});
  assert.ok(route.points.some(p=>Math.abs(p[2])>2.28));
  const closed=createNavigation([floorBox,box([.01,0,-5],[.02,4,5])]);
  const rejected=closed.plan(a,b,{maxNodes:600});
  assert.notEqual(rejected.status,"ok");
  assert.deepEqual(rejected.points,[]);
});
