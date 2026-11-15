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
console.log(failed ? "\n" + failed + " test(s) failed" : "\nall synthetic tests passed");
process.exit(failed ? 1 : 0);
