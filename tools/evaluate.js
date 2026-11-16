#!/usr/bin/env node
/* 还原尺 unstretch — Copyright (C) 2026 songj33
   SPDX-License-Identifier: GPL-3.0-only

   Score src/core.js against a folder made by tools/make_dataset.py.

       node tools/evaluate.js data/gen

   Two questions per picture:
     auto    nothing given: does it find the boundary and the factor on its own?
     oracle  boundary given (as when a person drags the line): is the factor right?
   Only the background cues are scored here (repeating structure). The pose model runs in a browser. */
const fs = require("fs"), path = require("path");
const AF = require("../src/core.js");
const dir = process.argv[2] || "data/gen";
const labels = JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8"));

function readPGM(file) {
  const b = fs.readFileSync(file); let pos = 0; const tok = [];
  while (tok.length < 4) {
    while (b[pos] === 0x23) { while (b[pos] !== 0x0a) pos++; pos++; }       // comments
    let s = pos; while (b[pos] > 0x20) pos++;
    tok.push(b.toString("ascii", s, pos)); pos++;
  }
  const w = +tok[1], h = +tok[2], g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = b[pos + i];
  return { w, h, g };
}
/* The same decision the page makes from the background: a jump at one row, or a gradual rise. */
function autoAnswer(g, gb, w, h) {
  const a = AF.autoBackground(g, gb, w, h, null);
  if (!a.how || !a.adopt) return null;
  const note = "tilt " + (a.tilt.seen ? a.tilt.c.toExponential(1) + " from " + a.tilt.from : "none") + (a.open ? ", open-ended" : "");
  if (a.how === "ramp") return { y0: a.y0, k: a.k, ramp: a.ramp, how: "ramp", note };
  const r = AF.findRepeatCandidates(gb, w, h, a.y0, h, 0, a.tilt.c);
  if (!r.consensus || r.consensus.n < 2 || Math.abs(r.consensus.k - 1) < 0.03) return null;
  return { y0: a.y0, k: r.consensus.k, ramp: 0, how: "step", note };
}
function oracleAnswer(gb, w, h, y0, y1) {
  const r = AF.findRepeatCandidates(gb, w, h, Math.round(y0), Math.round(y1));
  return r.consensus && r.consensus.n >= 2 ? { k: r.consensus.k } : null;
}
const groups = {};
const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
for (const L of labels) {
  const im = readPGM(path.join(dir, L.id + ".pgm")), gb = AF.blur(im.g, im.w, im.h, 1);
  const src = L.source.kind === "procedural" ? "procedural/" + L.source.wall : "image/" + (L.source.file || "?").split(/[\\/]/).pop();
  const key = (process.argv.includes("--by-file") ? src : src.split("/")[0] + (L.source.wall ? "/" + L.source.wall : "")) + (L.tilt ? "  tilted" : "") + (L.control ? "  control" : L.ramp ? "  gradual" : "  stretched");
  const G = groups[key] || (groups[key] = { n: 0, auto: 0, autoOK: 0, autoBad: 0, dy: [], dk: [], orc: 0, orcOK: 0, orcBad: 0, odk: [] });
  G.n++;
  const a = autoAnswer(im.g, gb, im.w, im.h), o = L.ramp ? null : oracleAnswer(gb, im.w, im.h, L.y0, L.y1);
  if (a && process.argv.includes("--list"))
    console.log(L.id + "  truth: y0 " + L.y0 + " k " + L.k + (L.ramp ? " ramp " + L.ramp : "") + (L.tilt ? " tilt " + L.tilt : "") + (L.control ? " (control)" : "") +
      "   answer: " + a.how + " y0 " + a.y0 + " k " + a.k.toFixed(3) + (a.ramp ? " ramp " + a.ramp : "") + (a.note ? "   " + a.note : ""));
  if (a) {
    G.auto++;
    const ek = Math.abs(a.k / L.k - 1), ey = Math.abs(a.y0 - L.y0);
    // a gradual start has no sharp row: allow a third of the ramp
    if (!L.control && ek <= 0.05 && ey <= Math.max(12, 0.34 * (L.ramp || 0))) G.autoOK++; else G.autoBad++;
    if (!L.control) { G.dy.push(ey); G.dk.push(ek * 100); }
  }
  if (o) {
    G.orc++;
    const ek = Math.abs(o.k / L.k - 1);
    if (ek <= 0.05) G.orcOK++; else G.orcBad++;
    G.odk.push(ek * 100);
  }
}
const pad = (s, n) => String(s).padEnd(n), num = (x, d) => (isFinite(x) ? x.toFixed(d) : "–");
console.log(pad("group", 30) + pad("n", 5) + pad("auto: answered", 16) + pad("right", 7) + pad("wrong", 7) + pad("med |dy0|", 11) + pad("med |dk|%", 11) + pad("oracle: answered", 18) + pad("right", 7) + pad("wrong", 7) + "med |dk|%");
let T = { n: 0, autoBadCtl: 0, ctl: 0 };
for (const key of Object.keys(groups).sort()) {
  const G = groups[key];
  console.log(pad(key, 30) + pad(G.n, 5) + pad(G.auto, 16) + pad(G.autoOK, 7) + pad(G.autoBad, 7) + pad(num(median(G.dy), 0), 11) + pad(num(median(G.dk), 1), 11) + pad(G.orc, 18) + pad(G.orcOK, 7) + pad(G.orcBad, 7) + num(median(G.odk), 1));
}
console.log("\nright = factor within 5% (auto: and boundary within 12 px). On controls any auto answer is wrong;\nan oracle answer on a control is right when it says k≈1.");
