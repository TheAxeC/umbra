# umbra

A Doom-shaped shooter in WebGPU, in a single HTML file. No assets and no libraries. The textures, the sprites, the levels, the music and the sound effects are all made up at runtime by code.

Chrome or Edge. Firefox only has WebGPU on Windows and Apple Silicon.

## Running it

```
npm run serve
```

and open `http://localhost:8000`. There is no build step, the file in the repo is the game. You need the server only because module scripts will not load off `file://`.

```
WASD / arrows    move
mouse            look
click            fire
1 2 3 / wheel    pistol, shotgun, chaingun
E / space        open a door
shift            sprint
M                mute
escape           pause
```

## Building

```
npm install
npm run pack
```

That writes `dist/umbra.zip`, around 17k. Add `--tiny` and you get `dist/umbra13.zip` instead, which fits the js13k limit.

The small one is the same file with chunks fenced off and cut out at pack time, so there is only ever one game to keep working. What it loses: the music, the settings screen, stairs and platforms, the minimap, the screen wipe, the sealed room, the brute, the room-and-corridor levels, the chaingun, half the sound effects, blood, the face, the stamina bar, screen shake, the hurt glow, the weapon change animation, pickup messages and the best-level record.

Cutting one fence on its own with `--tiny=minimap` is how I found out what each was worth. TECHNICAL.md lists them.

Packing takes half a minute because Roadroller searches at random and the packer runs it three times and keeps the best. `--tries=1` if you are just checking something.

## Tests

```
npm test
```

and `test/shader.html` and `test/audio.html` in the browser. Those two are pages, so serve the repo and open them. They cache, so stick a query string on the end after you edit something.

The shader one renders scenarios and diffs the pixels. The audio one renders the synth offline and measures the samples, so neither needs anyone to sit and look at it.

## Todo

- Play it. Nothing has been tuned by feel, only by test.
- Try it in Firefox. js13k requires it and nobody has opened it there.
- Do something about difficulty. Right now it is just enemy counts going up.

MIT licensed.
