// Packs index.html into dist/umbra.zip, the artifact the project is scored on.
//
//   node build/pack.mjs [--tries=N] [--tiny[=name,name,...]]
//
// Nothing in build/ ships. The source is never minified in place: this reads
// index.html, works entirely on strings, and writes to dist/. There is one
// version of the game to maintain and it is the readable one.
//
// The chain, in order:
//
//   1. strip comments and whitespace from the WGSL, then shorten its identifiers
//   2. wrap the script in an IIFE and minify it with esbuild
//   3. minify the stylesheet
//   4. rebuild a minimal HTML shell around the two
//   5. compress the script with Roadroller, producing a second candidate
//   6. zip both candidates, verify both, ship the smaller
//
// Step 5 can lose. Roadroller output is close to incompressible, so if the
// script ever shrank far enough that DEFLATE did better on the plain build,
// packing would be counterproductive. Rather than assume, the build measures.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";

// Zopfli produces a DEFLATE stream that any unzip can read, spending far more
// time than zlib to do it. It is optional: if the package is missing the build
// still works, just a couple of hundred bytes larger.
let zopfli = null;
try {
  zopfli = (await import("@gfx/zopfli")).default;
} catch (e) {
  console.log("zopfli not installed, falling back to zlib");
}

async function bestDeflate(data) {
  const plain = deflateRawSync(data, { level: 9 });
  if (!zopfli) return plain;
  const packed = await new Promise((resolve) => {
    zopfli.deflate(data, { numiterations: 200 }, (err, out) => resolve(err ? null : out));
  });
  return packed && packed.length < plain.length ? Buffer.from(packed) : plain;
}
import * as esbuild from "esbuild";
import { Packer } from "roadroller";
import { minifyWgsl, renameWgsl, SHADER_RE } from "./wgsl-min.mjs";
import { applyFences } from "./fences.mjs";

const root = new URL("..", import.meta.url);
const src = readFileSync(new URL("index.html", root), "utf8");

// --- optional features ---------------------------------------------------------
//
// Regions of index.html are fenced with TINY-OFF/TINY-END markers and dropped
// when --tiny selects them, so the entry is a documented subset of the full
// game rather than a second copy of it. build/fences.mjs holds the pass and
// documents the markers; the tests import it too, so every cut is compiled and
// evaluated rather than assumed to work.
//
//   --tiny              drop every fenced region
//   --tiny=minimap      drop only these, which is how a cut is measured on its
//                       own before deciding whether to keep it

// Reported rather than thrown. An uncaught error here prints a stack whose top
// frame lands inside a minified dependency, and the one line that matters
// scrolls off the top of it.
function fail(message) {
  console.error("pack: " + message);
  process.exit(1);
}

const tinyArg = process.argv.find((a) => a === "--tiny" || a.startsWith("--tiny="));
const tiny = Boolean(tinyArg);
const only = tinyArg && tinyArg.includes("=")
  ? tinyArg.slice(7).split(",").map((s) => s.trim()).filter(Boolean)
  : null;

// The full build runs the same pass with nothing selected, so marker lines are
// stripped from both artifacts by one piece of code rather than two.
let fenced;
try {
  fenced = applyFences(src, (name) => tiny && (!only || only.includes(name)));
} catch (e) {
  fail(e.message);
}
const source = fenced.text;

for (const name of only || []) {
  if (!fenced.names.has(name)) {
    fail(`--tiny=${name}: no region is fenced under that name` +
      `\n  fenced regions: ${[...fenced.names].sort().join(", ") || "none"}`);
  }
}
const cutNames = [...fenced.names].filter((n) => tiny && (!only || only.includes(n))).sort();
if (tiny && !cutNames.length) console.log("--tiny: no fenced regions matched, this is the full game");

// --- pull the source apart ---------------------------------------------------

// Deliberately crude. The document is one file under our own control with a
// known shape, so an HTML parser would be a dependency bought for nothing. The
// throw matters more than the parsing: if someone reshapes index.html, the
// build stops instead of silently packing an empty string.
function between(text, open, close) {
  const a = text.indexOf(open);
  const b = text.indexOf(close, a + open.length);
  if (a < 0 || b < 0) throw new Error("could not find " + open);
  return text.slice(a + open.length, b);
}

const css = between(source, "<style>", "</style>");
const js = between(source, '<script type="module">', "</script>");
// Everything from the canvas to the script tag: the four elements of the HUD.
const body = between(source, "<canvas", '<script type="module">');

// --- WGSL --------------------------------------------------------------------

// The shader is a template literal inside the script, so it has to be minified
// before esbuild sees the script, and put back as a template literal. esbuild
// treats the contents of a template literal as opaque and will not touch it.
//
// minifyWgsl lives in its own module because test/shader.html imports the same
// function, renders the original and the minified shader, and fails unless the
// two images match byte for byte. Any change here is checked by that test.
const shaderMatch = source.match(SHADER_RE);
if (!shaderMatch) throw new Error("could not find the shader");
const wgsl = shaderMatch[1];
const wgslMin = renameWgsl(minifyWgsl(wgsl));

// --- JavaScript --------------------------------------------------------------

// The replacement is a function so that $ sequences in the shader text are not
// interpreted as replacement patterns by String.replace.
const jsWithMinWgsl = js.replace(SHADER_RE, () => "const SHADER = `" + wgslMin + "`;");

// esbuild in transform mode will not rename top level bindings, because in a
// module they might be exported and in a classic script they might be read from
// elsewhere on the page. Wrapping everything in an immediately invoked arrow
// function makes every binding a local of that function, and esbuild is then
// free to rename all of them to one and two characters. This is worth several
// kilobytes and is the reason the script drops by 53% rather than about 35%.
//
// Wrapping is only safe because the script has no imports, no exports and no
// top level await. It does have top level side effects, which run identically
// inside the IIFE.
const wrapped = "(()=>{" + jsWithMinWgsl + "})()";

// Property names the game owns and nothing else reads. esbuild renames these
// everywhere they appear, which is worth about a kilobyte because the entity
// update loops touch them on every object every frame.
//
// This is an explicit list rather than a pattern for one reason: a pattern that
// catches a property the browser also uses, say .value or .width, produces a
// game that is broken in a way no error message describes. Nothing here is a
// DOM, WebGPU or WebAudio property. The names actually renamed are written to
// dist/mangle-cache.json so the list can be audited against reality.
const OWN_PROPS = [
  "hp", "armour", "kills", "hurt", "dead", "cool", "gun", "flash", "firing",
  "walked", "bob", "shake", "hurtDir", "weapon", "have", "ammo", "keys",
  "spec", "swing", "fade", "growl", "alert", "tx", "ty", "strafe",
  "taken", "moving", "dmg", "pellets", "spread", "kick", "ranged", "reach",
  "sight", "vx", "vy", "vz", "cx", "cy", "kind", "life", "open", "key",
  "sensitivity", "difficulty", "fov", "volume", "music", "master", "noise",
  "ctx", "next", "step", "damage", "speed",
  // Added with the exit, stamina, melt and arena work.
  "walking", "stam", "melt", "switching", "cells", "armed", "sealed", "door",
  // Coordinates were tried here and taken back out: x, y, w and h together
  // saved one byte in the zip, because Roadroller already models a repeated
  // name almost perfectly, and they carry the most risk of colliding with
  // something the browser owns. Not worth it.
];
const jsResult = await esbuild.transform(wrapped, {
  minify: true,          // whitespace, identifiers and syntax
  target: "es2022",      // WebGPU implies a recent browser; no downlevelling
  format: "iife",
  legalComments: "none", // drop @license blocks, of which there are none anyway
  mangleProps: new RegExp("^(" + OWN_PROPS.join("|") + ")$"),
  mangleCache: {},
});
const jsMin = jsResult.code.trim();
// transform returns the cache rather than filling in the one it was handed.
const mangleCache = jsResult.mangleCache || {};

// The cache cannot contain anything the regex did not match, so this is a
// guard against the list being edited without thinking rather than a proof.
for (const name of Object.keys(mangleCache)) {
  if (!OWN_PROPS.includes(name)) throw new Error("mangled an unlisted property: " + name);
}

const cssMin = (await esbuild.transform(css, { loader: "css", minify: true })).code.trim();

// --- HTML --------------------------------------------------------------------

// Rebuilt rather than minified in place. html, head and body are all optional
// tags in HTML5 and the browser infers them, so the shell is just the doctype,
// a title, the stylesheet, the elements and the script.
function minifyBody(markup) {
  return ("<canvas" + markup)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n\s*/g, "")
    // Attribute quotes are optional when the value has no spaces or quotes.
    // The character class keeps this to simple values such as id=c or class=off
    // and leaves anything containing punctuation or entities alone.
    .replace(/(\w+)="([\w-]+)"/g, "$1=$2")
    .trim();
}

const bodyMin = minifyBody(body);

// charset is only needed for the Roadroller build. Its output contains
// characters outside ASCII, and without a declared encoding a browser may
// decode them differently from how they were written, which corrupts the packed
// string and produces a decoder that yields nonsense. The plain build is pure
// ASCII and reads identically under any of the encodings a browser might guess.
function shell(script, charset) {
  return "<!doctype html>" + (charset ? '<meta charset="utf-8">' : "") +
    "<title>umbra</title><style>" + cssMin + "</style>" + bodyMin +
    "<script>" + script + "</script>";
}

// The packed variant carries nothing but the script, which puts the stylesheet
// and the elements back itself.
//
// The body tag has to be here even though HTML says it is optional. Without it
// the parser has not created a body by the time the script runs, document.body
// is null and the first getElementById fails.
function bareShell(script) {
  return "<!doctype html><meta charset=\"utf-8\"><title>umbra</title><body><script>" +
    script + "</script>";
}

const plain = shell(jsMin, false);

// For the packed build, the stylesheet and the markup are moved inside the
// script and injected at startup.
//
// Roadroller only compresses what it is given, and it is given the script. Left
// in the document, the CSS and the elements are 5.8 KB that only DEFLATE ever
// sees, and DEFLATE is much worse at them than context mixing is. Folding them
// into the stream costs the few dozen bytes of the two injection calls and wins
// far more than that back. The plain build keeps them in the document, so the
// readable artifact stays readable.
//
// The injection has to run before the game does, since the game looks elements
// up by id as soon as it starts, and it does: these are statements in front of
// the IIFE, in the same script.
const bodyPacked = bodyMin.replace(/&middot;/g, "\u00b7");
const injected = "document.head.insertAdjacentHTML('beforeend'," +
  JSON.stringify("<style>" + cssMin + "</style>") + ");" +
  "document.body.innerHTML=" + JSON.stringify(bodyPacked) + ";" + jsMin;

// --- Roadroller ---------------------------------------------------------------

// Roadroller is a context mixing compressor for JavaScript. Several models each
// predict the next character from a different length of preceding context, a
// logistic mixer combines their predictions with weights that adapt as it goes,
// and the result is arithmetic coded. It beats DEFLATE on minified JS by a wide
// margin because DEFLATE only matches repeated byte runs within a 32 KB window
// and has no model of the structure of source code. The output is the packed
// data plus a small decoder that evals the result.
//
// The optimizer searches at random and lands a few bytes apart from run to run,
// so take the best of several passes. Each costs roughly ten seconds, hence the
// escape hatch for iteration.
const triesArg = process.argv.find((a) => a.startsWith("--tries="));
const tries = triesArg ? Math.max(1, parseInt(triesArg.slice(8), 10)) : 3;

let packed = null;
for (let i = 0; i < tries; i++) {
  try {
    const packer = new Packer([{ data: injected, type: "js", action: "eval" }], {});
    await packer.optimize(2);
    const { firstLine, secondLine } = packer.makeDecoder();
    const candidate = bareShell(firstLine + secondLine);
    if (!packed || candidate.length < packed.length) packed = candidate;
  } catch (e) {
    // A failed pass is survivable: the plain build is still a valid artifact.
    console.log("roadroller pass failed: " + e.message);
  }
}
if (!packed) console.log("roadroller unavailable, shipping plain minification");

// --- zip ----------------------------------------------------------------------

// CRC-32 with the reversed polynomial 0xEDB88320, which is what the zip format
// specifies. Table built once at module load.
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Written by hand rather than shelled out to the zip command, which writes
// extra fields, timestamps, and version and platform metadata that this does
// not. The saving is about nine bytes on the same compressed data. Small, but
// this is a project scored in bytes and the code is forty lines.
//
// Layout of the archive produced here, for a single stored file:
//
//   local file header        30 bytes
//   file name                10 bytes ("index.html")
//   deflated data            n bytes
//   central directory entry  46 bytes
//   file name again          10 bytes
//   end of central directory 22 bytes
//
// deflateRawSync rather than deflateSync because zip stores a raw DEFLATE
// stream with no zlib wrapper around it.
async function makeZip(name, contents) {
  const data = Buffer.from(contents, "utf8");
  const body = await bestDeflate(data);
  const nameBuf = Buffer.from(name, "ascii");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);    // signature "PK\3\4"
  local.writeUInt16LE(20, 4);            // version needed to extract, 2.0
  local.writeUInt16LE(0, 6);             // general purpose flags, none set
  local.writeUInt16LE(8, 8);             // compression method, 8 is deflate
  local.writeUInt32LE(0, 10);            // modification time and date, zeroed
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);  // compressed size
  local.writeUInt32LE(data.length, 22);  // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  // bytes 28..29 are the extra field length, left at zero

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);  // signature "PK\1\2"
  central.writeUInt16LE(20, 4);          // version made by
  central.writeUInt16LE(20, 6);          // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);          // offset of the local header, first file

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // signature "PK\5\6"
  end.writeUInt16LE(1, 8);               // entries on this disk
  end.writeUInt16LE(1, 10);              // entries total
  end.writeUInt32LE(central.length + nameBuf.length, 12);        // central dir size
  end.writeUInt32LE(local.length + nameBuf.length + body.length, 16);  // its offset

  return Buffer.concat([local, nameBuf, body, central, nameBuf, end]);
}

// Read the archive back through its own headers, inflate it, and compare
// against what went in. A malformed zip fails at whoever opens it, not here.
function verifyZip(zip, expected) {
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error("zip: bad local header");
  const nameLen = zip.readUInt16LE(26);
  const extraLen = zip.readUInt16LE(28);
  const comp = zip.readUInt32LE(18);
  const start = 30 + nameLen + extraLen;
  const round = inflateRawSync(zip.subarray(start, start + comp)).toString("utf8");
  if (round !== expected) throw new Error("zip: contents do not round trip");
  if (zip.readUInt32LE(14) !== crc32(Buffer.from(expected, "utf8"))) {
    throw new Error("zip: crc mismatch");
  }
  if (zip.readUInt32LE(zip.length - 22) !== 0x06054b50) throw new Error("zip: bad end record");
}

// --- pick the winner and write it out ------------------------------------------

const candidates = [{ label: "minified", html: plain }];
if (packed) candidates.push({ label: "roadrolled", html: packed });
for (const c of candidates) {
  c.zip = await makeZip("index.html", c.html);
  verifyZip(c.zip, c.html);
}

const best = candidates.reduce((a, b) => (b.zip.length < a.zip.length ? b : a));

// The small build writes beside the full one rather than over it, so a --tiny
// run can never leave dist/umbra.zip holding less game than its name says.
const tag = tiny ? "13" : "";

mkdirSync(new URL("dist/", root), { recursive: true });
writeFileSync(new URL(`dist/index${tag}.html`, root), best.html);
// The unpacked build is kept because a Roadroller artifact is impossible to
// read when something goes wrong in the browser. This one is at least greppable.
writeFileSync(new URL(`dist/index${tag}.min.html`, root), plain);
writeFileSync(new URL(`dist/umbra${tag}.zip`, root), best.zip);
writeFileSync(new URL(`dist/mangle-cache${tag}.json`, root), JSON.stringify(mangleCache, null, 2));

const pad = (s, n) => String(s).padStart(n);
console.log("css      " + pad(css.length, 7) + " -> " + pad(cssMin.length, 7) + " B");
console.log("markup   " + pad(body.length, 7) + " -> " + pad(bodyMin.length, 7) + " B");
console.log("shader   " + pad(wgsl.length, 7) + " -> " + pad(wgslMin.length, 7) + " B");
console.log("script   " + pad(js.length, 7) + " -> " + pad(jsMin.length, 7) + " B");
console.log("source   " + pad(src.length, 7) + " B" +
  (tiny && source.length !== src.length ? "  -> " + pad(source.length, 7) + " B fenced" : ""));
if (cutNames.length) console.log("dropped  " + cutNames.join(" "));
console.log("");
for (const c of candidates) {
  console.log(pad(c.label, 10) + "  html " + pad(c.html.length, 6) +
    " B   zip " + pad(c.zip.length, 6) + " B" + (c === best ? "   <- shipped" : ""));
}
console.log(`\ndist/umbra${tag}.zip  ` + best.zip.length + " B   " +
  (best.zip.length / 13312 * 100).toFixed(1) + "% of the 13 KB checkpoint   " +
  (best.zip.length / 65536 * 100).toFixed(1) + "% of the 64 KB ceiling");
