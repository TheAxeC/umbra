# How umbra works

Everything in the shipped file, in order: the world representation, the renderer, the game systems, the level generator, the synth, the interface, the test harnesses, and then the packing chain that takes 130,608 bytes of source down to a 16,948 byte zip.

- [Shape of the program](#shape-of-the-program)
- [The world as bits](#the-world-as-bits)
- [The renderer](#the-renderer)
- [Game systems](#game-systems)
- [Level generation](#level-generation)
- [Audio](#audio)
- [Interface](#interface)
- [Testing](#testing)
- [Size](#size)
- [Non-obvious failures](#non-obvious-failures)
- [Limitations](#limitations)

## Shape of the program

`index.html` is a document with an inline stylesheet, the interface markup, and one module script. The script is organised in sections, top to bottom: map storage and lookup, level generation, collision helpers, game state and settings, the interface bindings, camera and input, weapons, entities and combat, audio, the WGSL shader as a template literal, and finally the WebGPU setup and frame loop.

The order matters for one reason. The test harnesses slice the file between `const MAP_SIZE` and the comment that introduces the shader, and evaluate that slice as a standalone scope. Everything above the shader is pure logic with no reference to the DOM or to WebGPU at module level, which is what makes the slice runnable under Node. Anything that touches `document` lives inside a function the tests do not call, or is guarded.

The interface is HTML rather than drawn in the shader. The browser already contains a font renderer and a layout engine, and using them costs a stylesheet instead of a packed glyph table, an atlas, and the code to lay text out. It also makes the menus and sliders real controls rather than hit-tested rectangles.

## The world as bits

The map is 64 by 64 cells. A row of 64 cells needs two 32-bit words because JavaScript bitwise operators work on 32 bits, so each plane is a `Uint32Array(128)`, 512 bytes. There are three planes over the same grid:

```
SOLID     the cell stops you walking into it
LOW       waist high block: stops movement, but not sight or bullets
DOORBIT   the cell is a door, and how far it has slid open lives in doors[]
```

A cell with `SOLID` and neither modifier is an ordinary wall. Two extra bits give four kinds of cell, and the reason cover is a bit plane rather than an entry in a list is that there are hundreds of cover cells and they are tested per pixel per ray step.

Two lookups fall out of it:

```js
function solidAt(cx, cy) {          // blocks movement
  if (cx < 0 || cy < 0 || cx >= MAP_SIZE || cy >= MAP_SIZE) return true;
  return bitAt(SOLID, cx, cy);
}

function opaqueAt(cx, cy) {         // blocks sight and bullets
  if (cx < 0 || cy < 0 || cx >= MAP_SIZE || cy >= MAP_SIZE) return true;
  return bitAt(SOLID, cx, cy) && !bitAt(LOW, cx, cy);
}
```

The difference between those two functions is the entire cover mechanic. Shooting and line of sight use `opaqueAt`, so a bullet and a glance both pass over a waist high block; movement uses `solidAt`, so you cannot walk through it. Enemies use the same pair, which means they can shoot you across a crate you are hiding behind, and you can shoot them.

Out of bounds returns solid in both, which removes every edge case from the raycaster and the collision code at once. A ray that escapes the grid hits a wall instead of running to the step limit, and the player cannot leave the map because the border behaves like any other wall.

The shader performs the same lookups on the same words, uploaded as three `array<vec4u, 32>`. WGSL pads each element of a uniform array to 16 bytes, so an `array<u32, 128>` would occupy 2 KB rather than 512 bytes; packing four words per `vec4u` avoids that, at the cost of a two-step index.

Nothing else describes the world. There is no collision mesh, no navigation grid and no occlusion structure. Shooting, sight lines, player collision, enemy movement, the minimap and the renderer all read the same three arrays.

## The renderer

### The pass

One render pass, one pipeline, one draw call of three vertices. The vertex shader builds a triangle large enough to cover the clip volume from `vertex_index` alone, with no vertex buffer. Everything visible is decided per pixel inside the fragment shader: walls, cover, doors, stairs, floor, ceiling, lamps, all three enemy types, pickups, the exit arch, fireballs, particles, blood decals, the gun, the screen effects, the scene wipe and the minimap.

### Camera, and the height model

```wgsl
let ndc = frag.xy / U.res * 2.0 - 1.0 + shake;   // x right, y down
let screenX = ndc.x * aspect * U.fov;
let sy = ndc.y + U.pitch + bobY;
let dir = vec2f(cos(U.ang), sin(U.ang));
let plane = vec2f(-dir.y, dir.x);
let rd = dir + plane * screenX;
```

`dir` is a unit vector and `plane` is `dir` rotated by 90 degrees, so it is also unit length and perpendicular. Consequently `dot(rd, dir)` is 1 for every pixel regardless of `screenX`, which means the ray parameter along `rd` is already the perpendicular distance to the camera plane. That is what a raycaster needs to avoid fisheye distortion, and it makes the world position of any hit exactly `cam + rd * t` with no correction term.

Heights are in world units where the wall runs from 0 to 1 and the eye sits at 0.5. A point at height `z` and distance `t` projects to

```
sy = (0.5 - z) * 2 * WALL_HEIGHT / t
```

with `WALL_HEIGHT` at 0.6. Check the ends: `z = 0` gives `0.6 / t`, the floor line, and `z = 1` gives `-0.6 / t`, the ceiling. Everything vertical in the game is one application of that formula: wall tops, the bottom edge of a door leaf, the top of a cover block, where an enemy's feet land, how high a pickup bobs, and where a particle sits.

Pitch is a shear rather than a rotation. Adding a constant to the screen y coordinate slides the horizon while leaving every wall column vertical, which is what Doom did and what keeps the projection valid. The walk cycle rides on the same value, as a small sine of distance travelled.

### The DDA, and why it does not stop

The grid walk is a standard digital differential analyser, with one difference: it does not stop at the first solid cell, because not every solid cell fills its column.

```wgsl
for (var i = 0; i < MAX_STEPS; i = i + 1) {
  var t = 0.0;
  if (sideDist.x < sideDist.y) { t = sideDist.x; sideDist.x += delta.x; cell.x += stepDir.x; side = 0; }
  else                         { t = sideDist.y; sideDist.y += delta.y; cell.y += stepDir.y; side = 1; }
  if (!solid(cell)) { continue; }
  if (bitOf(2, cell)) {                        // door
    let d = doorAt(cell);
    let bottom = (0.5 - d.x) * 2.0 * WALL_HEIGHT / t;
    if (sy <= bottom && sy >= -WALL_HEIGHT / t) { dist = t; hit = 3; break; }
    continue;                                  // you can see under it
  }
  if (bitOf(1, cell)) {                        // waist high cover
    let top = (0.5 - LOW_H) * 2.0 * WALL_HEIGHT / t;
    if (sy >= top && sy <= WALL_HEIGHT / t) { dist = t; hit = 2; break; }
    continue;                                  // you can see over it
  }
  dist = t; hit = 1; break;                    // full wall
}
```

`t` is the distance at which the ray *enters* the cell, which is the value of `sideDist` before it is advanced. For a cover block the ray only stops if the pixel falls between the top of the block and the floor line; above that it carries on to whatever is behind. For a door the test is the same with the span inverted, because a door leaf hangs from the ceiling and slides up, so an opening door shows a growing gap underneath before it disappears entirely.

`doorAt` is a linear scan of the eight door slots. Doors are rare and the scan only happens on a cell that already carries the door bit, so it costs less than a fourth bit plane would.

Division by zero for an axis-aligned ray produces infinity in `delta` and in `sideDist`, which simply means that axis is never chosen. No special case is needed. `MAX_STEPS` is 200, enough for the diagonal of the grid.

### Floor, ceiling, and the tops of things

For pixels outside any face, the distance to the ground plane follows from the same height formula inverted: a floor point seen at screen height `sy` is at `WALL_HEIGHT / sy`, and the ceiling is the same with the sign flipped. Both are guarded away from the horizon, where the distance runs to infinity and the world position would become NaN.

Cover has a top surface, which is a floor at height `LOW_H`. Rather than trace it, the shader computes where the raised plane would be for this pixel, checks whether the cell there is actually a cover cell, and uses that distance if it is:

```wgsl
let gt = (0.5 - LOW_H) * 2.0 * WALL_HEIGHT / max(sy, 0.001);
let tc = vec2i(floor(U.cam + rd * gt));
if (gt > 0.05 && solid(tc) && bitOf(1, tc)) { gd = gt; pt = U.cam + rd * gt; lifted = true; }
```

That is an approximation rather than a second trace, and it can be wrong where a raised surface is occluded by a nearer wall at a grazing angle. In practice the case is rare and the error is a few pixels along an edge.

Far from the camera the ground texture becomes smaller than a pixel and aliases, so it is mixed towards a flat colour over 7 to 20 cells. Fog is eating the image at that range anyway.

### Procedural texture

Three functions produce every surface. `hash21` is the sine hash, `noise2` interpolates it bilinearly over the integer lattice, and `fbm` sums four octaves. The map is only 64 cells across so the inputs stay small enough for the sine hash to behave.

Walls pick a material from a hash of the cell coordinate divided by three, so materials come in runs of about three cells rather than changing at every block: concrete, streaked rust, or painted panels. Each is modulated by fbm grain, a per-cell brightness jitter, horizontal seams at thirds of the wall height, a vertical joint on the cell boundary, rivets, and grime rising from the floor.

Doors are not wall coloured. They are hazard striped and tinted by the key they want, red or blue, so a locked door reads as locked from across the room without a prompt.

Floor and ceiling share one function and tile to the same grid the walls stand on. The distance to the nearest cell edge is `0.5 - abs(fract(p) - 0.5)`; measuring to the half-cell instead puts a seam down the view axis, which is the sort of thing that is invisible until you notice it is always exactly under the crosshair. The ceiling scatters lamp panels, a hash of the cell deciding which one in ten is lit, inset by a smoothstep on the same edge distance.

There is no lighting calculation. Wall shading is a fixed lambert term against a constant sun direction, the lamps are emissive decoration, and the one dynamic light in the game is the muzzle flash:

```wgsl
color = color * (1.0 + U.flash * 2.2 * exp(-dist * 0.45));
```

Firing visibly lights the corridor, for one line of shader.

### Sprites

Everything that is not the level is a billboard resolved in the same pass, against the running `dist`, so occlusion against walls, against other sprites, and against the floor all come from one comparison with no sorting and no depth buffer.

Enemies and pickups are vertical cylinders: the ray hits if it passes within the radius of the axis, and two dot products give the depth and the horizontal position across the sprite. The vertical coordinate comes from the height formula. `impShape`, `casterShape` and `bruteShape` draw their subjects from primitives in that local space, and `pickShape` draws seven pickups from rectangles and offsets. The three enemies share a shading helper that fakes a cylinder and darkens the silhouette edge, and a walk flag packed into the sprite channel drives leg and arm swing on per-enemy clocks, so a pack does not march in step.

Each enemy is built to read at range, because which one is across the room decides whether to close or take cover. The imp is lean and red with lit yellow eyes; the caster is a hooded, hovering robe with cyan eyes and a charge pulsing at its chest; the brute is twice the imp's width, armour plated, with a small head sunk between its shoulders.

The `z` channel of an enemy does double duty. It is 1 while alive and falls to 0 over about 0.6 seconds on death, and because the sprite height is multiplied by it, the corpse squashes into the floor. Below 0.02 the shader skips the slot. That is the entire death animation.

Fireballs and particles are point sprites rather than cylinders, projected directly:

```wgsl
let px = dot(rel, plane) / depth;                       // screenX of the point
let py = (0.5 - p.z) * 2.0 * WALL_HEIGHT / depth;       // sy of the point
let dx = (screenX - px) / (size / depth);
let dy = (sy - py) / (2.0 * WALL_HEIGHT * size / depth);
if (dx * dx + dy * dy < 1.0) { ... }
```

The two axes are scaled separately because horizontal distance is measured in camera plane units and vertical in ndc units. Both are tested against the depth already resolved, so a fireball behind a wall does not glow through it, but they are added after fog rather than multiplied by it, because they are light sources rather than surfaces. Particles pack their kind and their remaining life into one channel as `kind + life`, which keeps a particle at four floats.

### The gun and the screen

The weapon is drawn in screen space from rectangles, in a coordinate system with its origin at the bottom centre and y running up, scaled so the gun fills the lower fifth. Each of the three has its own build: a pistol with a front sight and an ejection port, a twin barrelled shotgun with a wooden stock and a pump, and a chaingun with a visible ammo feed and a barrel cluster that spins while firing. A gloved hand holds each grip, a lit top edge and a shaded underside make the shapes read as solids, recoil pushes the gun down out of frame, a weapon change takes it all the way out and brings the new one back up, and the walk cycle sways it.

After the gun come the muzzle tint, the damage wash, and a damage direction indicator that glows on the edge of the screen towards whatever hit you, computed from the bearing stored when the damage landed. Then the crosshair, which sits on the exact centre ray the hitscan uses, so what you aim at is what you hit by construction.

### The minimap

Drawn from the same three bit planes, north up, with the player fixed in the middle and a wedge for the heading. Walls, cover and doors get different shades; enemies, pickups and keys are dots. It is fifty lines of shader and no new data, because the map is already in the uniform buffer.

### The exit and the wipe

The way out is drawn in the same pass as everything else: an arch of two posts and a lintel around a column of moving light, tested against the running depth so walls occlude it, pulsing so it reads as a destination rather than a lit wall.

Scene changes use a Doom style wipe. The last frame before the change is kept in a texture, the only texture in the program, and during the wipe the new scene renders normally underneath while the old frame slides down over it in ragged columns, each starting on its own delay and accelerating as it falls. The wipe advances in the frame loop regardless of game state and fires only on transitions the player asked for; both halves of that sentence were bugs first, recorded in the failures section.

### Elevation

Every cell carries a floor height in two more bit planes, giving four levels a quarter of a wall apart. That turns the grid from open or shut into open at a height, and it changes the ray walk: at each cell the ray asks whether that cell's floor is visible at this pixel, and whether the next cell steps up far enough to put a riser in the way. A step down shows nothing from the near side, because that face points away from the eye.

The eye height moves with the player, so every projection reads `U.eyeZ` rather than a constant. Enemies stand on the floor of the cell they occupy, pickups bob above it, and the flow field refuses to route anything across a step taller than it can climb, which is what stops a pack piling up against a ledge.

Crates fold into the same machinery: a crate is a short face with a walkable top, so the ray either meets its side or passes over it and carries on at the new elevation.

### The uniform buffer

One buffer, 4,288 bytes, rewritten every frame.

```
float   byte    contents
0       0       resolution, field of view, time
4       16      camera position, heading, pitch
8       32      gun recoil, muzzle flash, damage wash, death fade
12      48      walk phase, shake x, shake y, status bar height
16      64      eye height, weapon index, damage bearing, shake amount
20      80      key bits, exit x, exit y, wipe
24      96      weapon switch, then padding out to float 32
32      128     SOLID plane, 128 words
160     640     LOW plane, 128 words
288     1152    DOORBIT plane, 128 words
416     1664    floor height low bit, 128 words
544     2176    floor height high bit, 128 words
672     2688    enemies, 14 * vec4
728     2912    doors, 8 * vec4
760     3040    pickups, 12 * vec4
808     3232    fireballs, 10 * vec4
848     3392    particles, 40 * vec4
1008    4032    blood decals, 16 * vec4
```

The header is scalars only, padded to exactly 128 bytes so the arrays start on a sixteen byte boundary by construction; the alignment failure that forced that rule is in the failures section. Empty slots are written with a negative in the last channel, which is how the shader is told to skip them; enemies use the third channel instead, since a liveness of zero already means gone.

The whole buffer including all five map planes is copied every frame. That is about 4 KB and not measurable, and doing it unconditionally removes a class of bug: an earlier version uploaded the map once at startup, before the first level existed, and the shader saw an empty grid.

## Game systems

### Timestep

One `requestAnimationFrame` loop. The delta is clamped to 0.1 seconds so a tab switch cannot produce a single enormous step that carries the player through a wall. At the run speed of 5.8 cells per second the clamp guarantees at most 0.58 cells of movement per frame, comfortably under the one cell that would allow tunnelling.

Only the PLAY state advances the world. Menus and the pause screen still draw, so the level sits live behind them rather than a black screen, but nothing moves.

### Movement and collision

The player is an axis-aligned square of half-width 0.22 cells; a position is legal when all four corners are in open cells, which is four bit lookups. Movement resolves one axis at a time, which is what produces wall sliding, and a refused axis snaps flush to the cell boundary it was heading for rather than dropping the step. Diagonal input is normalised. Sprinting drains a stamina bar and stops when it empties; stamina returns while not sprinting. A step of one elevation level can be climbed, anything taller blocks like a wall, and the eye eases to the new ground height so a staircase plays as a climb rather than a series of jumps.

### Weapons

| | damage | cooldown | pellets | spread | ammo |
|---|---|---|---|---|---|
| pistol | 22 | 0.30 s | 1 | 0 | none |
| shotgun | 13 | 0.80 s | 8 | 0.10 rad | shells |
| chaingun | 11 | 0.09 s | 1 | 0.045 rad | bullets |

Firing casts one ray per pellet from the centre of the screen, so the shotgun needs no code of its own beyond a pellet count and a spread. Wall distance comes from `castWall`, the JavaScript twin of the shader's DDA, and enemies are tested by projecting onto the ray. Running dry falls back to the pistol rather than leaving the player holding something useless.

### Enemies

Three kinds. The imp closes and swings. The caster keeps its distance, sidesteps, and throws fireballs that travel, collide with geometry and explode; fireballs are the reason cover and doorways matter, since they can be dodged and blocked. The brute is slow, takes two and a half times an imp's damage, and hits for more than twice as much in reach.

The AI is a short update with a memory:

- Seeing the player refreshes an eight second alert and stores the last known position.
- Being shot does the same, even from behind, so an enemy cannot be farmed from its blind side.
- Gunfire wakes anything within eighteen cells; sprinting wakes anything within seven. Firing a shotgun in a corridor pulls a room.
- With no sight and no memory, an enemy holds position. With a memory it follows a flow field towards the player, walking around obstacles instead of pressing into the wall between you. The field is one breadth first sweep over the grid from the player's cell, rebuilt only when the player changes cell, shared by every enemy, and refusing edges taller than a climbable step, so nothing gets routed at a ledge it cannot climb. Enemies steer at the centre of the next field cell rather than along the raw direction; the reason is in the failures section.
- A separation pass pushes enemies apart when they crowd, and a small sideways drift means a group arrives spread out rather than in single file.

### Doors, keys and pickups

Doors are chokepoint cells. Walking into one opens it, unless it is locked, in which case it needs the matching key and says so. While a door is moving the cell stays solid and the shader draws the leaf sliding up; at fully open the solid and door bits are cleared and it becomes ordinary floor.

Pickups are health, armour, bullets, shells, the two weapons, and the two keycards. Armour soaks a third of incoming damage and wears down doing it. Walking over one takes it, and health at full is left on the floor rather than wasted.

### Damage and progression

100 health. Damage scales with the difficulty setting, and the status bar face reddens, scowls and tilts towards the direction the damage came from. At zero, input is dropped, the music ducks under the death tone, the pointer unlocks and the view tips back.

A level ends at the exit, not at the last kill. Reaching the arch advances the seed, carries weapons and ammunition forward, and records the deepest level reached in localStorage under a namespaced key. Dying rebuilds the same level from the same seed and resets the loadout to the pistol. Kills still pay, because what enemies guard is what gets you through the next level, and each one leaves a blood decal that stays for the rest of the level.

One unlocked door on the route to the exit is chosen as an arena. Stepping into the region behind it shuts and seals the door and puts everything inside on full alert; the door reopens when the room is empty.

## Level generation

Everything comes from one seed through a linear congruential generator. `Math.imul` is required because the multiply overflows 32 bits.

Levels alternate between two layouts so the game does not look the same twice in a row.

**Rooms.** Up to eleven rectangles placed by rejection sampling with a one cell gap between them, joined by L-shaped corridors from centre to centre. Linking consecutive rooms guarantees connectivity by construction; three extra links between random pairs turn the layout from a tree into a graph, which means loops and being approached from two directions.

**Caves.** Cellular automata: fill at random, then five passes of setting each cell to whatever most of its neighbours are. The seeding fraction matters more than it looks. The smoothing rule turns a cell into a wall when five of its eight neighbours are walls, which erodes walls whenever they start in a minority, so seeding at 54% solid converges on one large cavern. Seeding at 58% gives a cave system averaging 38% open. Automata leave disconnected pockets, so the largest region is kept and the rest filled in. If that region is too small to be a level, generation falls back to rooms from the same seed, which keeps it deterministic.

Both layouts then go through the same passes:

- **Doors** are hung in chokepoints, cells with exactly two opposite open neighbours, spaced apart and never near the spawn.
- **One door is locked** from level two onward. Its key is placed by flood filling from the start with that door shut and choosing a cell inside the reachable region, so the key can never end up behind the door it opens.
- **Cover** is scattered as short runs of waist high blocks. Placement is verified rather than guessed: each run is placed, the level is flood filled, and the run is removed again if anything stopped being reachable. Counting solid neighbours is not enough, because a run of three can bridge a corridor from a cell that looked open. Cover also avoids the spawn cell and any pickup already placed.
- **Raised ground** is added as rectangular platforms one or two steps up, each with a staircase carved down one side, placed only on flat open ground so the top is reachable from below.
- **The exit** goes on the farthest reachable cell from the spawn, so finishing a level means crossing it.
- **The arena** is picked by shutting each unlocked door in turn and flood filling: a door that seals off a region of workable size on the exit side becomes the seal-in fight.
- **Enemies** are spread over the candidate positions, ramping from five on the first level to fourteen; casters appear from level two and brutes from level three, both growing more common with depth.
- **Supplies** are placed in open cells away from the start.

The test suite checks forty consecutive seeds for border integrity, spawn validity, both layouts appearing, and reachability by flood fill with doors treated as passable.

## Audio

One `AudioContext`, created on the first click because browsers do not allow audio to start without a gesture. A master gain feeds the destination and a music gain feeds the master, so music can duck behind a menu without touching the effects. One second of white noise is generated at startup and reused by everything that needs noise.

Three helpers cover every sound: `envelope` wraps a source in a gain node with a linear attack and exponential decay, `tone` is an oscillator through an envelope, and `burst` is the shared noise buffer through a filter and an envelope, started at a random offset so repeats do not sound identical.

Every effect is built the same way: a transient that gives it attack, a body that gives it weight, and a tail that puts it in a room. What changes between them is the balance. The pistol is mostly transient, the shotgun mostly body, and the chaingun is trimmed so nine a second do not smear into each other.

The reverb is a convolver over an impulse response generated at startup: noise under an exponential decay, with a short fade in for pre-delay. Effects run through a bus that feeds both the dry path and the reverb; the music has its own, much drier, send. A compressor on the end stops whichever of a shotgun, a fireball and eight bars of music happens to be loudest from winning, and a makeup gain puts back what it takes. That last part is not optional: without it the growl and the footstep both measured as silence.

Enemy voices are a sawtooth through two bandpass filters, which is a crude vowel, with noise breath under it and a sine for body. Each of the three sits in its own register, so what is in the room with you is identifiable without looking: the imp snarls, the caster hisses upward, the brute is a low roar.

Enemy sounds are placed. Pan is the component of the offset along the camera's right vector; gain falls off as `1 / (1 + d * d * 0.04)`. Growls and the caster's wind-up are the only warning about something outside your field of view, so the placement is functional.

The music is a step sequencer over packed pattern strings, one character per sixteenth, a dot for a rest and anything else a semitone offset in base 36, decoded with `parseInt(c, 36)` where the NaN from a dot serves as the rest test. Two sections of eight bars each with their own transposition tables; the arpeggio and the snare enter in the second and a melody joins for the last four bars, which is what gives a sixteen bar loop somewhere to go.

Voices are a filtered sawtooth bass, detuned squares for the arpeggio and melody, a three saw pad through a filter that opens across each bar, a pitch dropping sine kick with a beater click, and layered noise for snare and hats. Every other sixteenth lands slightly late, which gives the loop swing instead of a metronome grid. Total pattern data is seven strings of sixteen characters and two arrays of eight numbers.

Scheduling uses lookahead against `ctx.currentTime` rather than the frame loop, so a rendering stutter cannot shift the beat. When the tab is hidden the context suspends, because `requestAnimationFrame` stops there and `setInterval` throttles to roughly one second, which would leave the music stuttering along over a paused game.

## Interface

Five screens driven by one state variable: menu, playing, paused, dead, cleared. Every state other than playing releases the pointer lock, which is what stops the click that dismisses a screen from also being a shot.

The status bar is a framed strip with health, armour, a face, ammunition, kills, level, key slots and the weapon panel. The face carries information: it reddens and scowls as health drops, tilts towards the direction of the last hit, and greys out on death.

Settings are sensitivity, field of view, volume, music and difficulty, stored in `localStorage` and applied while dragging. Field of view is stored the way the shader wants it, as the half width of the camera plane at unit distance, and presented in degrees, which is `2 * atan(fov)` in one direction and `tan(deg / 2)` in the other. Difficulty scales incoming damage and enemy speed.

## Testing

The machine this was built on reported the browser window as hidden, which means `requestAnimationFrame` never fired and the game could not be played during development at all. The harnesses are built around that constraint.

`test/logic.mjs` reads `index.html`, slices out the logic section and evaluates it under Node with `addEventListener`, `window` and `document` stubbed. It runs the real shipped code. 123 checks cover the five bit planes, the flow field routing around walls, stamina, the exit, the arena, cover being solid to movement and transparent to bullets, collision geometry over all 4096 cells, every weapon including ammunition and the dry-fire fallback, pickups, doors locked and unlocked, enemy pursuit, the alert memory, noise waking, casters keeping their range, fireballs hitting and being blocked, particle lifetimes and caps, difficulty scaling, the state machine, and forty generated levels.

`test/shader.html` renders twenty one scenarios on demand rather than in a frame loop, which is what lets it work in a hidden tab, and reads the pixels back so brightness is a number. It runs the real generator to render the level the player actually spawns into, renders the packed shader beside the original and fails unless every byte of both images matches, and runs content assertions on what a frame must contain, because two equally broken shaders still match each other. It also reports a 1080p frame cost.

`test/audio.html` injects an `OfflineAudioContext` in place of the real one and measures the samples: seventeen effects for audibility and clipping, stereo placement, distance falloff, and both sections of the song with onsets counted per bar.

## Size

The zip is 16,948 bytes, and the competition limit is 13,312. It does not fit. The measurements establishing why, along with the per feature cut sheet and the plan for a compliant build, live in the README section on the 13 KB build. In brief: with every piece of presentation stubbed at once the zip is still 13,731 bytes, rewriting code denser makes the artifact bigger because the compressor charges for unique information rather than for verbose structure, and the packing pipeline measures at its optimum. A compliant entry has to contain less game.

### Where the bytes are

```
source index.html                     130,608
  of which WGSL                        40,331
  of which script (includes the WGSL) 124,857

after minification
  WGSL, stripped and renamed           17,594
  script                               48,976
  stylesheet                            2,810
  markup                                1,636
  whole HTML document                  53,489

zipped
  minified HTML                        19,882
  Roadroller packed HTML (22,442)      16,948   <- shipped
```

The compressor has already taken everything repetition can give. Generating the settings rows and weapon slots from a table instead of eight near identical divs saved 21 bytes, and converting the seventeen sound effects to data tables with one interpreter grew the artifact by about 200, both A/B measured. Verbose repeated structure is nearly free under context mixing; the cost is in the unique numbers and decisions, and consolidation only concentrates those.

The largest factor is not in that table: the game has no data. Every texture, level, sprite, sound and piece of music is an expression evaluated at runtime, so the entire content is stored in the most compressible form there is, which is code with repeated structure.

### Decisions that cost nothing at runtime but save bytes

The map as bit planes rather than tile arrays. Three 64 by 64 byte arrays would be 12 KB of data to embed or generate; as bits they are 1.5 KB, and since they come from a seed they are zero bytes in the file.

Levels from a seed. A hand-authored level needs a map in the source; a generator is about 200 lines and produces unlimited levels, so the marginal cost of the twentieth level is nothing.

Textures from noise. `hash21`, `noise2` and `fbm` are about 20 lines and produce every surface in the game.

Sprites from primitives. Seven pickups, three enemies and three guns are drawn from rectangles and circles in shader code. The alternative is image data, which cannot be compressed to anything close.

Patterns as strings. Sixteen characters per bar, decoded with `parseInt(c, 36)`. No note objects, no frequency tables.

HTML for the interface. The browser already has a font renderer and a layout engine.

One shader, one pass, one pipeline. Every additional pipeline costs a descriptor, an entry point and the code to drive it.

### The packer

`build/pack.mjs` writes two candidates and ships the smaller.

**1. WGSL minification and renaming.** Comments go, whitespace collapses, and whitespace around punctuation is removed. WGSL has no string literals, so stripping line comments cannot damage anything, and whitespace is never significant outside identifiers and keywords. Removing spaces around punctuation also folds most newlines away, since almost every line ends in a brace, semicolon or parenthesis. Then identifiers are shortened: names are collected from declaration sites only, checked against WGSL's own vocabulary and against the two entry points the JavaScript names, and replaced with generated names that are verified not to occur in the source. Together this takes the shader from 26,428 bytes to 12,415.

Both passes live in `build/wgsl-min.mjs` so `test/shader.html` can import the same functions, render every scenario through the original and the packed shader, and fail unless the two images match byte for byte. Renaming identifiers in a language this file does not parse would be reckless without that check; with it, the check is what makes the pass safe.

**2. The IIFE wrap.** esbuild in transform mode will not rename top level bindings, because in a module they could be exported and in a script they could be read from elsewhere. Wrapping the whole script in `(()=>{ ... })()` makes every binding a local of an arrow function, and esbuild then renames all of them. This is the single most effective step on the JavaScript and is why the script drops by 56% rather than about 35%.

**3. Property mangling.** esbuild renames an explicit list of about sixty property names the game owns and nothing else reads, worth roughly 750 bytes. It is a list rather than a pattern because a pattern that catches something the browser owns, `.value` or `.width`, produces a game broken in a way no error message describes. The names actually renamed are written to `dist/mangle-cache.json` so the list can be audited against reality. Coordinates were tried and taken back out: `x`, `y`, `w` and `h` together saved one byte, because Roadroller already models a repeated name almost perfectly, and they carry the most risk of collision.

**4. CSS and HTML.** esbuild minifies the stylesheet. The HTML shell is rebuilt rather than minified in place: `html`, `head` and `body` are optional tags and are dropped, and attribute quotes are removed where the value has no spaces.

For the packed build the stylesheet and the markup are moved inside the script and injected at startup, which is worth about 750 bytes. Roadroller only compresses what it is given, and it is given the script; left in the document, the CSS and the elements are bytes only DEFLATE ever sees, and DEFLATE is much worse at them than context mixing is.

**5. Roadroller.** DEFLATE, which is what a zip uses, is LZ77 plus Huffman with a 32 KB window and no model of what JavaScript looks like. Roadroller is a context mixing compressor: several models each predict the next character from a different length of preceding context, a logistic mixer combines them with weights that adapt as it goes, and the result is arithmetic coded. On minified JavaScript that beats DEFLATE substantially, because the next character in source code is highly predictable from the previous few. The packed document is 22,442 bytes against 53,489 for the plain minified one; after zipping the gap narrows to 16,948 against 19,882, because DEFLATE still finds a lot in ordinary minified JavaScript and almost nothing in Roadroller's output, which is close to random by construction.

Its optimizer searches at random and lands a few bytes apart on each run, so the packer takes the best of three passes.

**6. The zip container.** Written by hand rather than shelled out to `zip`, which writes extra fields, timestamps and platform metadata that this does not: a 30 byte local header, a 46 byte central directory entry, a 22 byte end record and two copies of the ten character filename. That is nine bytes under `zip -9 -X` on the same data. The DEFLATE stream inside it comes from Zopfli at 200 iterations, which spends seconds to save a few tens of bytes over zlib and falls back to zlib when the package is missing. The build reads its own archive back through its headers, inflates it and compares before succeeding.

Roadroller's output is not ASCII, so that variant declares `charset=utf-8`; without it a browser may decode the packed string differently from how it was written and the decoder produces nonsense. The plain variant is pure ASCII and needs no declaration.

### Tried, measured, and closed

Explicit Roadroller model configurations lose to its automatic search. Its memory budget swept from 150 MB to 900 MB moves the artifact by less than its own run to run noise. Keeping identifier names instead of mangling, on the theory that a context mixer prefers consistent long names, loses by two kilobytes. Rounding numeric literals saves nothing until it is coarse enough to change gameplay. Consolidating repeated code into data tables grows the artifact. What remains is the game itself.

## Non-obvious failures

Bugs from the build that were not visible by reading the code. They are recorded because the same mistakes are easy to repeat.

**Stale uniform data.** The map was copied into the uniform buffer once at setup, which ran before the first level was generated, so the GPU held an all-zero grid and the game rendered with no interior walls at all. It presented as a rendering fault, which sent the investigation to the wrong file. Any buffer written once at startup and then regenerated later has this problem.

**An unbounded test in screen space.** The muzzle bore of each weapon was drawn with `q.y > 0.70 && ax < 0.055`, with no upper bound, and set coverage. Everything above the barrel in that narrow column is also above 0.70, so it painted a black bar from the gun to the top of the screen. The original pistol never set coverage on that line, which is why the bug only appeared once the other two weapons were written from it. In screen space, an open ended comparison always reaches the edge of the screen.

**Pattern alignment against the grid.** Floor tiles were laid out with grout at half-integer coordinates while walls stand on integer boundaries. Since the player spawns at a cell centre, a grout line ran along the view axis through the crosshair permanently. The distance to the nearest integer is `0.5 - abs(fract(p) - 0.5)`, not `abs(fract(p) - 0.5)`.

**Cellular automata converging the wrong way.** Seeded at 54% open, the "wall if five neighbours are walls" rule erodes walls every pass, and five passes produced a single 81% open cavern rather than caves. The seeding fraction has to sit on the correct side of the rule's fixed point, which is not obvious from the rule.

**Generated content sealing itself off.** Cover placement used a neighbour count to avoid corridors, which is not sufficient: a run of three blocks can bridge a gap from a cell that looked open, cutting off part of the level. Across forty seeds this stranded fifteen enemies and keys. The fix is to flood fill after placing and undo the run if anything became unreachable. The same pass could also drop a block on the player's own spawn cell, which produced a player standing inside a wall.

**Inaudible by construction.** A footstep was a noise burst through a 480 Hz lowpass at a modest gain, and peaked at 0.007, which is silence. A lowpass that far down discards nearly all the energy in white noise. The code reads as correct and nothing raises an error, so the only way to find it is to render the sound and look at the sample values.

**A wipe needs something to wipe.** The screen melt went through three versions. Shearing the live scene per column distorted the image, and because the value ran from covered to clear the picture appeared to rise into place rather than the old one falling off it. Replacing that with a black curtain fixed the distortion and the direction but not the real problem: a curtain that covers the screen is a black screen, so every transition opened with a flash of black before anything appeared to melt. Doom does not slide darkness, it slides the outgoing frame. Getting it right meant keeping the last frame before a scene change in a texture and sampling it, which is the only texture in the program. The effect is defined by what is sliding, and neither of the first two versions had that thing at all.

**A transition effect tied to the states that update the world.** The melt advanced inside the function that runs enemies and timers, which does not run on a menu. Since building a level set the value, the first level built at startup left the menu behind a fully opaque wipe that never advanced. Anything that animates across a state change has to be driven by the frame loop, not by the state it is changing away from.

**Hand written uniform offsets have to obey the alignment rules.** Adding elevation meant new fields in the middle of the uniform header, and the shader rendered pure black. The cause was not the new code: WGSL aligns a `vec2f` to eight bytes and a `vec4f` to sixteen, so the `exit` field moved to the next boundary and shifted every array behind it, and the shader read the map out of the padding. Fixing it once by eye was not enough either, because a `vec3f` added as padding aligned to sixteen and pushed the arrays four floats further again. The header is now scalars only, padded to exactly 128 bytes so the arrays start at float 32 by construction, and the layout is computed by hand and checked rather than assumed. Anything that builds a uniform buffer from raw offsets needs that arithmetic written down.

**A rewrite dropped an invariant nothing was checking.** Restructuring the ray walk for elevation lost the vertical span test on full walls, so any ray entering a solid cell reported a wall at every pixel above its top edge and distant geometry smeared across the sky. The pixel identity harness stayed green because it compares the packed shader against the original and both were equally wrong. Content assertions on what a frame must contain, ceiling at the top of a corridor view, floor brighter than ceiling, raised ground changing the image against a flattened control, now guard what comparison cannot.

**The field is for points, a body is a box.** Flow field pathfinding parked enemies on wall corners: stepping due west along a cell's top edge clips the corner of the wall below, the move is refused every frame, and the enemy stands still against the corner. Steering at the centre of the next field cell pulls the body clear as it travels.

**Objects standing on the wrong floor.** Crates and door leaves took their base height from the elevation the ray had been crossing rather than from their own cell, so seen from a platform, a crate on lower ground drew as if it stood up on the platform. Anything with a base height reads it from its own cell.

**Input that means two things.** Clicking fires the weapon, and clicking also dismisses the game over screen. Killing the last enemy therefore restarted the level on the next trigger pull. Releasing the pointer lock before showing any screen separates the two meanings.

**A full screen element that says "click to continue".** The game over panel covers the viewport, and the handler that listens for the click is on the canvas underneath it, so the click landed on the panel and the game could not be continued at all. Every other screen has buttons and did not show the problem. A panel that instructs the player to click anywhere has to be transparent to clicks, which is `pointer-events: none`, and there is now a keyboard route as well.

**An implicit body is not there yet.** Moving the markup into the packed script meant setting `document.body.innerHTML` from a script that runs before any body content exists, and the parser only creates the body when it reaches content, so `document.body` was null. HTML makes the tag optional for the parser, but a script that runs before any body content still finds `document.body` null. Six bytes of `<body>` in the packed shell fixes it.

## Limitations

Verticality is one axis only. Floors have four elevations a quarter of a wall apart, which gives platforms and staircases, but there is still nothing above anything else: no bridges, no rooms stacked over rooms, no falling.

Enemy pathing is one flow field aimed at the player. Enemies cannot route towards anything else, patrol, or coordinate as a squad; what looks like flanking is the separation pass plus sideways drift.

Levels are assembled rather than designed. Rooms and caves both produce plausible spaces, but beyond the one arena per level nothing shapes them into encounters, so difficulty still comes mostly from counts.

The byte budget is not the reason for any of this. At 16,948 bytes there is room for roughly three times the current content before the 64 KB ceiling.

The largest remaining gap is that none of it has been played. Every number in the tuning, from fire rates to enemy speed to how far a growl carries, was chosen by reasoning and verified only for correctness, never for feel.
