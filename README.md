# umbra

A Doom-shaped first person shooter, rendered in WebGPU, distributed as one zipped `index.html`. The current build is 16,948 bytes, which is over the competition limit; see The 13 KB build below.

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
css         3730 ->    2810 B
markup      1851 ->    1636 B
shader     40331 ->   17594 B
script    124857 ->   48976 B
source    130608 B

  minified  html  53489 B   zip  19882 B
roadrolled  html  22442 B   zip  16948 B   <- shipped
```

The packer reads `index.html` and works on a copy, so the source is never minified in place and there is only one version of the game to maintain. It strips the WGSL, minifies the script and stylesheet with esbuild, rebuilds a minimal HTML shell, and then compresses the script with Roadroller. Both the plain and the packed build get zipped, and the smaller one is written to `dist/`.

Roadroller's optimizer searches at random and lands a few bytes apart on each run, so the packer keeps the best of three passes. Each pass takes about ten seconds. Pass `--tries=1` while iterating.

## Tests

Three harnesses, none of which ship. All three read `index.html` and run the real code rather than a copy, so they cannot fall out of step with the game.

```
npm test               # node test/logic.mjs
```

Extracts the game logic from `index.html` and runs it headless. 123 checks covering the bit planes, collision and wall sliding, pathfinding around obstacles, stamina, the exit and the arena, cover being solid to movement and transparent to bullets, the DDA cast, every weapon including ammunition and the dry-fire fallback, pickups, locked and unlocked doors, enemy pursuit and the alert memory, fireballs, particles, difficulty, the state machine, and 40 generated levels including a flood fill that proves nothing is ever unreachable.

`test/shader.html` renders twenty one scenarios with hand-set uniforms, one frame at a time on demand, which means it works in a backgrounded tab where `requestAnimationFrame` never fires. It reads the pixels back, so brightness is measured rather than judged by eye, and it reports an approximate 1080p frame cost. It also runs the real generator to render the level the player spawns into, and renders the minified shader next to the original, failing unless the two images match byte for byte, plus content checks that assert what a frame is supposed to contain, because two equally broken shaders still match each other.

`test/audio.html` renders the synth into an `OfflineAudioContext` and measures the samples: seventeen effects checked for audibility and clipping, stereo placement, distance falloff, and both sections of the song with onsets counted per bar. It needs no speakers and no user gesture, and it draws each waveform.

The browser harnesses are pages. Serve the repository and open `http://localhost:8000/test/shader.html` or `/test/audio.html`.

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

- **13,312 byte zip** containing `index.html` at the top level: the container and layout are right, the size is not. See the next section.
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

So a compliant entry has to contain less game. The plan is a second build target from the same source: a `--tiny` flag in the packer strips regions fenced by markers and writes `dist/umbra13.zip` next to the full `dist/umbra.zip`. The full game loses nothing, the entry is a documented subset, and the repository builds both, which is what the rules ask of the submitted source. Not implemented yet; it is waiting on the cut list below being decided.

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

Everything on that sheet summed and discounted lands at roughly 13.1 to 13.5 KB: it closes the gap with nothing spare. So the 13 KB build is a demake. What survives is the identity, the raycaster, doors and keys, imps and casters, pistol and shotgun, cave levels, the exit, the pathfinding, occluded sound, the first music section, the status bar and the face. There is no composition of the sheet that keeps the stairs and the melt and the brute and the minimap.

Two constraints on timing. The competition theme is announced on 13 August and is a rated criterion, so the entry should hold about 300 bytes of headroom for a theme twist, making the effective target about 13,000. And the Firefox requirement is the gate that decides whether an entry is possible at all: the game is WebGPU only and has never been run in Firefox, so that check comes before any byte work.

Work is paused here, pending a decision on which rows of the sheet are struck.

## Status

Playable start to finish with progression. The remaining honest gap in the design is that levels are assembled rather than designed: difficulty comes from counts, not from encounters. The last section of `TECHNICAL.md` covers it.

None of it has been played. The machine it was built on reports its browser window as hidden, so `requestAnimationFrame` never fires there and every number in the tuning was reasoned about and tested for correctness rather than for feel.

No license yet.

## Name

Umbra is the fully shadowed core of an occlusion, where the light source is completely blocked. An optics term, appropriate for a raycaster, and short to type.
