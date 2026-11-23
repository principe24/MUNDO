"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {readProject,ProjectTravel,ordinary,sceneCheckpoint,restoreSceneCheckpoint}=require("../server/project-room.cjs");
const {makeRoom}=require("../server/room.cjs");
const {MundoWorld}=require("../server/room-runtime.cjs");
const {courtyard,garden,projectBytes}=require("../examples/navigation/generate.cjs");
const {readFile,mkdtemp,writeFile,rm}=require("node:fs/promises");
const path=require("node:path"),os=require("node:os");

function openTravel(project){return new ProjectTravel(project,[{id:0,player:null},{id:1,player:null}],()=>1000);}
function publicData(value){return JSON.parse(JSON.stringify(value));}
function simulate(scene,steps){for(let i=0;i<steps;i++)scene.npcs.advance(.05);}

test("parking a world and recovering the full project preserve waypoint, position and dwell",async()=>{
  const project=await readProject(await projectBytes(courtyard(),garden()));
  const travel=openTravel(project);
  assert.equal(travel.active.def.entry.npcCount,1);
  simulate(travel.active,25);
  const before=travel.active.npcs.checkpoint(),origin=travel.active;
  const seat=travel.live[0],body=origin.vehicle.newBody(0,true);
  seat.player={body,seen:1000,scene:"ready",lease:"saved-seat",keys:new Set()};
  travel.attach(seat);
  travel.begin(2);assert.ok(travel.offer);
  travel.vote(seat,{vote:"ready",epoch:travel.offer.epoch});
  assert.equal(travel.active.def.entry.id,2);
  assert.deepEqual(publicData(travel.prepare(origin.def).npcs.checkpoint()),publicData(before));
  const data=publicData(travel.checkpoint(1100));
  const fresh=openTravel(project);
  assert.equal(fresh.restoreCheckpoint(data,7000),true);
  assert.deepEqual(publicData(fresh.prepare(origin.def).npcs.checkpoint()),publicData(before));
  const previous=publicData(fresh.checkpoint(7100));
  data.worlds[1].npcs.actors[0].index=9999;
  assert.equal(fresh.restoreCheckpoint(data,8000),false);
  assert.deepEqual(publicData(fresh.checkpoint(7100)),previous);
});

test("older checkpoints load without NPC fields and a different revision cannot install NPC state",()=>{
  const {world}=courtyard(),bytes=MundoWorld.encode(world);
  const make=()=>ordinary(bytes,"Patio",null,null,null);
  const a=make(),b=make();simulate(a,25);
  const saved=publicData(sceneCheckpoint(a,1000));
  const old={...saved}; delete old.npcs;
  assert.equal(restoreSceneCheckpoint(b,old,2000),true);
  assert.equal(restoreSceneCheckpoint(b,{...saved,revision:"0".repeat(64)},2000),false);
  assert.equal(restoreSceneCheckpoint(b,saved,2000),true);
  assert.deepEqual(publicData(b.npcs.checkpoint()),saved.npcs);
});

// Real filesystem payload, with a single-process store instead of the target OS seat lock.
test("an NPC-only session uses room recovery across close and reopen",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"mundo-npc-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"session.json");
  const store=()=>({
    writable:true,state:"empty",pending:null,status(){return {state:this.state,savedAt:null};},
    async open(){try{const data=JSON.parse(await readFile(file,"utf8"));this.state="saved";return data;}
      catch(error){if(error.code==="ENOENT")return null;throw error;}},
    markInvalid(){throw Error("invalid checkpoint");},
    offer(data){this.pending=JSON.stringify(data);return true;},
    async flush(){if(this.pending)await writeFile(file,this.pending);this.state="saved";return true;},
    async close(){return this.flush();}
  });
  const bytes=MundoWorld.encode(courtyard().world);
  let now=0;
  const room=()=>makeRoom(bytes,"Patio",()=>now,null,null,null,null,store());
  const first=room();await first.beginSession();
  assert.ok(first.moderation.status().checkpoint.canSave);
  const seat=first.authorize(first.seats[0].invite,"a".repeat(48),true);
  for(let i=0;i<25;i++){now+=50;first.advance();}
  const cmd={seq:1,mask:0,yaw:0,jump:false};
  const positions=r=>r.npcs.map(p=>[p.id,...p.position,p.yaw]);
  const old=positions(first.input(seat,cmd,"ready",true));
  assert.equal((await first.endSession()).checkpoint.state,"saved");
  const recovered=room();await recovered.beginSession();
  assert.ok(recovered.moderation.status().checkpoint.restored);
  const next=recovered.authorize(recovered.seats[0].invite,"b".repeat(48),true);
  assert.deepEqual(positions(recovered.input(next,cmd,"ready",true)),old);
  now+=100;recovered.advance();
  assert.notDeepEqual(positions(recovered.input(next,cmd,"ready",true)),old);
  await recovered.endSession();
});
