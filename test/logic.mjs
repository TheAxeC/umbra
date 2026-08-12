// Headless checks for everything in the game that is not the GPU or the synth.
//
//   node test/logic.mjs        (or npm test)
//
// The game is one HTML file with an inline module script, so there is nothing
// to import. Rather than duplicate the logic here, which would rot within a
// day, this reads index.html, cuts out the section of the script that contains
// the game logic, and evaluates it. The checks below run the code that ships.
//
// The cut runs from the first map constant to the comment that introduces the
// shader. Everything in that range is kept free of DOM and WebGPU
// references at module level, which is what makes it evaluable under Node; the
// setup and frame loop below the shader are not included and are not tested
// here. Both markers are ordinary source text, so if someone reorganises
// index.html this throws rather than silently testing half a file.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = src.indexOf("const MAP_SIZE");
const end = src.indexOf("// Shader. Fullscreen triangle");
if (start < 0 || end < 0 || end < start) throw new Error("could not locate the logic block");
const block = src.slice(start, end);

// The globals the block touches while it evaluates. It registers keyboard
// listeners at top level, which is all addEventListener and document are for.
//
// window is present but empty, which is not a hack to get the file to run: it
// is the shape of a browser with no WebAudio. initAudio reads
// window.AudioContext, finds nothing, and returns without building a graph, and
// the audio checks near the bottom of this file assert that every sound is then
// a silent no-op rather than a crash. Gameplay calls those functions on every
// shot and every footstep, so that path has to hold.
//
// localStorage is absent for the same reason: settings must survive a browser
// that refuses to store them.
globalThis.addEventListener = () => {};
globalThis.window = {};
globalThis.document = { addEventListener: () => {} };

// new Function gives the block its own scope, and the appended return statement
// is the only way to reach inside it. Everything the checks touch has to be
// named here, which is verbose but keeps the game itself free of test hooks:
// index.html exports nothing and knows nothing about being tested. The getters
// read bindings that are reassigned at runtime, so they have to be closures
// rather than values captured once.
const scope = new Function(block + `
return {
  MAP_SIZE, SOLID, LOW, DOORBIT, RADIUS, EPS,
  solidAt, opaqueAt, carve, setBit, clearBit, bitAt, fits, axisStop, castWall,
  camera, keys, update, WALK, RUN, settings, DIFFICULTY, degreesToFov, fovToDegrees,
  S_MENU, S_PLAY, S_PAUSE, S_DEAD, S_CLEAR, setState,
  player, WEAPONS, selectWeapon, fire, hurtPlayer, hurtFromDirection, wakeFoes,
  FOE_R, FOE_KIND, MAX_FOES, MAX_PICKUPS, MAX_SHOTS, MAX_PARTS, MAX_DOORS,
  updateFoes, updateEffects, updateShots, updatePickups, updateDoors, updateParts,
  spawnShot, spawnPart, takePickup, tryOpenDoors, damageFoe, seesPlayer,
  generate, buildLevel, openCells, chokepoints, regionFrom, spawnFoes, restart,
  START, FOE_SPAWNS, BASE_SEED, ROOMS, cleared, exitAt, reachedExit, updateArena,
  buildFlow, flowStep, FLOW, spawnDecal, MAX_DECALS, recordBest, FOE_INDEX,
  BASS_A, BASS_B, ARP, LEAD, KICK, SNARE, HAT, PROG_A, PROG_B, STEPS, ROOT, BPM, BARS, SWING,
  noteHz, toggleMute, initAudio, applyVolume,
  sfxShoot, sfxImpHit, sfxImpDie, sfxGrowl, sfxSwing, sfxHurt, sfxDie, sfxClear,
  sfxStep, sfxCast, sfxExplode, sfxPickup, sfxDoor, sfxLocked, sfxSwitch, sfxDryFire,
  getFoes: () => foes, getShots: () => shots, getParts: () => parts,
  getPickups: () => pickups, getDoors: () => doors,
  getLevel: () => level, setLevel: (n) => { level = n; },
  getArena: () => arena, getDecals: () => decals, getBest: () => best,
  getState: () => state, getMuted: () => muted, getAudio: () => audio,
};`)();

const {
  MAP_SIZE, SOLID, LOW, DOORBIT, RADIUS, solidAt, opaqueAt, carve, setBit, bitAt,
  fits, castWall, camera, keys, update, WALK, RUN, settings, DIFFICULTY,
  degreesToFov, fovToDegrees, S_MENU, S_PLAY, S_DEAD, S_CLEAR, setState,
  player, WEAPONS, selectWeapon, fire, hurtPlayer, wakeFoes, FOE_R, FOE_KIND,
  MAX_FOES, MAX_PARTS, MAX_DOORS, updateFoes, updateEffects, updateShots,
  updatePickups, updateDoors, updateParts, spawnShot, spawnPart, takePickup,
  tryOpenDoors, damageFoe, generate, buildLevel, openCells, regionFrom,
  spawnFoes, restart, START, FOE_SPAWNS, BASE_SEED, cleared, exitAt, reachedExit,
  updateArena, buildFlow, flowStep, spawnDecal, MAX_DECALS, recordBest, FOE_INDEX,
  BASS_A, BASS_B, ARP, LEAD, KICK, SNARE, HAT, PROG_A, PROG_B, STEPS, ROOT, BPM, SWING,
  noteHz, toggleMute, initAudio, sfxShoot, sfxImpHit, sfxImpDie, sfxGrowl,
  sfxSwing, sfxHurt, sfxDie, sfxClear, sfxStep, sfxCast, sfxExplode, sfxPickup,
  sfxDoor, sfxLocked, sfxSwitch, sfxDryFire,
  getFoes, getShots, getParts, getPickups, getDoors, getLevel, setLevel,
  getState, getMuted, getAudio, getArena, getDecals, getBest,
} = scope;

// Detail is printed on failure only, and is usually the offending number. A
// check that fails without saying what it saw costs another run to diagnose.
let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok   " + name); }
  else { console.log("  FAIL " + name + (detail ? "  " + detail : "")); failures++; }
}

function fill(cx, cy) { setBit(SOLID, cx, cy); }

// A fixed arena for the movement, shooting and enemy checks.
//
// Those checks need to know exactly where the walls are, and the generator
// produces a different layout for every seed. Rather than search a generated
// level for a suitable corner, overwrite the map with a known one. The game
// reads the map through solidAt on every query and holds no cached copy, so
// replacing the contents mid-test is legitimate and the code under test cannot
// tell the difference.
//
// Open floor from 1 to 62, one full height pillar, one long wall, and a run of
// waist high cover that movement must respect and bullets must ignore.
function testRoom() {
  SOLID.fill(0xffffffff);
  LOW.fill(0);
  DOORBIT.fill(0);
  for (let y = 1; y < MAP_SIZE - 1; y++) {
    for (let x = 1; x < MAP_SIZE - 1; x++) carve(x, y);
  }
  for (let y = 7; y <= 12; y++) fill(20, y);          // pillar wall, x = 20
  for (let x = 30; x <= 50; x++) fill(x, 10);         // long wall, y = 10
  for (let x = 6; x <= 9; x++) {                      // cover, y = 6
    setBit(SOLID, x, 6);
    setBit(LOW, x, 6);
  }
}

// Full reset before each group of checks. restart() is the game's own function,
// so player state, level counter and camera all return to what a real new level
// produces and no check can inherit damage or kills from the one before it. It
// also generates a level, which testRoom then replaces.
function arena(foeSpawns = []) {
  restart(false);
  setState(S_PLAY);
  testRoom();
  FOE_SPAWNS.length = 0;
  for (const p of foeSpawns) FOE_SPAWNS.push(p);
  spawnFoes();
  getPickups().length = 0;
  getDoors().length = 0;
  getShots().length = 0;
  getParts().length = 0;
  camera.x = 2.5; camera.y = 2.5; camera.angle = 0; camera.pitch = 0;
  keys.clear();
  settings.difficulty = 1;
  exitAt[0] = 60.5; exitAt[1] = 60.5;   // out of the way unless a check moves it
  buildFlow();
}

// Drive update() the way the frame loop does, in fixed 60 Hz slices, rather
// than one large step. Movement resolves per step and clamps against walls per
// step, so a single call with dt of one second would not exercise the same code
// path and would happily pass through geometry.
function run(seconds, held) {
  keys.clear();
  for (const k of held) keys.add(k);
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    update(1 / 60);
    buildFlow();
    updateEffects(1 / 60);
  }
  keys.clear();
}

// Packing first. Everything else in the file trusts that a bit index maps to
// the cell the caller meant, and the 32 bit word boundary in the middle of each
// row is the obvious place for that to go wrong.
console.log("map planes");
arena();
check("border is solid", solidAt(0, 0) && solidAt(63, 63) && solidAt(30, 0));
check("outside the grid is solid", solidAt(-1, 5) && solidAt(64, 5) && solidAt(5, 64));
check("bit 31 and bit 32 are different cells",
      (fill(31, 20), fill(32, 20), solidAt(31, 20) && solidAt(32, 20) && !solidAt(33, 20)));
testRoom();
check("the pillar is solid", solidAt(20, 9) && !solidAt(19, 9) && !solidAt(21, 9));
check("cover blocks movement", solidAt(7, 6));
check("cover does not block sight or bullets", !opaqueAt(7, 6));
check("a full wall blocks both", solidAt(20, 9) && opaqueAt(20, 9));
check("carve clears every plane",
      (setBit(LOW, 3, 3), setBit(DOORBIT, 3, 3), setBit(SOLID, 3, 3), carve(3, 3),
       !solidAt(3, 3) && !bitAt(LOW, 3, 3) && !bitAt(DOORBIT, 3, 3)));

console.log("movement and collision");
arena();
camera.x = 2.5; camera.y = 2.5;
run(1, ["KeyW"]);
check("walks WALK cells in one second", Math.abs(camera.x - (2.5 + WALK)) < 1e-6,
      "x=" + camera.x.toFixed(4));
arena();
run(1, ["KeyW", "ShiftLeft"]);
check("shift runs at RUN", Math.abs(camera.x - (2.5 + RUN)) < 1e-6, "x=" + camera.x.toFixed(4));
arena();
run(1, ["KeyW", "KeyD"]);
check("no diagonal speed bonus",
      Math.abs(Math.hypot(camera.x - 2.5, camera.y - 2.5) - WALK) < 1e-6);
arena();
run(30, ["KeyW", "ShiftLeft"]);
check("stopped flush against the far wall", camera.x > 63 - RADIUS - 0.01 && camera.x < 63 - RADIUS + 1e-9,
      "x=" + camera.x.toFixed(4));
arena();
camera.x = 31.5; camera.y = 8.5; camera.angle = Math.PI / 4;
run(3, ["KeyW"]);
check("slides along a wall instead of sticking", camera.x > 34, "x=" + camera.x.toFixed(3));
check("did not enter the wall", fits(camera.x, camera.y));
arena();
camera.x = 7.5; camera.y = 4.5; camera.angle = Math.PI / 2;   // walk into the cover
run(2, ["KeyW"]);
check("waist high cover stops you walking through it", camera.y < 6 - RADIUS + 1e-6,
      "y=" + camera.y.toFixed(3));
arena();
keys.add("KeyW"); keys.add("ShiftLeft");
for (let i = 0; i < 400; i++) update(0.1);
keys.clear();
check("no tunneling at the clamped dt", fits(camera.x, camera.y));

let openOk = 0, solidOk = 0, totalSolid = 0;
for (let y = 0; y < MAP_SIZE; y++) {
  for (let x = 0; x < MAP_SIZE; x++) {
    if (solidAt(x, y)) { totalSolid++; if (!fits(x + 0.5, y + 0.5)) solidOk++; }
    else if (fits(x + 0.5, y + 0.5)) openOk++;
  }
}
check("every open cell centre is walkable", openOk === MAP_SIZE * MAP_SIZE - totalSolid);
check("every solid cell centre is refused", solidOk === totalSolid);

console.log("ray casting");
arena();
check("the east wall is where it should be",
      Math.abs(castWall(2.5, 2.5, 1, 0, 90) - 60.5) < 1e-9, String(castWall(2.5, 2.5, 1, 0, 90)));
check("the pillar is 1.5 cells away",
      Math.abs(castWall(18.5, 9.5, 1, 0, 90) - 1.5) < 1e-9);
check("a ray passes straight over cover", castWall(7.5, 2.5, 0, 1, 90) > 30,
      String(castWall(7.5, 2.5, 0, 1, 90)));
check("respects maxDist", castWall(2.5, 2.5, 1, 0, 3) === 3);

console.log("weapons");
arena([[8.5, 2.5, "imp"]]);
const target = getFoes()[0];
check("you start with the pistol only",
      player.weapon === 0 && player.have[0] && !player.have[1] && !player.have[2]);
check("the pistol needs no ammo", WEAPONS[0].ammo < 0);
fire();
check("a pistol shot lands", target.hp === FOE_KIND.imp.hp - WEAPONS[0].dmg, "hp=" + target.hp);
check("firing puts the gun on cooldown", player.cool > 0);
check("hitting spawns blood", getParts().some((p) => p.kind === 0));

arena([[8.5, 2.5, "imp"]]);
player.have[1] = true;
player.ammo[1] = 2;
selectWeapon(1);
check("switching weapons works", player.weapon === 1);
player.cool = 0;
fire();
check("the shotgun spends a shell", player.ammo[1] === 1, "ammo=" + player.ammo[1]);
check("all eight pellets hit at point blank",
      getFoes()[0].hp === Math.max(0, FOE_KIND.imp.hp - WEAPONS[1].dmg * WEAPONS[1].pellets),
      "hp=" + getFoes()[0].hp);
player.cool = 0; fire();
player.cool = 0; fire();
check("running dry falls back to the pistol", player.weapon === 0, "weapon=" + player.weapon);

// Fired into open floor with nothing in the way, so the pellet reaches a wall
// no matter where the spread throws it.
arena();
player.have[2] = true;
player.ammo[0] = 5;
selectWeapon(2);
player.cool = 0;
fire();
check("the chaingun spends a bullet", player.ammo[0] === 4);
check("a shot that hits a wall throws sparks", getParts().some((p) => p.kind === 1));

arena([[8.5, 2.5, "imp"]]);
camera.angle = Math.PI;
fire();
check("a shot facing away misses", getFoes()[0].hp === FOE_KIND.imp.hp);
arena([[22.5, 9.5, "imp"]]);
camera.x = 18.5; camera.y = 9.5; camera.angle = 0;
fire();
check("walls stop bullets", getFoes()[0].hp === FOE_KIND.imp.hp);
arena([[9.5, 6.5, "imp"]]);
camera.x = 7.5; camera.y = 2.5;
camera.angle = Math.atan2(6.5 - 2.5, 9.5 - 7.5);
fire();
check("but cover does not", getFoes()[0].hp < FOE_KIND.imp.hp, "hp=" + getFoes()[0].hp);

console.log("pickups");
arena();
player.hp = 50;
check("health heals and is consumed", takePickup({ kind: 0 }) && player.hp === 75);
player.hp = 100;
check("health at full is left on the floor", !takePickup({ kind: 0 }));
const bullets = player.ammo[0];
takePickup({ kind: 1 });
check("bullets stack", player.ammo[0] === bullets + 20);
takePickup({ kind: 3 });
check("the shotgun arrives with shells", player.have[1] && player.ammo[1] > 0);
check("and is selected when it is new", player.weapon === 1);
takePickup({ kind: 5 });
check("keys are remembered", player.keys[0] && !player.keys[1]);
arena();
getPickups().push({ x: camera.x + 0.3, y: camera.y, kind: 0, bob: 0, taken: false });
player.hp = 40;
updatePickups(0.016);
check("walking over a pickup takes it", getPickups()[0].taken && player.hp === 65);

console.log("doors");
arena();
carve(5, 2);
setBit(SOLID, 5, 2); setBit(DOORBIT, 5, 2);
getDoors().push({ cx: 5, cy: 2, key: -1, open: 0, moving: false });
camera.x = 4.7; camera.y = 2.5;
tryOpenDoors();
check("an unlocked door starts opening when you reach it", getDoors()[0].moving);
for (let i = 0; i < 120; i++) updateDoors(1 / 60);
check("it finishes opening", getDoors()[0].open === 1);
check("and stops being solid", !solidAt(5, 2));

arena();
setBit(SOLID, 5, 2); setBit(DOORBIT, 5, 2);
getDoors().push({ cx: 5, cy: 2, key: 0, open: 0, moving: false });
camera.x = 4.7; camera.y = 2.5;
tryOpenDoors();
check("a locked door stays shut without the key", !getDoors()[0].moving && solidAt(5, 2));
player.keys[0] = true;
tryOpenDoors();
check("and opens with it", getDoors()[0].moving);

console.log("enemies");
arena([[10.5, 2.5, "imp"]]);
const chaser = getFoes()[0];
const before = Math.hypot(chaser.x - camera.x, chaser.y - camera.y);
for (let i = 0; i < 60; i++) updateFoes(1 / 60);
check("an imp closes in when it can see you",
      Math.hypot(chaser.x - camera.x, chaser.y - camera.y) < before - 1);

arena([[22.5, 9.5, "imp"]]);
camera.x = 18.5; camera.y = 9.5;
const blind = getFoes()[0];
const blindAt = [blind.x, blind.y];
for (let i = 0; i < 60; i++) updateFoes(1 / 60);
check("an imp with no sight and no memory holds still",
      blind.x === blindAt[0] && blind.y === blindAt[1]);

// The memory is the point of the rewrite: breaking line of sight used to stop
// an enemy dead, which made every fight winnable by stepping behind a corner.
arena([[24.5, 9.5, "imp"]]);
camera.x = 18.5; camera.y = 9.5;
const hunter = getFoes()[0];
wakeFoes(camera.x, camera.y, 30);
buildFlow();
const hunterD = Math.hypot(hunter.x - camera.x, hunter.y - camera.y);
for (let i = 0; i < 60 * 9; i++) updateFoes(1 / 60);
// Distance, not x: the pillar is between them, so the route goes around it and
// an enemy taking the correct path moves away on one axis first.
check("an imp walks to where it last knew you were",
      Math.hypot(hunter.x - camera.x, hunter.y - camera.y) < 2.5,
      hunterD.toFixed(2) + " -> " + Math.hypot(hunter.x - camera.x, hunter.y - camera.y).toFixed(2));

arena([[10.5, 2.5, "imp"]]);
let clipped = false;
for (let i = 0; i < 600; i++) {
  updateFoes(1 / 60);
  if (!fits(getFoes()[0].x, getFoes()[0].y, FOE_R)) clipped = true;
}
check("an imp never walks into a wall", !clipped);
check("it closes to melee range",
      Math.hypot(getFoes()[0].x - camera.x, getFoes()[0].y - camera.y) < FOE_KIND.imp.reach + 0.05);
check("and it hurts", player.hp < 100, "hp=" + player.hp);

arena([[12.5, 2.5, "caster"]]);
const caster = getFoes()[0];
for (let i = 0; i < 180; i++) updateFoes(1 / 60);
check("a caster throws fireballs", getShots().length > 0, "shots=" + getShots().length);
check("and keeps its distance",
      Math.hypot(caster.x - camera.x, caster.y - camera.y) > FOE_KIND.imp.reach * 2,
      "d=" + Math.hypot(caster.x - camera.x, caster.y - camera.y).toFixed(2));

arena([[30.5, 2.5, "imp"]]);
const far = getFoes()[0];
far.alert = 0;
wakeFoes(camera.x, camera.y, 6);
check("a quiet noise does not carry", far.alert === 0);
wakeFoes(camera.x, camera.y, 40);
check("a loud one does", far.alert > 0);

console.log("projectiles and particles");
arena();
player.hp = 100;
spawnShot(camera.x + 3, camera.y, -1, 0, 12);
for (let i = 0; i < 120 && getShots().length; i++) updateShots(1 / 60);
check("a fireball that reaches you hurts", player.hp < 100, "hp=" + player.hp);
check("and is consumed", getShots().length === 0);

arena();
player.hp = 100;
camera.x = 18.5; camera.y = 9.5;
spawnShot(24.5, 9.5, -1, 0, 12);      // the pillar is between them
for (let i = 0; i < 240 && getShots().length; i++) updateShots(1 / 60);
check("a wall stops a fireball", player.hp === 100 && getShots().length === 0);

arena();
spawnPart(3, 3, 0.5, 0, 2, 6);
check("particles spawn", getParts().length === 6);
for (let i = 0; i < 240; i++) updateParts(1 / 60);
check("and expire", getParts().length === 0);
arena();
for (let i = 0; i < 200; i++) spawnPart(3, 3, 0.5, 1, 2, 1);
check("the particle array is capped", getParts().length <= MAX_PARTS,
      getParts().length + " of " + MAX_PARTS);

console.log("difficulty and settings");
arena();
settings.difficulty = 0;
player.hp = 100;
hurtPlayer(10);
const easy = 100 - player.hp;
settings.difficulty = 2;
player.hp = 100;
hurtPlayer(10);
const hard = 100 - player.hp;
check("difficulty scales incoming damage", hard > easy, easy + " vs " + hard);
settings.difficulty = 1;
check("field of view survives a round trip",
      Math.abs(fovToDegrees(degreesToFov(90)) - 90) < 1, String(fovToDegrees(degreesToFov(90))));
check("ninety degrees is a camera plane of one", Math.abs(degreesToFov(90) - 1) < 1e-9);

console.log("state, dying and progression");
arena([[3.2, 2.5, "imp"]]);
for (let i = 0; i < 60 * 25 && player.hp > 0; i++) { updateFoes(1 / 60); updateEffects(1 / 60); }
check("enough swings kill the player", player.hp === 0);
check("death switches to the death screen", getState() === S_DEAD);
const restX = camera.x;
keys.add("KeyW");
update(0.1);
keys.clear();
check("a dead player cannot move", camera.x === restX);
for (let i = 0; i < 60; i++) updateEffects(1 / 60);
check("the death fade advances", player.dead > 0.5);
check("the head tips back", camera.pitch < -0.2);

const diedOn = getLevel();
restart(false);
check("dying and retrying keeps the level", getLevel() === diedOn);
check("restart heals", player.hp === 100 && player.dead === 0 && player.kills === 0);
check("a retry takes your weapons back", !player.have[1] && !player.have[2]);
restart(true);
check("clearing advances the level", getLevel() === diedOn + 1);

arena([[8.5, 2.5, "imp"], [9.5, 2.5, "imp"]]);
exitAt[0] = 30.5; exitAt[1] = 2.5;
check("a fresh level is not already cleared", !cleared());
damageFoe(getFoes()[0], 999, 1, 0);
damageFoe(getFoes()[1], 999, 1, 0);
check("killing everything does not end the level on its own", !cleared());
check("the exit is not reached from across the map", !reachedExit());
camera.x = 30.5; camera.y = 2.5;
check("standing on the exit is reaching it", reachedExit());
updatePickups(0.016);
check("which ends the level", cleared() && getState() === S_CLEAR);
setLevel(3);
const carried = player.ammo[0];
player.have[1] = true;
restart(true);
check("weapons carry across a cleared level", player.have[1]);

console.log("pathfinding");
arena();
// A wall with one way around it: a straight line walks into it, the field does not.
camera.x = 2.5; camera.y = 9.5;
buildFlow();
const around = flowStep(35.5, 11.5);
check("the field reaches past a wall", around !== null);
{
  // Walk the field from behind the long wall and see whether it arrives.
  let x = 40.5, y = 11.5, steps = 0;
  while (steps < 400 && Math.hypot(x - camera.x, y - camera.y) > 1.2) {
    const step = flowStep(x, y);
    if (!step) break;
    x += step[0]; y += step[1];
    steps++;
  }
  check("and leads all the way to the player",
        Math.hypot(x - camera.x, y - camera.y) <= 1.2, "ended at " + x + "," + y);
}
arena([[40.5, 11.5, "imp"]]);
camera.x = 2.5; camera.y = 9.5;
buildFlow();
const walker = getFoes()[0];
walker.alert = 30; walker.tx = camera.x; walker.ty = camera.y;
const startD = Math.hypot(walker.x - camera.x, walker.y - camera.y);
for (let i = 0; i < 60 * 12; i++) { buildFlow(); updateFoes(1 / 60); }
check("an enemy with no sight line still finds its way around",
      Math.hypot(walker.x - camera.x, walker.y - camera.y) < startD - 8,
      startD.toFixed(1) + " -> " + Math.hypot(walker.x - camera.x, walker.y - camera.y).toFixed(1));

console.log("stamina, decals and records");
arena();
player.stam = 1;
run(3, ["KeyW", "ShiftLeft"]);
check("sprinting drains stamina", player.stam < 1, "stam=" + player.stam.toFixed(2));
const drained = player.stam;
run(2, ["KeyW"]);
check("walking gives it back", player.stam > drained);
arena();
player.stam = 0;
run(1, ["KeyW", "ShiftLeft"]);
check("with no stamina you can only walk",
      Math.abs(camera.x - 2.5 - WALK) < 0.05, "moved " + (camera.x - 2.5).toFixed(2));

arena();
for (let i = 0; i < MAX_DECALS + 6; i++) spawnDecal(3 + i, 4);
check("decals are capped at the shader's array", getDecals().length === MAX_DECALS);
arena([[8.5, 2.5, "imp"]]);
damageFoe(getFoes()[0], 999, 1, 0);
check("a kill leaves blood behind", getDecals().length > 0);

const wasBest = getBest();
recordBest(wasBest + 3);
check("a deeper run is recorded", getBest() === wasBest + 3);
recordBest(1);
check("a shallower one is not", getBest() === wasBest + 3);

console.log("level generation");
let minSpots = 99, worstOpen = 1, bestOpen = 0, unreachable = 0, caves = 0, rooms = 0, shortExit = 0;
for (let seed = 1; seed <= 40; seed++) {
  setLevel(seed);
  buildLevel(BASE_SEED + seed);
  if ((BASE_SEED + seed) % 2) rooms++; else caves++;

  for (let i = 0; i < MAP_SIZE; i++) {
    if (!solidAt(i, 0) || !solidAt(i, MAP_SIZE - 1) || !solidAt(0, i) || !solidAt(MAP_SIZE - 1, i)) {
      check("seed " + seed + " keeps its border", false);
    }
  }
  if (!fits(START[0], START[1])) check("seed " + seed + " start is open", false);
  minSpots = Math.min(minSpots, FOE_SPAWNS.length);
  for (const [x, y] of FOE_SPAWNS) {
    if (!fits(x, y, FOE_R)) check("seed " + seed + " spawn is open", false);
  }

  // Reachability with doors treated as passable, because a door is a delay
  // rather than a wall. An enemy or a key behind a sealed region would leave
  // the level impossible to clear with no indication why.
  const N = MAP_SIZE;
  const seen = new Set();
  const startIdx = Math.floor(START[1]) * N + Math.floor(START[0]);
  const stack = [startIdx];
  seen.add(startIdx);
  while (stack.length) {
    const i = stack.pop();
    const x = i % N, y = Math.floor(i / N);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, ni = ny * N + nx;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen.has(ni)) continue;
      if (solidAt(nx, ny) && !bitAt(DOORBIT, nx, ny)) continue;
      seen.add(ni);
      stack.push(ni);
    }
  }
  for (const [x, y] of FOE_SPAWNS) {
    if (!seen.has(Math.floor(y) * N + Math.floor(x))) unreachable++;
  }
  for (const p of getPickups()) {
    if (!seen.has(Math.floor(p.y) * N + Math.floor(p.x))) unreachable++;
  }
  // The exit is the win condition, so a level with an unreachable one cannot
  // be finished at all.
  if (!seen.has(Math.floor(exitAt[1]) * N + Math.floor(exitAt[0]))) unreachable++;
  if (Math.hypot(exitAt[0] - START[0], exitAt[1] - START[1]) < 3.5) shortExit++;
  const frac = seen.size / (N * N);
  worstOpen = Math.min(worstOpen, frac);
  bestOpen = Math.max(bestOpen, frac);
}
check("both layouts appear", caves > 10 && rooms > 10, caves + " caves, " + rooms + " rooms");
check("every seed places at least four enemies", minSpots >= 4, "worst=" + minSpots);
check("nothing is ever unreachable", unreachable === 0, unreachable + " stranded");
check("levels are neither cramped nor wide open",
      worstOpen > 0.08 && bestOpen < 0.75,
      (worstOpen * 100).toFixed(1) + "% to " + (bestOpen * 100).toFixed(1) + "%");
check("the exit is never on top of the spawn", shortExit === 0, shortExit + " too close");
check("door count stays inside the shader's array", getDoors().length <= MAX_DOORS);
check("pickup count stays inside the shader's array", getPickups().length <= 12);
check("enemy count stays inside the shader's array", FOE_SPAWNS.length <= MAX_FOES);

setLevel(5);
generate(BASE_SEED + 5);
const snapshot = Uint32Array.from(SOLID);
generate(BASE_SEED + 5);
check("the same seed rebuilds the same level", snapshot.every((w, i) => w === SOLID[i]));
generate(BASE_SEED + 6);
check("a different seed builds a different level", !snapshot.every((w, i) => w === SOLID[i]));
buildLevel(BASE_SEED + 5);
const spawnsA = JSON.stringify(FOE_SPAWNS), startA = JSON.stringify(START);
buildLevel(BASE_SEED + 5);
check("spawns are deterministic too",
      JSON.stringify(FOE_SPAWNS) === spawnsA && JSON.stringify(START) === startA);
check("cover never seals a level off",
      openCells().length > 300, openCells().length + " open cells");

console.log("audio");
// There is no AudioContext under Node, which is exactly the case that matters:
// gameplay fires these on every shot, hit and footstep, and an unguarded one
// would throw straight out of the frame loop.
check("no context exists here", getAudio() === null);
check("initAudio is a no-op without WebAudio", (initAudio(), getAudio() === null));
let threw = null;
try {
  sfxShoot(0); sfxShoot(1); sfxShoot(2);
  sfxStep(); sfxHurt(); sfxDie(); sfxClear(); sfxSwitch(); sfxDryFire(); sfxLocked();
  sfxImpHit(3, 4); sfxImpDie(3, 4); sfxGrowl(3, 4); sfxSwing(3, 4);
  sfxCast(3, 4); sfxExplode(3, 4); sfxPickup(true); sfxDoor(3, 4);
} catch (e) { threw = String(e); }
check("every sound is silent rather than fatal", threw === null, String(threw));
check("mute toggles without a context", (toggleMute(), getMuted() === true));
toggleMute();

check("three enemy kinds are indexed for the shader",
      FOE_INDEX.imp === 0 && FOE_INDEX.caster === 1 && FOE_INDEX.brute === 2);
check("the brute is the heavy one",
      FOE_KIND.brute.hp > FOE_KIND.imp.hp && FOE_KIND.brute.speed < FOE_KIND.imp.speed);

for (const [name, pat] of [["BASS_A", BASS_A], ["BASS_B", BASS_B], ["ARP", ARP],
                           ["LEAD", LEAD], ["KICK", KICK], ["SNARE", SNARE], ["HAT", HAT]]) {
  check(name + " is one bar of " + STEPS, pat.length === STEPS, name + "=" + pat.length);
}
let badNote = null;
for (const pat of [BASS_A, BASS_B, ARP, LEAD]) {
  for (const c of pat) {
    if (c === ".") continue;
    const n = parseInt(c, 36);
    if (!(n >= 0 && n <= 24)) badNote = c;
  }
}
check("pitched patterns hold sane semitones", badNote === null, "bad char " + badNote);
check("percussion patterns are hits or rests",
      [...KICK + SNARE + HAT].every((c) => c === "x" || c === "."));
check("both progressions cover whole bars",
      PROG_A.length === 8 && PROG_B.length === 8 &&
      PROG_A.concat(PROG_B).every((n) => n >= 0 && n < 24));
check("an octave up doubles the frequency", Math.abs(noteHz(12) - ROOT * 2) < 1e-9);
check("the tempo is plausible", BPM > 60 && BPM < 220, "bpm=" + BPM);
check("the swing is a nudge, not a lurch", SWING > 0 && SWING < 0.34, "swing=" + SWING);

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
