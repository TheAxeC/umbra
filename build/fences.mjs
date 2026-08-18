// Optional feature fences, shared between the packer and the tests.
//
// The competition entry has to contain less game than the full build, and the
// way not to do that is to fork the source, because two versions drift.
// Instead regions of index.html are fenced and removed on request:
//
//   TINY-OFF <name>    opens a region dropped from the small build
//   TINY-END           closes it
//   TINY-ON <name>: c  a line that is a comment in the full build and becomes
//                      the code c in the small one, for stubbing whatever the
//                      dropped region used to provide
//
// Markers are matched as a substring of a line and the whole line is removed,
// so the same three work inside a JavaScript, WGSL, CSS or HTML comment without
// this file knowing which language it is looking at.
//
// Regions nest, because cuts overlap. The music slider is a row in the settings
// panel and has to go when either name is selected, so a line is dropped if any
// region around it is selected.
//
// build/pack.mjs uses this to build dist/umbra13.zip. test/logic.mjs and
// test/shader.html import the same function so that every fenced variant is
// evaluated and compiled rather than assumed to work: a cut that leaves a
// dangling reference fails there instead of in the browser. That is the reason
// this module has no dependencies and must stay importable from a browser.

const OFF_RE = /TINY-OFF\s+([a-z0-9-]+)/;
const END_RE = /TINY-END/;
const ON_RE = /TINY-ON\s+([a-z0-9-]+)\s*:(.*)$/;

// Returns the text with the selected regions removed and their stubs enabled,
// plus the set of every name the source declares. shouldCut is called with a
// region name and decides whether this build keeps it.
//
// Throws on an unbalanced fence, which is a mistake in index.html rather than a
// condition to handle: the alternative is shipping the wrong amount of game.
export function applyFences(text, shouldCut) {
  const out = [];
  const names = new Set();
  const open = [];
  let line = 0;
  for (const source of text.split("\n")) {
    line++;
    const off = source.match(OFF_RE);
    if (off) {
      open.push(off[1]);
      names.add(off[1]);
      continue;
    }
    if (END_RE.test(source)) {
      if (!open.length) throw new Error(`line ${line}: TINY-END with no TINY-OFF open`);
      open.pop();
      continue;
    }
    // Tested before the enclosing-region case so that a stub nested inside
    // another region still works. It is dropped outright when something around
    // it is being cut, since the code it stands in for is going too.
    const on = source.match(ON_RE);
    if (on) {
      names.add(on[1]);
      // The stub only exists in the build that lost the region it stands in
      // for. Trailing */ and --> let the marker sit in a CSS or HTML comment.
      if (!open.some(shouldCut) && shouldCut(on[1])) {
        out.push(on[2].replace(/\s*(\*\/|-->)\s*$/, ""));
      }
      continue;
    }
    if (open.length) {
      if (!open.some(shouldCut)) out.push(source);
      continue;
    }
    out.push(source);
  }
  if (open.length) throw new Error(`unclosed TINY-OFF ${open.join(" inside ")}`);
  return { text: out.join("\n"), names };
}

// Every region name the source declares, sorted. Used by the tests to work out
// what to check without being told, so a new fence is covered the moment it is
// written rather than when someone remembers to add it to a list.
export function fenceNames(text) {
  return [...applyFences(text, () => false).names].sort();
}
