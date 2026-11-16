/* Synthetic checks for src/core.js. Run: node tests/synthetic.test.js
   Every image here is generated, so the expected answer is known exactly. */
const AF = require("../src/core.js");
let failed = 0;
function ok(name, cond, detail) { console.log((cond ? "ok   " : "FAIL ") + name + (detail ? "  " + detail : "")); if (!cond) failed++; }
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

/* A wall of horizontal courses (period P px) with random brick shades, stretched by k below y0. */
function wall(w, h, P, y0, k, noise, seed) {
  const R = rng(seed || 1), g = new Float32Array(w * h), shade = [];
  for (let i = 0; i < 4000; i++) shade.push(150 + R() * 40);
  for (let y = 0; y < h; y++) {
    const u = y <= y0 ? y : y0 + (y - y0) / k;            // source row
    for (let x = 0; x < w; x++) {
      const course = Math.floor(u / P), inCourse = u - course * P;
      const brick = Math.floor((x + (course % 2 ? 24 : 0)) / 48);
      let v = inCourse < 2 ? 95 : shade[(course * 37 + brick * 11) % 4000];
      g[y * w + x] = v + (R() - 0.5) * noise;
    }
  }
  return AF.blur(g, w, h, 1);
}

// 1. mapping round trip
{
  const p = { y0: 400, y1: 900, k: 1.5 };
  ok("unmapY above the boundary is identity", AF.unmapY(123, p) === 123);
  ok("unmapY inside the band", Math.abs(AF.unmapY(700, p) - 600) < 1e-9);
  ok("restoredHeight", Math.abs(AF.restoredHeight(1000, p) - (400 + 500 / 1.5 + 100)) < 1e-9);
}
// 2. repeating structure → k, for several factors
for (const k of [1.2, 1.45, 1.8]) {
  const g = wall(480, 900, 14, 430, k, 10, 3);
  const r = AF.findRepeatCandidates(g, 480, 900, 430, 900);
  ok("repeat cue recovers k=" + k, r.consensus && Math.abs(r.consensus.k / k - 1) < 0.03, r.consensus ? "got " + r.consensus.k.toFixed(3) + " from " + r.consensus.n + " strips" : "no consensus");
}
// 3. boundary from the period jump
{
  const g = wall(480, 900, 12, 470, 1.5, 10, 5), cl = AF.findBoundary(g, 480, 900);
  ok("findBoundary locates the row", cl && cl[0].strong && Math.abs(cl[0].y0 - 470) <= 6, cl ? "got y0=" + cl[0].y0 + " k=" + cl[0].k.toFixed(2) : "none");
}
// 4. controls: an unstretched wall must not produce a boundary, and reads as k≈1
{
  const g = wall(480, 900, 14, 430, 1, 10, 7), cl = AF.findBoundary(g, 480, 900);
  ok("no boundary on an unstretched wall", !cl || !cl.some(c => c.strong), cl ? cl.length + " weak clusters" : "none");
  const r = AF.findRepeatCandidates(g, 480, 900, 430, 900);
  ok("unstretched wall reads k≈1", r.consensus && Math.abs(r.consensus.k - 1) < 0.02, r.consensus ? r.consensus.k.toFixed(3) : "none");
}
// 5. the codec's 8 px block grid is not evidence
{
  const w = 480, h = 900, g = new Float32Array(w * h), R = rng(9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 128 + (y % 8 === 0 ? 6 : 0) + (R() - 0.5) * 2;
  const r = AF.findRepeatCandidates(AF.blur(g, w, h, 1), w, h, 430, 900);
  ok("8 px block grid is ignored", r.cands.length === 0, r.cands.length + " strips");
}
// 6. shapes
{
  const p = { y0: 300, y1: 1000, k: 1.4 };
  ok("square fully in the band", Math.abs(AF.kFromBox({ x: 10, y: 400, w: 50, h: 70 }, p, 1).k - 1.4) < 1e-9);
  ok("square straddling the boundary", Math.abs(AF.kFromBox({ x: 10, y: 280, w: 50, h: 20 + 30 * 1.4 }, p, 1).k - 1.4) < 1e-6);
  ok("shape above the band gives no estimate", AF.kFromBox({ x: 10, y: 100, w: 50, h: 50 }, p, 1).k === null);
}
// 6b. horizontal squeeze: a circle above the band measures it; a square in the band then gives the vertical factor
{
  const p = { y0: 300, y1: 1000, k: 1.4, kx: 0.9 };
  ok("circle above the band measures the horizontal squeeze", Math.abs(AF.kxFromBox({ x: 50, y: 100, w: 90, h: 100 }, p, 1).kx - 0.9) < 1e-9);
  ok("square in the band, squeeze accounted for", Math.abs(AF.kFromBox({ x: 10, y: 400, w: 45, h: 70 }, p, 1).k - 1.4) < 1e-9);
  ok("ignoring the squeeze would overstate the stretch", AF.kFromBox({ x: 10, y: 400, w: 45, h: 70 }, { y0: 300, y1: 1000, k: 1, kx: 1 }, 1).k > 1.5);
}
// 7. body prior inverts a stretched median body
{
  const r = AF.PRIORS.knee.p50, stature = 600, top = 100, sole = top + stature, knee = sole - r * stature, y0 = 380, k = 1.5;
  const st = y => (y <= y0 ? y : y0 + (y - y0) * k);
  const est = AF.bodyEstimate(st(top), st(knee), st(sole), { y0, y1: 2000, k: 1 }, "knee");
  ok("body prior recovers k for a median body", Math.abs(est.k50 - k) < 0.01, "got " + est.k50.toFixed(3) + " range " + est.kB.toFixed(2) + "–" + est.kA.toFixed(2));
}
// 8. gradual stretch: the mapping and the cues that depend on it
{
  const p = { y0: 300, y1: 1000, k: 1.5, ramp: 250 };
  let worst = 0;
  for (let y = 0; y <= 1100; y += 7) worst = Math.max(worst, Math.abs(AF.mapY(AF.unmapY(y, p), p) - y));
  ok("ramp: mapY undoes unmapY", worst < 1e-6, "worst " + worst.toExponential(1));
  // numeric integral of 1/scale
  let acc = 0; for (let y = 0; y < 1100; y++) acc += 1 / AF.scaleAt(y + 0.5, p);
  ok("ramp: unmapY is the integral of 1/scale", Math.abs(acc - AF.unmapY(1100, p)) < 0.05, acc.toFixed(2) + " vs " + AF.unmapY(1100, p).toFixed(2));
  ok("ramp of zero is the old hard step", Math.abs(AF.unmapY(700, { y0: 300, y1: 1000, k: 1.5, ramp: 0 }) - (300 + 400 / 1.5)) < 1e-9);
  // a true 120 px square whose top sits 40 px above the start of the ramp
  const top = 260, bot = AF.mapY(260 + 120, p);
  const kb = AF.kFromBox({ x: 100, y: top, w: 120, h: bot - top }, p, 1);
  ok("ramp: square across the ramp gives k", Math.abs(kb.k - 1.5) < 0.005, "got " + kb.k.toFixed(3));
  // body: true head 100, knee 760, sole 1000 (ratio 0.267) drawn through the ramp, read with the matching prior
  const H = AF.mapY(100, p), J = AF.mapY(760, p), S2 = AF.mapY(1000, { ...p, y1: 5000 });
  const kk = AF.kFromBody(H, AF.mapY(760, { ...p, y1: 5000 }), S2, { ...p, y1: 5000 }, 240 / 900);
  ok("ramp: body ratio gives k", Math.abs(kk - 1.5) < 0.005, "got " + kk.toFixed(3));
}
// 9. the stretch factor row by row: step, ramp, camera tilt, nothing
/* A brick wall drawn through any row/column mapping: src(x, y) -> [wall X, wall Y]. Dark poles every 170 px of wall X. */
function wallVia(w, h, P, src, noise, seed, poles) {
  const R = rng(seed || 1), g = new Float32Array(w * h), shade = [];
  for (let i = 0; i < 4000; i++) shade.push(150 + R() * 40);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = src(x, y), u = q[1], X = q[0], course = Math.floor(u / P), inCourse = u - course * P;
    const brick = Math.floor((X + (course % 2 ? 24 : 0)) / 48);
    let v = inCourse < 2 ? 95 : shade[(((course * 37 + brick * 11) % 4000) + 4000) % 4000];
    if (poles && ((X % 170) + 170) % 170 < 9) v = 40;
    g[y * w + x] = v + (R() - 0.5) * noise;
  }
  return AF.blur(g, w, h, 1);
}
{
  const W = 520, H = 1200;
  // (a) gradual: factor rises from 1 at row 420 to 1.3 at row 760
  const pr = { y0: 420, y1: H, k: 1.3, ramp: 340 };
  let f = AF.scaleProfile(wallVia(W, H, 16, (x, y) => [x, AF.unmapY(y, pr)], 10, 7), W, H);
  ok("profile: gradual stretch is recognised as a ramp", f && f.model === "ramp", f ? "model " + f.model : "no fit");
  ok("profile: ramp start, length and factor", f && Math.abs(f.y0 - 420) < 60 && Math.abs(f.rampLen - 340) < 110 && Math.abs(f.k / 1.3 - 1) < 0.04,
     f && f.y0 != null ? "start " + f.y0 + " length " + f.rampLen + " k " + f.k.toFixed(3) : "");
  ok("profile: the ramp is not put down to camera tilt", f && !f.tilted || (f && f.model === "ramp"), f ? "misfit tilt alone " + f.rms.tilt.toFixed(4) + ", with ramp " + f.rms.ramp.toFixed(4) : "");
  // (b) nothing done to the picture
  f = AF.scaleProfile(wallVia(W, H, 15, (x, y) => [x, y], 10, 8), W, H);   // 15, not 16: a 16 px period is treated as codec blocks
  ok("profile: untouched wall reads as no change", f && f.model === "none", f ? "model " + f.model : "no fit");
  // (c) camera tilted up at a flat wall: uprights meet at (xv, yv) above the frame, courses grow downwards
  const xv = 260, yv = -2600, ym = H / 2, D = ym - yv;
  const tiltSrc = (x, y) => [xv + (x - xv) * D / (y - yv), 4000 - D * D / (y - yv)];
  const gt = wallVia(W, H, 16, tiltSrc, 10, 9, true);
  f = AF.scaleProfile(gt, W, H);
  const trueGrowth = Math.pow((f ? f.ymax - yv : 1) / (f ? f.ymin - yv : 1), 2);
  ok("profile: camera tilt is seen as tilt, not as a filter", f && f.model === "none" && f.tilted && Math.abs(f.tilt.growth / trueGrowth - 1) < 0.05,
     f ? "model " + f.model + ", tilt growth ×" + f.tilt.growth.toFixed(3) + " (true ×" + trueGrowth.toFixed(3) + ")" : "no fit");
  // tilt and a gradual filter together: the filter part is still found
  const gboth = wallVia(W, H, 16, (x, y) => tiltSrc(x, AF.unmapY(y, pr)), 10, 12, true), eb = AF.uprightEdges(gboth, W, H);
  f = AF.scaleProfile(gboth, W, H, null);
  ok("profile: tilt plus ramp, the ramp is still found", f && f.model === "ramp" && Math.abs(f.k / 1.3 - 1) < 0.08 && Math.abs(f.y0 - 420) < 90,
     f && f.y0 != null ? "model " + f.model + " start " + f.y0 + " length " + f.rampLen + " k " + f.k.toFixed(3) + " tilt c·D " + (f.c * D).toFixed(2) : "no fit");
  const e = AF.uprightEdges(gt, W, H);
  ok("edges: uprights give the same tilt as the courses", e.ok && Math.abs(e.c * D - 1) < 0.25, e.ok ? "c·D = " + (e.c * D).toFixed(3) + " from " + e.lines.length + " edges" : "edges not usable (" + e.lines.length + ")");
  // (d) the ramp picture has plumb poles: the edges must say "no tilt"
  const e2 = AF.uprightEdges(wallVia(W, H, 16, (x, y) => [x, AF.unmapY(y, pr)], 10, 7, true), W, H);
  ok("edges: plumb uprights exclude tilt", e2.ok && Math.abs(e2.c) + 2 * e2.se < 0.5 / D, e2.ok ? "c = " + e2.c.toExponential(2) + " ± " + e2.se.toExponential(2) + " (tilt above needs " + (1 / D).toExponential(2) + ")" : "edges not usable");
  // (e) a small hard step stays a step
  f = AF.scaleProfile(wall(W, H, 16, 600, 1.1, 10, 11), W, H);
  ok("profile: a hard 1.10 step is not called a ramp", f && f.model !== "ramp", f ? "model " + f.model + (f.y0 != null ? " y0 " + f.y0 + " k " + f.k.toFixed(3) : "") : "no fit");
}
console.log(failed ? "\n" + failed + " test(s) failed" : "\nall synthetic tests passed");
process.exit(failed ? 1 : 0);
