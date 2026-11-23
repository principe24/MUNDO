"use strict";

// Host simulation. Coordinates are feet in metres in the active scene.
// Actor ids belong to scene entities; seats are only observations and never command actors.
const NPC_STATES = Object.freeze(["patrol", "waiting", "follow", "return", "blocked", "idle"]);
const STEP = 0.05;
const MAX_STEPS = 5;
const MAX_NPCS = 8;
const NOTICE = 8;
const LEASH = 12;
const STOP = 1.15;
const EPSILON = 1e-6;
const MAX_ID = 18446744073709551615n;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const point = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

function bodyBox(p) {
  return {min: [p[0] - .28, p[1], p[2] - .28], max: [p[0] + .28, p[1] + 1.68, p[2] + .28]};
}

function newActor(definition) {
  const {id, mode, points, speed = 2.4, waitSeconds = .5} = definition;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > MAX_ID ||
      !["patrol", "follow"].includes(mode) || !Array.isArray(points) ||
      !points.length || points.length > 33 || !points.every(point) ||
      !Number.isFinite(speed) || speed < .25 || speed > 6 ||
      !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) {
    throw new Error("Definición de NPC inválida.");
  }
  return {id, mode, points: points.map(p => p.slice()), speed, waitTicks: Math.ceil(waitSeconds / STEP),
    index: points.length > 1 ? 1 : 0, feet: null, yaw: 0, state: "idle", seat: null,
    key: "", route: null, cursor: 0, target: null, retry: 0, dwell: 0, completed: false, budget: 384};
}

function choosePlayer(actor, players) {
  const home = actor.points[0];
  const current = players.find(p => p.id === actor.seat);
  // Retain the current seat until it leaves the larger radius. A newcomer cannot
  // cause two followers to change their minds each time player positions cross.
  if (current && distance(home, current.position) <= LEASH && distance(actor.feet, current.position) <= LEASH) {
    return current;
  }
  let winner = null, best = NOTICE;
  for (const p of players) {
    const d = distance(actor.feet, p.position);
    if (distance(home, p.position) <= LEASH && (d < best || (d === best && (!winner || p.id < winner.id)))) {
      winner = p;
      best = d;
    }
  }
  return winner;
}

class NpcSimulation {
  constructor(navigation, definitions, {obstacles = []} = {}) {
    if (!Array.isArray(definitions) || definitions.length > MAX_NPCS) throw Error("Demasiados NPC en la sala.");
    this.navigation = navigation;
    this.actors = definitions.map(newActor);
    if (new Set(this.actors.map(a => a.id)).size !== this.actors.length) throw Error("Identificador de NPC repetido.");
    this.tick = 0;
    this.remainder = 0;
    this.first = 0;
    for (const actor of this.actors) this.spawn(actor, this.obstaclesFor(actor, obstacles, []));
  }

  obstaclesFor(actor, solids, players, except = null) {
    const list = solids.slice();
    for (const other of this.actors) if (other !== actor && other.feet) list.push(bodyBox(other.feet));
    for (const p of players) if (p.id !== except) list.push(bodyBox(p.position));
    return list;
  }

  spawn(actor, obstacles) {
    actor.feet = this.navigation.project(actor.points[0], {obstacles});
    actor.retry = actor.feet ? this.tick : this.tick + 20;
    if (actor.feet && actor.mode === "patrol" && actor.points.length > 1) {
      actor.dwell = this.tick + actor.waitTicks;
      actor.state = actor.waitTicks ? "waiting" : "patrol";
    }
  }

  advance(elapsedSeconds, {players = [], obstacles = []} = {}) {
    if (!this.actors.length || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;
    const activePlayers = players.filter(p => p && (p.id === 0 || p.id === 1) && point(p.position));
    // Discard long host pauses rather than teleporting characters through a scene.
    this.remainder += Math.min(elapsedSeconds, STEP * MAX_STEPS);
    const steps = Math.min(MAX_STEPS, Math.floor((this.remainder + 1e-9) / STEP));
    this.remainder = Math.max(0, this.remainder - steps * STEP);
    for (let i = 0; i < steps; i++) {
      this.tick++;
      let canPlan = true;
      const first = this.first;
      for (let k = 0; k < this.actors.length; k++) {
        const index = (first + k) % this.actors.length;
        if (this.step(this.actors[index], activePlayers, obstacles, canPlan)) {
          canPlan = false;
          this.first = (index + 1) % this.actors.length;
        }
      }
    }
  }

  step(actor, players, solids, canPlan) {
    if (!actor.feet) {
      if (this.tick >= actor.retry) this.spawn(actor, this.obstaclesFor(actor, solids, players));
      return false;
    }
    if (actor.dwell > this.tick) return false;
    if (actor.mode === "patrol" && actor.points.length === 1) {
      actor.state = "idle";
      return false;
    }
    const player = actor.mode === "follow" ? choosePlayer(actor, players) : null;
    actor.seat = player?.id ?? null;
    const behavior = actor.mode === "patrol" ? "patrol" : player ? "follow" : "return";
    const goal = player ? player.position : actor.points[behavior === "patrol" ? actor.index : 0];
    const key = behavior + "/" + (player ? player.id : actor.index);
    if (actor.key !== key) {
      actor.key = key;
      actor.route = null;
      actor.target = null;
      actor.completed = false;
      actor.retry = 0;
      actor.budget = 384;
    }
    const obstacles = this.obstaclesFor(actor, solids, players, player?.id);
    if (player && distance(actor.feet, goal) <= STOP && this.navigation.canTraverse(actor.feet, goal, {obstacles})) {
      actor.state = "idle";
      actor.route = null;
      actor.completed = false;
      return false;
    }
    // An idle follower resumes when its companion leaves the stopping radius.
    // A returning follower already home has no reason to request a new path.
    if (actor.completed && behavior === "return") return false;
    if (player && actor.target && distance(goal, actor.target) > .55 && this.tick >= actor.retry) actor.route = null;
    let planned = false;
    if (!actor.route) {
      if (!canPlan || this.tick < actor.retry) return false;
      const result = this.navigation.plan(actor.feet, goal, {obstacles, maxNodes: actor.budget});
      planned = true;
      if (result.status !== "ok" || !result.points.length) {
        actor.state = "blocked";
        actor.retry = this.tick + 20;
        if (result.status === "budget") actor.budget = Math.min(3072, actor.budget * 2);
        return planned;
      }
      actor.route = result.points;
      actor.cursor = result.points.length > 1 ? 1 : 0;
      actor.target = goal.slice();
      actor.retry = this.tick + 10;
      actor.budget = 384;
    }
    // The target seat is excluded from the goal search so its feet remain a valid
    // destination. Its body is still solid to the actual movement, as are the car
    // and the other agents. A newly blocked segment invalidates the old route.
    const motionObstacles = player ? [...obstacles, bodyBox(player.position)] : obstacles;
    actor.state = behavior;
    let remaining = actor.speed * STEP;
    while (remaining > EPSILON && actor.cursor < actor.route.length) {
      const next = actor.route[actor.cursor];
      const dx = next[0] - actor.feet[0], dz = next[2] - actor.feet[2];
      const length = Math.hypot(dx, dz);
      if (length <= EPSILON) {
        if (Math.abs(next[1] - actor.feet[1]) > EPSILON) {
          this.block(actor);
          return planned;
        }
        actor.cursor++;
        continue;
      }
      const amount = Math.min(remaining, length), fraction = amount / length;
      const x = actor.feet[0] + dx * fraction, z = actor.feet[2] + dz * fraction;
      const ground = this.navigation.advance(actor.feet, [x, z], {obstacles: motionObstacles});
      if (!ground || (amount === length && Math.abs(ground[1] - next[1]) > EPSILON)) {
        this.block(actor);
        return planned;
      }
      actor.feet = ground;
      actor.yaw = Math.atan2(dx, -dz);
      remaining -= amount;
      if (amount === length) actor.cursor++;
    }
    if (actor.cursor >= actor.route.length) this.arrive(actor, behavior);
    return planned;
  }

  block(actor) {
    actor.route = null;
    actor.state = "blocked";
    actor.retry = this.tick + 5;
  }

  arrive(actor, behavior) {
    actor.route = null;
    if (behavior === "patrol") {
      actor.index = (actor.index + 1) % actor.points.length;
      actor.dwell = this.tick + actor.waitTicks;
      actor.state = actor.waitTicks ? "waiting" : "patrol";
    } else {
      actor.completed = true;
      actor.state = "idle";
      actor.retry = this.tick + 10;
    }
  }

  snapshot() {
    // Never expose route definitions, player identities, credentials or references
    // to mutable host coordinates. An unsupported spawn is absent until supported.
    return this.actors.filter(a => a.feet).map(a => ({id: a.id, position: a.feet.slice(), yaw: a.yaw, state: a.state}));
  }
}

module.exports = {NPC_STATES, NpcSimulation};
