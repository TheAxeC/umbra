# Notes on the code

## The map

64 by 64 cells. Three `Uint32Array(128)` bit planes, two words per row because JS bitwise is 32-bit. They cost nothing in the file, since a seed generates them.

```
SOLID     blocks movement
LOW       waist high: blocks movement, not sight or bullets
DOORBIT   this cell is a door; how far it has opened lives in doors[]
```

Two more planes hold a floor height, two bits per cell, four levels a quarter of a wall apart.

```js
function solidAt(cx, cy) {          // movement
  if (cx < 0 || cy < 0 || cx >= MAP_SIZE || cy >= MAP_SIZE) return true;
  return bitAt(SOLID, cx, cy);
}

function opaqueAt(cx, cy) {         // sight and bullets
  if (cx < 0 || cy < 0 || cx >= MAP_SIZE || cy >= MAP_SIZE) return true;
  return bitAt(SOLID, cx, cy) && !bitAt(LOW, cx, cy);
}
```

Cover is the gap between the two. Out of bounds reads solid in both. The raycaster and the collision code have no other bounds checks.

Nothing else describes the world. There is no collision mesh and no nav grid.

The shader reads the same words as `array<vec4u, 32>`. WGSL pads array elements to 16 bytes. Four words per element instead of `array<u32, 128>` saves 1.5 KB of uniform space.

## The renderer

One pass, one pipeline. The vertex shader builds a fullscreen triangle from `vertex_index`, and everything after that is per pixel.

```wgsl
let ndc = frag.xy / U.res * 2.0 - 1.0 + shake;   // x right, y down
let screenX = ndc.x * aspect * U.fov;
let sy = ndc.y + U.pitch + bobY;
let dir = vec2f(cos(U.ang), sin(U.ang));
let plane = vec2f(-dir.y, dir.x);
let rd = dir + plane * screenX;
```

`plane` is `dir` turned 90 degrees, both unit length. That gives `dot(rd, dir) == 1` everywhere, so the ray parameter is already a perpendicular distance and nothing in the shader corrects for fisheye. A hit is at `cam + rd * t`.

Heights run 0 to 1 up the wall, eye at 0.5:

```
sy = (0.5 - z) * 2 * WALL_HEIGHT / t        // WALL_HEIGHT 0.6
```

Wall tops, door leaf bottoms, cover tops, enemy feet, pickup bob, particle height all come out of that one line. Pitch shears `sy`. Wall columns stay vertical.

### The DDA does not stop at the first solid cell

Not every solid cell fills its column.

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
    continue;                                  // see under it
  }
  if (bitOf(1, cell)) {                        // cover
    let top = (0.5 - LOW_H) * 2.0 * WALL_HEIGHT / t;
    if (sy >= top && sy <= WALL_HEIGHT / t) { dist = t; hit = 2; break; }
    continue;                                  // see over it
  }
  dist = t; hit = 1; break;                    // wall
}
```

`t` is entry distance, `sideDist` before advancing. Elevation adds two more tests per cell: is this cell's floor visible at this pixel, and does the next cell step up far enough to show a riser.

`doorAt` linear-scans eight slots, only on cells carrying the door bit. Axis-aligned rays divide by zero, and the resulting infinity means that axis is never picked. `MAX_STEPS` 200.

### Floor and ceiling

Inverted height formula: ground at `WALL_HEIGHT / sy`, ceiling with the sign flipped, both guarded near the horizon where it goes NaN.

Cover tops come from a shortcut. The shader computes where the raised plane would be and takes that distance when the cell under it is cover. It is wrong by a few pixels along an edge occluded at a grazing angle.

Ground texture drops under a pixel around seven cells out and fades to flat by twenty.

### Texture

Texture noise is `fbm`, four octaves of a bilinear `noise2` over a `hash21` sine lattice. Walls take a material from a hash of the cell over three, so materials come in runs: concrete, rust, panels. Plus grain, per-cell jitter, seams at thirds, a vertical joint, rivets, grime.

Floor and ceiling tile to the wall grid, with edge distance `0.5 - abs(fract(p) - 0.5)`. Measuring to the half-cell puts a seam permanently under the crosshair.

No lighting pass, just fixed lambert against a constant sun and emissive lamps. One dynamic light rides on top:

```wgsl
color = color * (1.0 + U.flash * 2.2 * exp(-dist * 0.45));
```

### Sprites

Billboards in the same pass against the running `dist`. No sorting, no depth buffer.

Enemies and pickups are vertical cylinders: hit if the ray passes within the radius of the axis, two dot products for depth and horizontal position. `impShape`, `casterShape`, `bruteShape`, `pickShape` draw from primitives in that space.

An enemy's `z` channel is 1 alive, falling to 0 over 0.6s on death. Sprite height multiplies by it. The corpse squashes. Below 0.02 the slot is skipped.

Fireballs and particles are point sprites:

```wgsl
let px = dot(rel, plane) / depth;
let py = (0.5 - p.z) * 2.0 * WALL_HEIGHT / depth;
let dx = (screenX - px) / (size / depth);
let dy = (sy - py) / (2.0 * WALL_HEIGHT * size / depth);
if (dx * dx + dy * dy < 1.0) { ... }
```

Axes scale differently: horizontal is camera plane units, vertical is ndc. Both test the resolved depth, and being light sources they add after fog. A particle packs kind and life into one channel as `kind + life`.

### Gun, wipe, minimap

The gun is screen-space rectangles, origin bottom centre, y up. Recoil, weapon change and walk sway move it.

The wipe holds the last frame before a scene change in a texture, the only texture in the program, and slides it down in ragged columns over the new scene. It advances in the frame loop regardless of game state.

The minimap draws the same three bit planes in fifty lines of shader.

## The uniform buffer

One buffer, 4,288 bytes, rewritten every frame including all five map planes.

```
float   byte    contents
0       0       resolution, field of view, time
4       16      camera position, heading, pitch
8       32      gun recoil, muzzle flash, damage wash, death fade
12      48      walk phase, shake x, shake y, status bar height
16      64      eye height, weapon index, damage bearing, shake amount
20      80      key bits, exit x, exit y, wipe
24      96      weapon switch, then padding out to float 32
32      128     SOLID, 128 words
160     640     LOW, 128 words
288     1152    DOORBIT, 128 words
416     1664    floor height low bit, 128 words
544     2176    floor height high bit, 128 words
672     2688    enemies, 14 * vec4
728     2912    doors, 8 * vec4
760     3040    pickups, 12 * vec4
808     3232    fireballs, 10 * vec4
848     3392    particles, 40 * vec4
1008    4032    blood decals, 16 * vec4
```

Header is scalars only, padded to 128 bytes so the arrays start on a 16-byte boundary. Empty slots carry a negative in the last channel. Enemies use the third, since liveness 0 already means gone.

The map planes go up with the rest because a new level rewrites them.

## Game systems

Delta clamped to 0.1s. A tab switch cannot tunnel the player through a wall, and at 5.8 cells/sec that caps a frame at 0.58 cells.

The player is a square of half-width 0.22, legal when all four corners are open. Axes resolve separately for wall sliding, and a refused axis snaps flush to the boundary. One elevation step is climbable.

| | damage | cooldown | pellets | spread | ammo |
|---|---|---|---|---|---|
| pistol | 22 | 0.30 s | 1 | 0 | none |
| shotgun | 13 | 0.80 s | 8 | 0.10 rad | shells |
| chaingun | 11 | 0.09 s | 1 | 0.045 rad | bullets |

One ray per pellet from screen centre. `castWall` is the JS twin of the shader DDA.

Enemy AI is a short update over an eight second alert memory:

- Sight or being shot refreshes the alert and stores a last known position. Being shot counts from behind too, so you cannot farm one from its blind side.
- Gunfire wakes anything within 18 cells, sprinting within 7.
- Without a memory an enemy holds position. With one it follows a flow field, one breadth-first sweep from the player's cell, rebuilt on cell change, shared by all enemies, refusing edges taller than a climb.
- Enemies steer at the centre of the next field cell, off the corners. A separation pass and a sideways drift stop them arriving in single file.

## Level generation

One seed through an LCG, with `Math.imul` because the multiply overflows 32 bits. Layouts alternate.

Rooms: up to eleven rectangles by rejection sampling with a one cell gap, L-corridors centre to centre. Consecutive links guarantee connectivity, and three random extra links make it a graph.

Caves: cellular automata, five passes of majority-of-neighbours. The rule walls a cell at five of eight neighbours, which erodes minorities, so 54% solid collapses to one cavern and 58% gives caves at 38% open. Largest region kept, rest filled. Too small falls back to rooms on the same seed.

Then, both layouts:

- Doors in chokepoints, cells with exactly two opposite open neighbours.
- One locked door from level two. Its key goes inside the region reachable with that door shut, so it can never be behind the door it opens.
- Cover as short runs of waist-high blocks. Each run is placed, the level flood filled, and the run removed if anything became unreachable. Neighbour counting is not enough: a run of three can bridge a corridor from a cell that looked open.
- Platforms one or two steps up with a staircase down one side, on flat open ground.
- Exit on the farthest reachable cell from spawn.
- Arena: shut each unlocked door in turn and flood fill. One that seals a workable region on the exit side becomes the fight.
- Enemies ramp 5 to 14. Casters from level 2, brutes from level 3.

## Audio

One `AudioContext` on first click. Master gain to destination, music gain to master so it can duck. One second of white noise generated at startup and reused.

`envelope` wraps a source in a gain with linear attack and exponential decay. `tone` is an oscillator through it. `burst` is the noise buffer through a filter and an envelope, started at a random offset.

Reverb is a convolver over an impulse response made at startup: noise under exponential decay with a short fade-in. Effects hit a bus feeding dry and wet, music has a drier send. A compressor keeps a shotgun or a fireball from flattening everything else, and a makeup gain puts back the six or eight decibels it costs. Without that gain the growl and the footstep come out at nothing.

Enemy voices are a sawtooth through two bandpasses with noise breath and a sine body, one register each. Pan is the offset along the camera right vector, gain falls as `1 / (1 + d * d * 0.04)`.

Music is a step sequencer over packed strings, one char per sixteenth, `.` a rest, anything else a semitone in base 36 via `parseInt(c, 36)` where the NaN is the rest test. Two eight-bar sections with their own transposition tables. Voices: filtered saw bass, detuned squares, a three-saw pad, a pitch-dropping kick, noise snare and hats. Every other sixteenth lands late for swing. All pattern data is seven 16-char strings and two 8-number arrays.

Scheduling is lookahead against `ctx.currentTime` rather than the frame loop, so a dropped frame does not move the beat.

## Fences

Regions of `index.html` are marked and dropped by `--tiny`:

```
TINY-OFF <name>       open a region
TINY-END              close it
TINY-ON <name>: code  comment in the full build, live code in the small one
```

Markers match as a substring and the whole line goes. The same three work in a JS, WGSL, CSS or HTML comment. Regions nest. Both builds run the pass, the full one selecting nothing, so markers cost nothing either way. Unbalanced fences and unknown names stop the build.

The pass is `build/fences.mjs`, dependency free so the harnesses import it. `test/logic.mjs` evaluates every variant and generates twelve levels from each, then plays every surviving effect against a Proxy standing in for Web Audio. `test/shader.html` compiles every variant's shader.

Neither of them loads the unpacked `index.html` as a page, and the packer strips marker lines before it writes anything, so a marker that never closes its comment shows up in neither. Open the file in a browser after touching the markup.

## The packer

`build/pack.mjs` writes two candidates and ships the smaller.

1. **WGSL.** Comments, whitespace, whitespace around punctuation. WGSL has no string literals, so comment stripping is safe. Then identifiers, collected from declaration sites only, checked against the WGSL vocabulary and the two entry points JS names. Between them those two passes halve the shader. Shared with `test/shader.html` via `build/wgsl-min.mjs`, which renders both versions and demands identical pixels.
2. **IIFE wrap.** esbuild will not rename top-level bindings. Wrapping in `(()=>{...})()` makes them locals. Script drops 56% instead of 35%.
3. **Property mangling.** An explicit list of about sixty names the game owns, worth ~750 bytes. A pattern would catch `.value` or `.width` and break the game with no error. Renames land in `dist/mangle-cache.json`. Coordinates came back out: `x y w h` saved one byte total.
4. **CSS and HTML.** esbuild for the stylesheet. The shell is rebuilt from scratch: `html`, `head`, `body` dropped, attribute quotes dropped where safe. The packed build moves CSS and markup into the script, worth ~750 bytes, since Roadroller only compresses what it is given.
5. **Roadroller.** Context mixing: several models predict the next char from different context lengths, and a logistic mixer combines them into an arithmetic coder. It roughly halves the minified document, and about 3k of that survives the zip.
6. **Zip.** Written by hand: 30-byte local header, 46-byte central entry, 22-byte end record, two copies of the filename. Nine bytes under `zip -9 -X`. Zopfli at 200 iterations, falling back to zlib. The build inflates its own archive and compares before succeeding. Roadroller output is not ASCII, so that variant declares `charset=utf-8`.

## Size

Packed it comes to about 17k, and about 13k with the fences cut. The shader and the game logic are nearly all of it. The stylesheet and the markup together are a couple of kilobytes.

Fifteen fenced regions. Rough cost of each, measured by cutting it on its own:

| region | bytes | drops |
|---|---|---|
| `music` | 600 | song, pad, step clock, music slider |
| `polish` | 550 | face, stamina bar, shake, hurt glow, weapon change animation |
| `settings` | 490 | sliders and panel, keys still work |
| `elevation` | 380 | stairs and platforms |
| `minimap` | 310 | minimap |
| `melt` | 300 | wipe and frame snapshot |
| `arena` | 210 | sealed room fight |
| `notes` | 200 | pickup names, key prompts |
| `brute` | 180 | third enemy |
| `rooms` | 170 | rooms levels |
| `chaingun` | 160 | third weapon |
| `effects` | 150 | 7 of 16 sound effects |
| `blood` | 130 | decals |
| `best` | 90 | furthest level record |
| `size` | 0 | swaps two lines of menu text |

Cutting all fifteen saves a little less than adding those up. They barely share context.

Stubbing out a whole subsystem, for a sense of the ceilings:

```
all audio                                  1.4k
all level generation                       950
three enemy shapes collapsed to one        580
all procedural textures flattened          490
gun sprite reduced to a rectangle          390
levels from an authored table              95
```

The last one is worth knowing before anyone tries it. A grid does not encode cheaply enough to beat the code that draws it, so hand-authored levels buy almost nothing here. Polygon maps are another matter: Carlini's 13 KB Doom clone fits five hand-designed levels in a few hundred bytes each with no generator at all.

### Things that do not work

Parameterising the three enemy sprites into one evaluator plus three tables of numbers. The zip grew. Roadroller charges for unique information and almost nothing for repeated structure, so writing the assembly once removes what was already cheap, the constants survive the move, and a positional constructor has to spell out fields an enemy does not use. Sound effects as data tables fail the same way.

Tuning Roadroller by hand. Explicit model configurations lose to its automatic search, and its memory budget moves the result less than run-to-run noise does.

Keeping identifier names instead of mangling them, on the theory that a context mixer likes consistency. Loses two kilobytes.

Rounding numeric literals. Saves nothing until it is coarse enough to change how the game plays.

## Tests

`test/logic.mjs` cuts the file between `const MAP_SIZE` and the shader comment and evaluates it under Node with `addEventListener`, `window` and `document` stubbed. Nothing in that range may touch the DOM at module level. Roughly a third of the checks cover the fenced variants.

`test/shader.html` renders scenarios on demand, which keeps it working in a hidden tab, and reads the pixels back. It diffs the packed shader against the original byte for byte, asserts frame content since two equally broken shaders still match, compiles every fenced variant, and reports a 1080p frame cost.

`test/audio.html` swaps in an `OfflineAudioContext` and measures samples: every effect for audibility and clipping, stereo placement, distance falloff, both song sections with onsets per bar.

## Limits

Verticality is one axis: four floor elevations, with nothing standing above anything else.

Pathing is a single flow field aimed at the player and every enemy runs the same one. What looks like flanking is the separation pass and a sideways drift.

Generation stops at the layout. Past the one arena, nothing shapes a level into a sequence of encounters.
