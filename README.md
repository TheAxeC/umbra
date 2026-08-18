# umbra

A Doom-shaped first person shooter, rendered in WebGPU, distributed as one zipped `index.html`. Two builds come out of one source: the full game at 16,923 bytes, and the competition entry at 13,240, which fits the js13kGames 13,312 byte limit. See The 13 KB build below for what separates them.

The repository contains no assets. Wall textures, enemy sprites, the gun, level layouts, the music and the sound effects are all generated at runtime from code. Nothing is downloaded while the game runs, and the two packages in `package.json` are build tools that never reach the browser.

## What it does

Three weapons on two ammunition pools; health, armour, ammunition and keycards to pick up; doors that need the right key; three enemies that behave differently, one of which throws fireballs and one of which takes a magazine to put down; raised platforms and staircases to climb, wooden crates at waist height that you can shoot over but not walk through; blood that stays on the floor where it was spilt; a minimap; and levels that alternate between rooms and caves.

Everything is drawn from arithmetic: the guns have a gloved hand, a lit top edge and a bore that is a hole; the enemies have walk cycles, cylindrical shading and a dark rim that separates them from the wall behind. Sound is built the same way, every effect a transient over a body over a tail, through a reverb whose impulse response is generated at startup.

Enemies path around obstacles rather than pressing into the wall between you and them. Sound is muffled through walls, so a growl tells you roughly where something is and whether it can see you. Sprinting costs stamina. Each level has an exit to reach rather than a kill count to fill, and one room on the way seals behind you until it is empty. Scenes change with a Doom style melt: the outgoing frame slides down in ragged columns and the new level shows through the gap.

Underneath, the world is a 64 by 64 grid held in three bit planes: what blocks movement, what is waist high, and what is a door. A fragment shader casts one ray per pixel through those bits, so there is no vertex data, no mesh, and nothing drawn except a single fullscreen triangle. Walls, cover, doors, floor, ceiling, lamps, enemies, pickups, fireballs, particles, the gun, the screen effects and the minimap are all resolved inside that one shader invocation.

Collision, shooting and enemy line of sight read the same three arrays the shader reads. There is one copy of the world, so a render representation and a physics representation cannot disagree. The difference between the movement lookup and the sight lookup is one bit plane, and that difference is the entire cover mechanic.

Levels are generated from a seed. Clearing one advances the seed and carries your weapons forward; dying rebuilds the same level and takes them away.

`TECHNICAL.md` documents all of it, including how the file stays small.

## Controls

Click the canvas to lock the pointer.

```
WASD or arrows   move
mouse            look
click            fire
1 2 3            pistol, shotgun, chaingun (wheel also cycles)
E or space       open a door
shift            sprint, while stamina lasts
M                mute
escape           pause
```

Walking into a door opens it unless it is locked. Find the exit to finish a level. When you die or reach it the pointer unlocks, and a click or Enter continues.

## Running it

Chrome or Edge with WebGPU support. It has to be served over HTTP, because module scripts do not load from `file://`:

```
npm run serve          # python3 -m http.server 8000
```

Open `http://localhost:8000`. There is no build step and no `npm install` required to play. `index.html` runs exactly as it sits in the repository.

## Packing

```
npm install
npm run pack
```

Writes `dist/index.html` and `dist/umbra.zip`. The zip is the artifact the size is measured from.

```
css         3728 ->    2810 B
markup      1852 ->    1637 B
shader     40325 ->   17594 B
script    125989 ->   48974 B
source    139085 B

  minified  html  53488 B   zip  19863 B
roadrolled  html  22418 B   zip  16930 B   <- shipped
```

The packer reads `index.html` and works on a copy, so the source is never minified in place and there is only one version of the game to maintain. It strips the WGSL, minifies the script and stylesheet with esbuild, rebuilds a minimal HTML shell, and then compresses the script with Roadroller. Both the plain and the packed build get zipped, and the smaller one is written to `dist/`.

Roadroller's optimizer searches at random and lands a few bytes apart on each run, so the packer keeps the best of three passes. Each pass takes about ten seconds. Pass `--tries=1` while iterating.

`--tiny` builds the competition subset instead, writing `dist/umbra13.zip` and `dist/index13.html` beside the full artifact rather than over it. Regions of `index.html` are fenced with `TINY-OFF <name>` and `TINY-END` comments, and dropped when that name is selected; a `TINY-ON <name>: code` line is a comment in the full build and becomes live code in the small one, for stubbing whatever the dropped region used to provide. The markers sit inside a comment in whichever of the four languages they land in, cost nothing in either artifact, and an unbalanced fence or an unknown name stops the build. Naming regions individually is how a candidate cut gets measured before it is decided on:

```
npm run pack -- --tries=1 --tiny=minimap
```

## Tests

Three harnesses, none of which ship. All three read `index.html` and run the real code rather than a copy, so they cannot fall out of step with the game.

```
npm test               # node test/logic.mjs
```

Extracts the game logic from `index.html` and runs it headless. 172 checks covering the bit planes, collision and wall sliding, pathfinding around obstacles, stamina, the exit and the arena, cover being solid to movement and transparent to bullets, the DDA cast, every weapon including ammunition and the dry-fire fallback, pickups, locked and unlocked doors, enemy pursuit and the alert memory, fireballs, particles, difficulty, the state machine, and 60 generated levels including a flood fill that proves nothing is ever unreachable. The range runs to 60 because levels 45 and 49 used to hang. The last forty nine cover the fences: one asserts that every marker line closes whatever comment it opens, and then each of the fifteen cuts, taken alone and then all together, has to evaluate, generate twelve levels with an open start and open spawns, and play every surviving sound effect against a stubbed Web Audio API. That last one exists because a cut can take a binding its neighbours still call, and with no AudioContext every effect returns at its first line and hides it.

`test/shader.html` renders twenty one scenarios with hand-set uniforms, one frame at a time on demand, which means it works in a backgrounded tab where `requestAnimationFrame` never fires. It reads the pixels back, so brightness is measured rather than judged by eye, and it reports an approximate 1080p frame cost. It also runs the real generator to render the level the player spawns into, and renders the minified shader next to the original, failing unless the two images match byte for byte, plus content checks that assert what a frame is supposed to contain, because two equally broken shaders still match each other. It also compiles the shader of every `--tiny` cut, which is what catches a fence that removes a WGSL function and leaves a call to it; compilation is the whole check there, since a cut is meant to change the image.

`test/audio.html` renders the synth into an `OfflineAudioContext` and measures the samples: seventeen effects checked for audibility and clipping, stereo placement, distance falloff, and both sections of the song with onsets counted per bar. It needs no speakers and no user gesture, and it draws each waveform.

The browser harnesses are pages. Serve the repository and open `http://localhost:8000/test/shader.html` or `/test/audio.html`. Both cache aggressively once loaded, so add a query string after editing the source.

Neither fenced check is taken on trust: pointing the brute's stub at the function its cut removes turns the shader banner red on two of five variants, and correctly leaves `npm test` green, since that harness reads JavaScript and not WGSL. What neither covers is the part of `index.html` below the shader. The chaingun cut originally crashed in `updateHud`, which lives there, and was found by opening the build.

## Layout

```
index.html          the game
index.backup.html   a frozen copy from before the size work, kept on request
test/               three harnesses, build time only
build/              the packer
dist/               generated, gitignored, umbra.zip is the artifact
TECHNICAL.md        how everything works
CLAUDE.md           conventions for Claude Code sessions in this repo
```

`package-lock.json` is committed, and esbuild and Roadroller are pinned to exact versions. The byte count depends on which version of each tool produced it, so both are part of making a build reproducible.

## Competition rules

Built against the [js13kGames 2026 rules](https://js13kgames.com/2026/rules). Where it stands:

- **13,312 byte zip** containing `index.html` at the top level: `npm run pack -- --tiny` writes 13,240 bytes with one file at the top level. The full build is 16,923 and is not the entry.
- **No external resources**: nothing is fetched at runtime, no fonts, no analytics. The two npm packages are build tools.
- **Readable source**: this repository is the unmangled source, and the packer only ever writes to `dist/`.
- **localStorage**: keys are namespaced under `umbra.` and `localStorage.clear()` is never called.
- **Chrome and Firefox, no console errors**: clean in Chrome. **Not verified in Firefox**, and this is the real risk: the game is WebGPU only, so it needs a Firefox build with WebGPU enabled. A WebGL2 fallback would be a significant piece of work.
- **New content, own work**: yes.

## The 13 KB build

The full game does not fit the competition limit, and this is measured rather than suspected. Three results, each from stub-and-repack experiments against the real build:

- With every piece of presentation stubbed at once, sprites, guns, minimap, all sound, the music voices, the stylesheet and the menus, the zip is 13,731 bytes. Still 419 over. The core alone, entities, three AIs, the elevation raycaster, doors, generation, combat, exceeds the budget.
- Rewriting code denser makes the artifact bigger, not smaller. Converting the seventeen sound effects to data tables with one interpreter, byte-identical output, grew the zip by about 200 bytes, A/B tested twice in each direction. Roadroller charges almost nothing for verbose repeated structure; it charges for unique information, and consolidation only concentrates that.
- The packing pipeline is at its optimum. Explicit Roadroller configurations lose to its automatic search, keeping identifier names instead of mangling loses by two kilobytes, and rounding numeric literals does nothing until it is coarse enough to change the game.

So a compliant entry has to contain less game. The second build target exists: `--tiny` strips regions fenced by markers and writes `dist/umbra13.zip` next to the full `dist/umbra.zip`, described under Packing above. The full game loses nothing, the entry is a documented subset, and the repository builds both, which is what the rules ask of the submitted source. Fifteen regions are fenced: `arena`, `best`, `blood`, `brute`, `chaingun`, `effects`, `elevation`, `melt`, `minimap`, `music`, `notes`, `polish`, `rooms`, `settings` and `size`. Regions nest, because cuts overlap: the music slider is a row in the settings panel and has to go when either is selected. What each measures, and how that compares with the estimate it replaces, is in the table below. The rest of the cut list is still to be decided.

What each candidate cut is worth, measured one at a time against a gap of about 3,600 bytes. Combined savings run 15 to 20 percent lower than the sum, because the compressor shares context between similar code. Rows marked est are estimates where the crude measurement stub broke the build; the earlier one-at-a-time round put them near these values.

| cut | bytes | the entry loses |
|---|---|---|
| elevation (floor value, true removal larger) | 226 | stairs and platforms |
| music section B and the pad | 223 | the second half of the loop |
| minimap | 221 | the minimap |
| arena seal-in | 186 | the sealed room fight |
| screen melt and the frame snapshot | 180 | the Doom wipe |
| one layout only, keeping caves | 143 | rooms levels |
| blood decals | 63 | persistent blood |
| settings panel (est) | 300 | the sliders; keys still work |
| the brute (est) | 200 | the third enemy |
| stylesheet hard trim (est) | 400 | polish, not layout |
| chaingun (est) | 400 | the third weapon |
| effects thinned to about nine (est) | 250 | dry fire, switch, chimes |
| micro polish: shake, hurt direction glow, face animation, switch animation, stamina bar (est) | 300 | each tiny, together real |

Rows fenced in the source and measured through the real mechanism rather than through a stub, which is what `--tiny=<name>` reports. All against a 16,955 byte full build at `--tries=1`:

| fenced row | measured | estimated | the entry loses |
|---|---|---|---|
| `music` | 614 | 223 for section B and the pad | the whole song, the pad, the step clock, the music slider |
| `polish` | 552 | 300 for the polish plus 400 for a stylesheet trim | the face, the stamina bar, screen shake, the hurt direction glow, the weapon change animation |
| `settings` | 490 | 300 | the sliders, the panel and their stylesheet; the keys still work |
| `elevation` | 378 | 226 as a floor value | stairs and platforms |
| `minimap` | 308 | 221 | the minimap |
| `melt` | 302 | 180 | the Doom wipe and the frame snapshot |
| `arena` | 210 | 186 | the sealed room fight |
| `notes` | 196 | not on the sheet | the flashed pickup names and key prompts |
| `brute` | 182 | 200 | the third enemy |
| `rooms` | 173 | 143 | rooms levels, leaving caves |
| `chaingun` | 159 | 400 | the third weapon |
| `effects` | 150 | 250 | dry fire, weapon change, the chimes, locked doors, footsteps, the melee swing |
| `blood` | 130 | 63 | persistent blood |
| `best` | 92 | not on the sheet | the furthest level reached, and its localStorage entry |
| `size` | 0 | not on the sheet | nothing; it swaps two lines of menu text for accurate ones |

`npm run pack -- --tiny` writes 13,240 bytes to `dist/umbra13.zip`, against a limit of 13,312. The archive holds one file, `index.html`, at the top level.

No row can be put back. The smallest is `best` at 92 bytes and 72 are spare, so every row above is load bearing.

Most rows came in above their estimate and a few below, so the estimates were not biased in one direction, they were guesses. The two largest misses are the chaingun, estimated at 400 and measured at 159, and the effects, estimated at 250 and measured at 150. In both the compressor had already seen the shape of that code twice, so the third copy cost it almost nothing and removing it gave almost nothing back. The overlap discount was wrong by more: assumed at fifteen to twenty percent, measured at about one. The rows barely interact, which is why the sum of the sheet turned out to be close to what the sheet promised.

Four ways a fence goes wrong, all four met while writing these. A marker that is not a comment breaks only the unpacked source: `<!-- TINY-OFF polish` without its `-->` opened an HTML comment that swallowed the stamina cell, so `#stam` stopped existing and `updateHud` threw on the first frame, while both packed artifacts stayed perfect because the packer strips marker lines before it writes anything. A fence that strands its own dead code can cost more than it saves: cutting `rooms` without also cutting the corridor helpers and the room size constants made the artifact 55 bytes *larger*. A fence can take a binding its neighbours still need: cutting `music` took `noteHz` with it, which the pickup chime and the clear fanfare also call. And a fence can take one the *shader* needs: cutting the screen shake left the crosshair subtracting a vector that no longer existed. All four are caught now, by `npm test` checking that every marker closes its own comment, by measuring, by `npm test` playing every sound of every cut against a stubbed Web Audio API, and by `test/shader.html` compiling every cut. None of that replaces opening the unpacked `index.html` in a browser, which is the only thing that catches the first one directly.

Whole subsystems, measured by stubbing, as ceilings on what removing each one entirely could ever be worth:

| subsystem removed outright | bytes |
|---|---|
| all audio: seventeen effects, the song, the reverb, the synth | 1,469 |
| all level generation: both layouts, the automata, the flood fills, chokepoints, cover, elevation | 967 |
| three enemy shapes collapsed into one silhouette | 582 |
| all procedural textures flattened to solid colours | 486 |
| the gun sprite reduced to a rectangle | 393 |
| the generator replaced by an authored table of five levels | 95 |

The last row settles a question. Carlini's 13 KB Doom clone stores five hand-designed levels as compressed turtle-graphics programs of about 400 bytes each, and has no generator at all. Trading ours for the same deal saves 95 bytes, because his maps are polygons and ours is a grid: a grid does not encode cheaply enough to beat the code that draws it. At 967 bytes for unlimited levels the generator is the best value in the file and it stays.

The other rows say the gap does not close by subtraction. The top five sum to 3,897, discount to roughly 3,200, and describe a game with no sound, no textures, no generator, one enemy and no gun. Still short.

The 13 KB build is a demake, and now that every row is fenced it is one that can be described exactly rather than predicted. What survives is the raycaster, doors and keys, imps and casters, pistol and shotgun, cave levels, the exit, the pathfinding, occluded sound, nine sound effects and the status bar. What goes is the song, the settings panel, stairs and platforms, the minimap, the wipe, the sealed room, the brute, rooms levels, the chaingun, seven effects, blood, the face, the stamina bar, screen shake, the hurt glow, the weapon change animation, the flashed messages and the furthest level record.

One constraint remains. The Firefox requirement is the gate that decides whether an entry is possible at all: the game is WebGPU only and has never been run in Firefox, so that check outranks anything else left on this page. The competition theme is not a constraint here, because umbra is not the entry being built for it.

Subtraction alone looked like it would not reach the limit, so the idea was to buy the difference back out of the shader, where the sprites, the gun and the surfaces are each written as bespoke arithmetic: one parameterised evaluator fed three tables of numbers, keeping all three enemies at a fraction of the bytes. It was built and measured, and it loses by 188 bytes. `TECHNICAL.md` records why under Tried, measured, and closed, and the short version is that it is the sound effect result again: the structure this removes was already nearly free, and the constants it moves into a table are what actually cost. The gun and the surfaces would consolidate the same way and are not worth attempting.

So headroom cannot be bought back, and the entry is whatever survives the cut sheet. Every row is fenced and measured rather than estimated, and together they land it at 13,240 against a 13,312 limit.

## Status

Playable start to finish with progression. The remaining honest gap in the design is that levels are assembled rather than designed: difficulty comes from counts, not from encounters. The last section of `TECHNICAL.md` covers it.

Both builds have been opened in Chrome and driven far enough to confirm they start, render, take input and change scene without console errors. That is as far as it goes: nobody has played a level through for feel, so every tuning number is still one that was reasoned about and tested for correctness rather than judged by playing. `requestAnimationFrame` does fire; an earlier note here said it did not, which was true of the machine at the time and is not true now.

No license yet.

## Name

Umbra is the fully shadowed core of an occlusion, where the light source is completely blocked. An optics term, appropriate for a raycaster, and short to type.
