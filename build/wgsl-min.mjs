// WGSL minifier, shared between the packer and the shader test.
//
// build/pack.mjs uses it to shrink the shader before shipping. test/shader.html
// imports the same function, renders every scenario through the original and
// the minified shader, and fails unless the two images are identical byte for
// byte. That test is the reason this can be edited with any confidence, so keep
// this module dependency free and importable from a browser.
//
// It halves the shader, 11,924 bytes down to 5,939, which is mostly comments
// and indentation. It does not rename identifiers. Renaming would save perhaps
// another 200 bytes before packing and considerably less after, since Roadroller
// already models repeated identifiers well.

// Two properties of WGSL make this safe, and both are worth stating because
// neither holds for JavaScript:
//
//   1. There are no string literals in the language, so a // sequence is always
//      the start of a comment and can never appear inside data.
//   2. Whitespace is only significant where it separates two identifiers or
//      keywords, never around punctuation.
//
// Anything relying on those two facts is fine. Anything cleverer, such as
// dropping the space in "let x", is not, and is not attempted here.
export function minifyWgsl(code) {
  return code
    // Line comments. There are no block comments in this shader; if any are
    // added, extend this.
    .replace(/\/\/[^\n]*/g, "")
    // Runs of spaces and tabs collapse to one.
    .replace(/[ \t]+/g, " ")
    // Indentation and trailing space around newlines.
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n+/g, "\n")
    // Whitespace around punctuation. This also removes most of the remaining
    // newlines as a side effect, because nearly every line of WGSL ends in a
    // brace, a semicolon or a parenthesis. Note that "->" survives as "->" and
    // ">>" as ">>", since only the surrounding whitespace is touched.
    .replace(/\s*([{}()<>,;:=+\-*/%&|!?[\]])\s*/g, "$1")
    .trim();
}

// The shader is stored as a template literal, so both the packer and the tests
// find it the same way. Capture group 1 is the WGSL itself.
export const SHADER_RE = /const SHADER = `([\s\S]*?)`;/;

// Identifier renaming, applied after minifyWgsl.
//
// Worth roughly two kilobytes before packing. It is safe here for the same
// reason the whitespace pass is: test/shader.html renders every scenario
// through the original and the renamed shader and fails unless the images are
// identical, so a mistake cannot reach the artifact quietly.
//
// Names are collected from declaration sites only, never from uses, so nothing
// is renamed unless this file can see where it was introduced. The entry points
// vs and fs are excluded because the JavaScript names them when it builds the
// pipeline, and WGSL's own vocabulary is excluded because a struct field could
// legitimately be called "step".
const RESERVED = new Set(`
vs fs
array atomic bool f16 f32 i32 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2
mat4x3 mat4x4 ptr sampler sampler_comparison texture u32 vec2 vec3 vec4 vec2f
vec3f vec4f vec2i vec3i vec4i vec2u vec3u vec4u
alias break case const const_assert continue continuing default discard else
enable fn for if let loop override return struct switch var while
abs acos all any asin atan atan2 ceil clamp cos cosh cross degrees determinant
distance dot exp exp2 faceForward floor fma fract inverseSqrt length log log2
max min mix modf normalize pow radians reflect refract round saturate select
sign sin sinh smoothstep sqrt step tan tanh transpose trunc
builtin location group binding vertex fragment compute workgroup_size
position vertex_index instance_id front_facing frag_depth
`.trim().split(/\s+/));

export function renameWgsl(code) {
  const names = new Set();
  const take = (re, group = 1) => {
    for (const m of code.matchAll(re)) names.add(m[group]);
  };
  take(/\bfn\s+([A-Za-z_]\w*)/g);                 // function names
  take(/\b(?:let|var|const)\s+([A-Za-z_]\w*)/g);  // locals and constants
  take(/\bstruct\s+([A-Za-z_]\w*)/g);             // struct names
  // Struct fields and function parameters, both of which are "name : type".
  take(/([A-Za-z_]\w*)\s*:\s*(?:array|atomic|ptr|[a-z]\w*)/g);

  const targets = [...names].filter((n) => !RESERVED.has(n) && n.length > 1).sort();

  // Generated names are checked against the source so a rename can never
  // collide with an identifier that was left alone.
  const out = [];
  let i = 0;
  for (const name of targets) {
    let short;
    do {
      short = "z" + (i++).toString(36);
    } while (new RegExp("\\b" + short + "\\b").test(code));
    out.push([name, short]);
  }

  let renamed = code;
  for (const [from, to] of out) {
    renamed = renamed.replace(new RegExp("\\b" + from + "\\b", "g"), to);
  }
  return renamed;
}
