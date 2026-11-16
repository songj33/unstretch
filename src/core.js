/* 还原尺 unstretch — Copyright (C) 2026 songj33
   SPDX-License-Identifier: GPL-3.0-only */
/* 还原尺 core — pure functions, no DOM. Works in browsers and Node.
   Model: a leg-stretch filter is a 1-D row remap. Rows above y0 are untouched,
   rows in [y0, y1) were stretched vertically by k. Everything here estimates k. */
(function (root) {
  "use strict";
  var AF = {};

  AF.gray = function (rgba, w, h) {
    var g = new Float32Array(w * h);
    for (var i = 0, j = 0; i < g.length; i++, j += 4)
      g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return g;
  };

  /* Two box passes of radius r: close to a Gaussian with sigma ~ 0.8*r+0.4 */
  AF.blur = function (src, w, h, r) {
    if (r < 1) return new Float32Array(src);
    var a = new Float32Array(src), b = new Float32Array(w * h), n = 2 * r + 1, x, y, s, i;
    for (var pass = 0; pass < 2; pass++) {
      for (y = 0; y < h; y++) {
        s = 0; var row = y * w;
        for (i = -r; i <= r; i++) s += a[row + Math.min(w - 1, Math.max(0, i))];
        for (x = 0; x < w; x++) {
          b[row + x] = s / n;
          s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
        }
      }
      for (x = 0; x < w; x++) {
        s = 0;
        for (i = -r; i <= r; i++) s += b[Math.min(h - 1, Math.max(0, i)) * w + x];
        for (y = 0; y < h; y++) {
          a[y * w + x] = s / n;
          s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  };

  /* ---------- the mapping ---------- */
  /* The filter is a remap of rows. Rows above y0 are untouched. From y0 the local stretch factor
     rises linearly from 1 to k over `ramp` rows (ramp = 0: it jumps straight to k), stays at k
     down to y1, and is 1 again below y1.  p = {y0, y1, k, ramp}. */
  function rampOf(p) { return Math.max(0, Math.min(p.ramp || 0, p.y1 - p.y0)); }
  /* local stretch factor at stretched row y */
  AF.scaleAt = function (y, p) {
    if (y < p.y0 || y >= p.y1) return 1;
    var r = rampOf(p);
    return r > 0 && y < p.y0 + r ? 1 + (p.k - 1) * (y - p.y0) / r : p.k;
  };
  /* stretched y -> original y  (the integral of 1 / scale) */
  AF.unmapY = function (y, p) {
    if (y <= p.y0) return y;
    var r = rampOf(p), k = p.k, t = Math.min(y, p.y1) - p.y0, out = p.y0;
    if (r > 0) {
      var tr = Math.min(t, r), a = (k - 1) / r;
      out += Math.abs(k - 1) < 1e-9 ? tr : Math.log(1 + a * tr) / a; t -= tr;
    }
    out += t / k;
    return y > p.y1 ? out + (y - p.y1) : out;
  };
  /* original y -> stretched y  (inverse of unmapY) */
  AF.mapY = function (yt, p) {
    if (yt <= p.y0) return yt;
    var r = rampOf(p), k = p.k, t = yt - p.y0, y = p.y0;
    if (r > 0) {
      var a = (k - 1) / r, R = Math.abs(k - 1) < 1e-9 ? r : Math.log(k) / a;      // true height of the ramp
      if (t <= R) return Math.min(p.y1, y + (Math.abs(k - 1) < 1e-9 ? t : (Math.exp(a * t) - 1) / a));
      y += r; t -= R;
    }
    var rest = (p.y1 - y) / k;                                                      // true height of the plateau
    return t <= rest ? y + t * k : p.y1 + (t - rest);
  };
  AF.restoredHeight = function (h, p) { return AF.unmapY(h, p); };

  /* ---------- cue 1: repeating structure (bricks, tiles, railings) ---------- */
  /* Dominant vertical period of a column strip between rows ya..yb.
     Returns {period, snr}; snr = spectral peak / median amplitude. */
  AF.periodScan = function (g, w, h, x0, x1, ya, yb, guide, nf) {
    x0 = Math.max(0, x0 | 0); x1 = Math.min(w, x1 | 0);
    ya = Math.max(1, ya | 0); yb = Math.min(h - 1, yb | 0);
    var n = yb - ya, cols = x1 - x0;
    if (cols < 8 || n < (guide ? Math.max(30, 2.2 * guide) : 60)) return null;
    var p = new Float32Array(n), mean = 0, i, x;
    for (i = 0; i < n; i++) {
      var y = ya + i, up = (y - 1) * w, dn = (y + 1) * w, s = 0;
      for (x = x0; x < x1; x++) s += Math.abs(g[dn + x] - g[up + x]);
      p[i] = s / cols; mean += p[i];
    }
    mean /= n;
    for (i = 0; i < n; i++) p[i] = (p[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    // guide: look only near a period already known from a taller window (needs just ~2 cycles)
    var pmin = guide ? guide / 1.35 : 5, pmax = guide ? guide * 1.35 : Math.min(120, n / 4);
    if (pmax <= pmin + 1) return null;
    var F = nf || 320, f0 = 1 / pmax, f1 = 1 / pmin, amp = new Float32Array(F), best = 0;
    for (var k = 0; k < F; k++) {
      var f = f0 + ((f1 - f0) * k) / (F - 1), re = 0, im = 0, wv = 2 * Math.PI * f;
      for (i = 0; i < n; i++) { re += p[i] * Math.cos(wv * i); im -= p[i] * Math.sin(wv * i); }
      amp[k] = Math.sqrt(re * re + im * im);
      if (amp[k] > amp[best]) best = k;
    }
    var sorted = Array.prototype.slice.call(amp).sort(function (a, b) { return a - b; });
    var med = sorted[F >> 1] || 1e-9, d = 0;
    if (best > 0 && best < F - 1) {
      var a = amp[best - 1], b = amp[best], c = amp[best + 1], den = a - 2 * b + c;
      if (den !== 0) d = (0.5 * (a - c)) / den;
    }
    var fpk = f0 + ((f1 - f0) * (best + d)) / (F - 1), period = 1 / fpk;
    // If the real period is longer than the scan range, the scan locks onto half of it.
    // A strong line at twice the period gives that away.
    if (!guide && 2 * period <= n / 2.2) {
      var re2 = 0, im2 = 0, w2 = Math.PI / period;
      for (i = 0; i < n; i++) { re2 += p[i] * Math.cos(w2 * i); im2 -= p[i] * Math.sin(w2 * i); }
      if (Math.sqrt(re2 * re2 + im2 * im2) >= 0.75 * amp[best]) period *= 2;
    }
    return { period: period, snr: amp[best] / med, dens: amp[best] / n, edge: best === 0 || best === F - 1 };
  };

  function blocky(p) { return [8, 16, 32].some(function (b) { return Math.abs(p / b - 1) < 0.025; }); }
  /* Compare the period just above the boundary with the period just below it, strip by strip. */
  AF.findRepeatCandidates = function (g, w, h, y0, y1, ramp, tiltC) {
    // growth the camera tilt alone produces between two rows (1 when there is no tilt)
    function tg(a, b) { return tiltC ? AF.tiltGrowth(tiltC, a, b, h) : 1; }
    var yd = Math.min(y1, y0 + Math.max(0, Math.round(ramp || 0)));    // where the full factor is reached
    var win = Math.max(130, Math.round(h * 0.17)), m = 6;
    /* narrow strips: on a wide frame the clean patch of wall may be small */
    var sw = Math.min(80, Math.max(40, Math.round(w / 8))), step = Math.max(20, sw >> 1), out = [], skippedDrift = 0;
    for (var x0 = 0; x0 + sw <= w; x0 += step) {
      // Tall windows first: big bricks and tiles need several courses inside the window to be
      // read at their true period. Fall back to short ones when the tall window is not uniform.
      var got = null, sawDrift = false;
      for (var t = 0; t < 3 && !got; t++) {
        var wh = Math.round(win * [3, 1.8, 1][t]);
        var ua = Math.max(0, y0 - m - wh), ub = y0 - m, da = yd + m, db = Math.min(y1, yd + m + wh);
        if (t < 2 && (ub - ua < win * 1.3 || db - da < win * 1.3)) continue;
        var up = AF.periodScan(g, w, h, x0, x0 + sw, ua, ub);
        var dn = AF.periodScan(g, w, h, x0, x0 + sw, da, db);
        if (!up || !dn || up.edge || dn.edge) continue;
        if (up.snr < 4 || dn.snr < 4) continue;
        // 8/16/32 px is the codec's block grid (it shows on any smooth area), not a texture
        if (blocky(up.period) || blocky(dn.period)) continue;
        // A filter makes the period jump at one row. Perspective (a floor, a tilted camera) makes it
        // drift all the way down. Read each window in two halves: if the period already changes
        // inside a window, this is drift, not a jump. A half with no clear period means the window
        // is not one uniform texture: try a shorter one.
        var um = (ua + ub) >> 1, dm = (da + db) >> 1;
        var u1 = AF.periodScan(g, w, h, x0, x0 + sw, ua, um, up.period), u2 = AF.periodScan(g, w, h, x0, x0 + sw, um, ub, up.period);
        var d1 = AF.periodScan(g, w, h, x0, x0 + sw, da, dm, dn.period), d2 = AF.periodScan(g, w, h, x0, x0 + sw, dm, db, dn.period);
        if (!u1 || !u2 || !d1 || !d2) continue;
        if (Math.min(u1.dens, u2.dens) < 0.4 * up.dens || Math.min(d1.dens, d2.dens) < 0.4 * dn.dens) continue;
        var uq = (ub - ua) / 4, dq = (db - da) / 4;
        if (Math.max(Math.abs(u2.period / u1.period / tg(ua + uq, ub - uq) - 1), Math.abs(d2.period / d1.period / tg(da + dq, db - dq) - 1)) > 0.07) { sawDrift = true; continue; }
        got = { up: up, dn: dn, ua: ua, ub: ub, da: da, db: db };
      }
      if (!got) { if (sawDrift) skippedDrift++; continue; }
      var k = got.dn.period / got.up.period / tg((got.ua + got.ub) / 2, (got.da + got.db) / 2);
      if (k < 0.75 || k > 2.6) continue;
      out.push({ type: "repeat", x0: x0, x1: x0 + sw, ua: got.ua, ub: got.ub, da: got.da, db: got.db,
                 pUp: got.up.period, pDown: got.dn.period, snr: Math.min(got.up.snr, got.dn.snr), k: k });
    }
    out.forEach(function (c) {
      c.support = out.filter(function (o) { return Math.abs(o.k / c.k - 1) < 0.06; }).length;
    });
    out.sort(function (a, b) { return b.support - a.support || b.snr - a.snr; });
    var consensus = null;
    if (out.length && out[0].support >= 2) {
      var grp = out.filter(function (o) { return Math.abs(o.k / out[0].k - 1) < 0.06; })
                   .map(function (o) { return o.k; }).sort(function (a, b) { return a - b; });
      consensus = { k: grp[grp.length >> 1], n: grp.length, lo: grp[0], hi: grp[grp.length - 1] };
    }
    /* strips that agree within 6% form a cluster; several clusters = the frame is not one piece */
    var byK = out.slice().sort(function (a, b) { return a.k - b.k; }), clusters = [], cur = null;
    byK.forEach(function (c) {
      if (cur && c.k / cur[0].k < 1.06) cur.push(c); else { cur = [c]; clusters.push(cur); }
    });
    clusters = clusters.map(function (grp) {
      return { k: grp[grp.length >> 1].k, n: grp.length, lo: grp[0].k, hi: grp[grp.length - 1].k,
               x0: Math.min.apply(null, grp.map(function (c) { return c.x0; })),
               x1: Math.max.apply(null, grp.map(function (c) { return c.x1; })), strips: grp };
    }).sort(function (a, b) { return b.n - a.n; });
    return { cands: out, consensus: consensus, clusters: clusters, drift: skippedDrift };
  };

  /* ---------- locating the boundary from a repeating structure ---------- */
  /* Column-mean |dI/dy| profile of a strip, rows ya..yb. */
  function profileOf(g, w, h, x0, x1, ya, yb) {
    ya = Math.max(1, ya | 0); yb = Math.min(h - 1, yb | 0);
    var n = yb - ya, p = new Float32Array(Math.max(0, n)), cols = x1 - x0, mean = 0;
    for (var i = 0; i < n; i++) {
      var y = ya + i, up = (y - 1) * w, dn = (y + 1) * w, s = 0;
      for (var x = x0; x < x1; x++) s += Math.abs(g[dn + x] - g[up + x]);
      p[i] = s / cols; mean += p[i];
    }
    mean /= Math.max(1, n);
    for (i = 0; i < n; i++) p[i] -= mean;
    return { p: p, ya: ya };
  }
  /* Slide a window down each strip and watch the dominant period. Where it jumps from
     pA to a longer pB and stays there, the stretch starts. The exact row is where a wave
     of period pA stops fitting and a wave of period pB starts (phase-coherent sums). */
  AF.findBoundary = function (g, w, h) {
    var win = Math.max(110, Math.round(h * 0.14)), stepY = 12;
    var sw = Math.min(80, Math.max(40, Math.round(w / 8))), stepX = Math.max(20, sw >> 1), found = [];
    for (var x0 = 0; x0 + sw <= w; x0 += stepX) {
      var track = [], ya, i;
      for (ya = 0; ya + win <= h; ya += stepY) {
        var r = AF.periodScan(g, w, h, x0, x0 + sw, ya, ya + win);
        track.push(r && !r.edge && r.snr >= 4 ? r.period : 0);
      }
      // runs of windows that agree on a period
      var runs = [], cur = null;
      for (i = 0; i < track.length; i++) {
        var pv = track[i];
        if (pv && cur && Math.abs(pv / cur.p - 1) < 0.05) { cur.b = i; cur.sum += pv; cur.n++; cur.p = cur.sum / cur.n; }
        else { cur = pv ? { a: i, b: i, p: pv, sum: pv, n: 1 } : null; if (cur) runs.push(cur); }
      }
      runs = runs.filter(function (q) { return q.n >= 3; });
      var maxGap = Math.ceil(win / stepY) + 2;
      for (i = 0; i + 1 < runs.length; i++) {
        var A = runs[i], B = runs[i + 1], k = B.p / A.p;
        if (B.a - A.b > maxGap || k < 1.08 || k > 2.6) continue;
        if (blocky(A.p) || blocky(B.p)) continue;
        // refine inside the hand-over zone
        var top = A.a * stepY, bot = Math.min(h - 1, B.b * stepY + win);
        var pr = profileOf(g, w, h, x0, x0 + sw, top, bot), P = pr.p, n = P.length;
        var wa = (2 * Math.PI) / A.p, wb = (2 * Math.PI) / B.p;
        var ar = new Float32Array(n + 1), ai = new Float32Array(n + 1), br = new Float32Array(n + 1), bi = new Float32Array(n + 1), t;
        for (t = 0; t < n; t++) { ar[t + 1] = ar[t] + P[t] * Math.cos(wa * t); ai[t + 1] = ai[t] + P[t] * Math.sin(wa * t); }
        for (t = n - 1; t >= 0; t--) { br[t] = br[t + 1] + P[t] * Math.cos(wb * t); bi[t] = bi[t + 1] + P[t] * Math.sin(wb * t); }
        var lo = Math.max(2 * A.p, A.b * stepY + win / 2 - top - win * 0.25), hi = Math.min(n - 2 * B.p, B.a * stepY + win / 2 - top + win * 0.25);
        var best = -1, bestT = -1, mA = 1e-9, mB = 1e-9;
        for (t = Math.round(lo); t <= hi; t++) { mA = Math.max(mA, Math.hypot(ar[t], ai[t])); mB = Math.max(mB, Math.hypot(br[t], bi[t])); }
        for (t = Math.round(lo); t <= hi; t++) {
          var sc = Math.hypot(ar[t], ai[t]) / mA + Math.hypot(br[t], bi[t]) / mB;
          if (sc > best) { best = sc; bestT = t; }
        }
        if (bestT < 0) continue;
        // the texture is continuous across the boundary, so the two waves must meet in phase:
        // slide within half an ambiguity period to the row where they do
        var amb = (A.p * B.p) / (B.p - A.p), half = Math.min(40, Math.floor(amb / 2)), bestJ = -1, bestT2 = bestT;
        for (var c = Math.max(1, bestT - half); c <= Math.min(n - 1, bestT + half); c++) {
          var ur = ar[c] * Math.cos(wa * c) + ai[c] * Math.sin(wa * c), ui = ai[c] * Math.cos(wa * c) - ar[c] * Math.sin(wa * c);
          var lr = br[c] * Math.cos(wb * c) + bi[c] * Math.sin(wb * c), li = bi[c] * Math.cos(wb * c) - br[c] * Math.sin(wb * c);
          var J = Math.hypot(ur + lr, ui + li);
          if (J > bestJ) { bestJ = J; bestT2 = c; }
        }
        found.push({ x0: x0, x1: x0 + sw, y0: pr.ya + bestT2, yEnv: pr.ya + bestT, k: k, pA: A.p, pB: B.p, score: best, na: A.n, nb: B.n });
      }
    }
    // k = 2 is the same texture read at twice its period, not a stretch
    found = found.filter(function (c) { return Math.abs(c.k - 2) > 0.07; });
    if (!found.length) return null;
    function near(o, c) { return Math.abs(o.y0 - c.y0) <= 10 && Math.abs(o.k / c.k - 1) < 0.05; }
    var pool = found.slice().sort(function (a, b) { return (b.na + b.nb) - (a.na + a.nb); }), clusters = [];
    while (pool.length) {
      var seed = pool[0], grp = pool.filter(function (o) { return near(o, seed); });
      pool = pool.filter(function (o) { return !near(o, seed); });
      var ys = grp.map(function (o) { return o.y0; }).sort(function (a, b) { return a - b; });
      var ks = grp.map(function (o) { return o.k; }).sort(function (a, b) { return a - b; });
      clusters.push({ y0: ys[ys.length >> 1], k: ks[ks.length >> 1], n: grp.length, yLo: ys[0], yHi: ys[ys.length - 1],
                      run: Math.max.apply(null, grp.map(function (o) { return o.na + o.nb; })), strips: grp });
    }
    clusters.forEach(function (c) { c.strong = c.n >= 2 && c.run >= 11; });
    clusters.sort(function (a, b) { return (b.strong - a.strong) || (b.n - a.n) || (b.run - a.run); });
    return clusters;
  };

  /* ---------- the stretch factor row by row ---------- */
  /* How much a period grows from row ya to row yb under the tilt law with slope c (h = frame height). */
  AF.tiltGrowth = function (c, ya, yb, h) { var q = (1 + c * (yb - h / 2)) / (1 + c * (ya - h / 2)); return q * q; };

  /* Follow the local period of a repeating texture down one strip: short windows (about 4.5
     periods), each guided by the period of the window before, so a slow change can be followed.
     Returns {x0, x1, pts: [{y, p, wh}]} or null when the strip has no clear texture. */
  AF.periodTrack = function (g, w, h, x0, x1) {
    var win = Math.max(110, Math.round(h * 0.14)), seed = null, ya, r;
    for (ya = 0; ya + win <= h; ya += win >> 1) {
      r = AF.periodScan(g, w, h, x0, x1, ya, ya + win);
      if (r && !r.edge && r.snr >= 4 && !blocky(r.period) && (!seed || r.snr > seed.r.snr)) seed = { yc: ya + win / 2, r: r };
    }
    if (!seed) return null;
    var pts = [];
    function walk(dir) {
      var p = seed.r.period, yc = seed.yc, first = dir > 0;
      for (;;) {
        if (!first) yc += dir * Math.max(8, Math.round(p));
        first = false;
        var wh = Math.round(Math.max(44, Math.min(win, 4.5 * p))), a = Math.round(yc - wh / 2);
        if (a < 1 || a + wh > h - 1) break;
        var q = AF.periodScan(g, w, h, x0, x1, a, a + wh, p, 96);
        if (q && !q.edge && q.dens >= 0.3 * seed.r.dens && Math.abs(q.period / p - 1) <= 0.12) {
          pts.push({ y: yc, p: q.period, wh: wh }); p = q.period;
        }
        // otherwise a gap: something in front of the wall, or a hard jump (findBoundary's job)
      }
    }
    walk(1); walk(-1);
    pts.sort(function (a, b) { return a.y - b.y; });
    return { x0: x0, x1: x1, pts: pts, seed: seed.r.period };
  };

  /* What shape does the change of period down the frame have? Each strip keeps its own base period;
     the shape is shared by all strips and is the product of two things:
       camera tilt   sqrt(period) linear in y over the whole frame (slope c; c = 0 means no tilt).
                     This is what a tilted camera does to a flat wall. It is not a filter.
       a filter      nothing, or a step at one row, or a ramp (flat, rising steadily, flat again)
     The tilt is fitted first and together with the filter term, so that only what the camera angle
     cannot explain is reported as a stretch. cRange = [lo, mid, hi] fixes c at mid when upright edges in
     the frame give the tilt, and reads the factor again at lo and hi for its range. Residuals are in log-period, capped at 10% so that a few
     bad windows cannot decide the outcome. */
  AF.fitScale = function (tracks, h, cRange) {
    var use = (tracks || []).filter(function (t) { return t && t.pts.length >= 6 && t.pts[t.pts.length - 1].y - t.pts[0].y >= 0.3 * h; });
    var first = fitTracks(use, h, cRange);
    if (!first) return null;
    // one strip alone proves nothing, and a gradual change needs three that agree
    if (use.length < 2) { first.model = "none"; first.weak = true; return first; }
    // Strips over foliage, people or mixed textures give tracks that follow nothing. Keep the strips
    // that the most flexible shape (tilt + ramp) describes well, and fit again on those alone.
    var q = first.perStrip.map(function (s) { return s.rms; }).sort(function (a, b) { return a - b; });
    var lim = Math.max(0.025, 1.6 * q[Math.floor((q.length - 1) / 3)]);
    var kept = use.filter(function (t, i) { return first.perStrip[i].rms <= lim && first.perStrip[i].inl >= 0.7; });
    if (kept.length < 2) { first.model = "none"; first.weak = true; return first; }
    var out = kept.length === use.length ? first : fitTracks(kept, h, cRange);
    out.dropped = use.length - kept.length; out.used = kept;
    if (out.model === "ramp" && kept.length < 4) { out.model = "none"; out.weak = true; }
    // A filter remaps whole rows, so the left and the right part of the picture must show the same
    // rise. Read the amplitude of the fitted ramp on each half separately; junk does not repeat.
    if (out.model === "ramp") {
      var byX = kept.slice().sort(function (a, b) { return a.x0 - b.x0; }), mid = byX.length >> 1;
      var hk = [byX.slice(0, mid), byX.slice(mid)].map(function (half) { return rampAmplitude(half, h, out.shape); });
      out.halves = hk;
      var dk = out.k - 1;
      if (hk.some(function (k) { return k == null || k - 1 < 0.5 * dk || k - 1 > 1.7 * dk; })) { out.model = "none"; out.weak = true; }
    }
    return out;
  };
  /* Factor reached by a ramp of fixed position and tilt, read on a subset of strips. */
  function rampAmplitude(use, h, sh) {
    var Y = [], L = [], SI = [], G = [], ns = use.length, i, s;
    use.forEach(function (t, si) { t.pts.forEach(function (q) {
      Y.push(q.y); L.push(Math.log(q.p) - 2 * Math.log(1 + sh.c * (q.y - h / 2))); SI.push(si);
      G.push(Math.max(0, Math.min(1, (q.y - sh.y0) / (sh.y1 - sh.y0))));
    }); });
    var n = Y.length, wgt = new Float64Array(n).fill(1), A = 0;
    if (n < 8) return null;
    for (var pass = 0; pass < 3; pass++) {
      var sw = new Float64Array(ns), sg = new Float64Array(ns), sl = new Float64Array(ns), num = 0, den = 0;
      for (i = 0; i < n; i++) { s = SI[i]; sw[s] += wgt[i]; sg[s] += wgt[i] * G[i]; sl[s] += wgt[i] * L[i]; }
      for (i = 0; i < n; i++) { s = SI[i]; if (!sw[s]) continue; var gs = G[i] - sg[s] / sw[s], ls = L[i] - sl[s] / sw[s]; num += wgt[i] * gs * ls; den += wgt[i] * gs * gs; }
      if (den < 1e-9) return null;
      A = num / den;
      for (i = 0; i < n; i++) { s = SI[i]; wgt[i] = sw[s] && Math.abs(L[i] - (sl[s] - A * sg[s]) / sw[s] - A * G[i]) < 0.1 ? 1 : 0; }
    }
    return Math.exp(A);
  }
  function fitTracks(use, h, cRange) {
    var Y = [], L0 = [], SI = [], WH = [], ns = use.length;
    use.forEach(function (t, si) { t.pts.forEach(function (q) { Y.push(q.y); L0.push(Math.log(q.p)); SI.push(si); WH.push(q.wh); }); });
    var n = Y.length, i;
    if (!ns || n < 12) return null;
    var CAP = 0.1, G = new Float64Array(n), L = new Float64Array(n), wgt = new Float64Array(n), off = new Float64Array(ns);
    var sw = new Float64Array(ns), sg = new Float64Array(ns), sl = new Float64Array(ns);
    function fit(fixedA) {
      var A = 0, s, r;
      for (i = 0; i < n; i++) wgt[i] = 1;
      for (var pass = 0; pass < 3; pass++) {
        sw.fill(0); sg.fill(0); sl.fill(0);
        for (i = 0; i < n; i++) { s = SI[i]; sw[s] += wgt[i]; sg[s] += wgt[i] * G[i]; sl[s] += wgt[i] * L[i]; }
        var num = 0, den = 0;
        for (i = 0; i < n; i++) {
          s = SI[i]; if (!sw[s]) continue;
          var gs = G[i] - sg[s] / sw[s], ls = L[i] - sl[s] / sw[s];
          num += wgt[i] * gs * ls; den += wgt[i] * gs * gs;
        }
        A = fixedA != null ? fixedA : den > 1e-12 ? num / den : 0;
        for (s = 0; s < ns; s++) off[s] = sw[s] ? (sl[s] - A * sg[s]) / sw[s] : 0;
        for (i = 0; i < n; i++) { r = L[i] - off[SI[i]] - A * G[i]; wgt[i] = Math.abs(r) < CAP ? 1 : 0; }
      }
      var sse = 0;
      for (i = 0; i < n; i++) { r = L[i] - off[SI[i]] - A * G[i]; sse += Math.min(r * r, CAP * CAP); }
      return { A: A, sse: sse };
    }
    var ymin = Math.min.apply(null, Y), ymax = Math.max.apply(null, Y), span = ymax - ymin, ym = h / 2, f, y0, ys, ye;
    var gs1 = Math.max(4, span / 48), gs2 = Math.max(6, span / 28);
    function setTilt(c) { for (i = 0; i < n; i++) L[i] = L0[i] - 2 * Math.log(1 + c * (Y[i] - ym)); }
    function bestStep(c) {
      var b = null;
      for (y0 = ymin + 2 * gs1; y0 <= ymax - 2 * gs1; y0 += gs1) {
        for (i = 0; i < n; i++) G[i] = Y[i] >= y0 ? 1 : 0;
        f = fit(null);
        if (!b || f.sse < b.sse) b = { sse: f.sse, y0: y0, k: Math.exp(f.A), c: c };
      }
      return b;
    }
    function bestRamp(c) {
      var b = null;
      for (ys = ymin; ys <= ymax - 2 * gs2; ys += gs2)
        for (ye = ys + gs2; ye <= ymax + 1e-6; ye += gs2) {
          for (i = 0; i < n; i++) G[i] = Math.max(0, Math.min(1, (Y[i] - ys) / (ye - ys)));
          f = fit(null);
          if (!b || f.sse < b.sse) b = { sse: f.sse, y0: ys, y1: ye, k: Math.exp(f.A), c: c };
        }
      return b;
    }
    // without tilt
    setTilt(0); G.fill(0);
    var none = fit(0), step0 = bestStep(0), ramp0 = bestRamp(0);
    // with tilt: c on a grid, limited by the upright edges when they are known
    var cMax = 0.45 / h, tilt = { sse: none.sse, c: 0 }, tstep = step0, tramp = ramp0, kRange = null;
    function lim(c) { return Math.max(-cMax, Math.min(cMax, c)); }
    if (cRange) {
      // The edges give the tilt: use their value, and their error bar for the range of the factor.
      var cm = lim(cRange[1]);
      setTilt(cm); G.fill(0); f = fit(0); tilt = { sse: f.sse, c: cm };
      tstep = bestStep(cm); tramp = bestRamp(cm);
      var ends = [lim(cRange[0]), lim(cRange[2])].map(function (c) { setTilt(c); return [bestStep(c), bestRamp(c)]; });
      kRange = { step: [ends[0][0], ends[1][0]], ramp: [ends[0][1], ends[1][1]] };
    } else {
      for (var ci = 0; ci <= 40; ci++) {
        var c = -cMax + 2 * cMax * ci / 40;
        if (Math.abs(c) < 1e-12) continue;
        setTilt(c); G.fill(0);
        f = fit(0); if (f.sse < tilt.sse) tilt = { sse: f.sse, c: c };
      }
      // A filter term may only take over part of what the tilt-only fit calls tilt: c between 0 and
      // that value. Left free, an opposite tilt plus a huge ramp would "explain" any tilted wall.
      for (var cj = 1; cj <= 5 && tilt.c; cj++) {
        var c2 = tilt.c * cj / 5;
        setTilt(c2);
        var bs = bestStep(c2); if (bs && tstep && bs.sse < tstep.sse) tstep = bs;
        var br = bestRamp(c2); if (br && tramp && br.sse < tramp.sse) tramp = br;
      }
    }
    tilt.growth = AF.tiltGrowth(tilt.c, ymin, ymax, h);
    var whs = WH.slice().sort(function (a, b) { return a - b; }), wh = whs[Math.floor(whs.length / 4)];
    function rms(m) { return m ? Math.sqrt(m.sse / n) : null; }
    var out = { n: n, strips: ns, ymin: ymin, ymax: ymax, wh: wh, none: none, tilt: tilt, step: tstep, ramp: tramp,
                rms: { none: rms(none), tilt: rms(tilt), step: rms(tstep), ramp: rms(tramp), step0: rms(step0), ramp0: rms(ramp0) },
                model: "none", c: 0, tilted: false, bounded: !!cRange };
    // how well tilt + ramp describes each strip (used to drop strips that follow nothing)
    out.perStrip = [];
    if (tramp) {
      setTilt(tramp.c);
      for (i = 0; i < n; i++) G[i] = Math.max(0, Math.min(1, (Y[i] - tramp.y0) / (tramp.y1 - tramp.y0)));
      f = fit(null);
      var ss = new Float64Array(ns), cnt = new Float64Array(ns), inl = new Float64Array(ns);
      for (i = 0; i < n; i++) { var r = L[i] - off[SI[i]] - f.A * G[i]; ss[SI[i]] += Math.min(r * r, CAP * CAP); cnt[SI[i]]++; if (Math.abs(r) < CAP) inl[SI[i]]++; }
      for (i = 0; i < ns; i++) out.perStrip.push({ rms: Math.sqrt(ss[i] / cnt[i]), inl: inl[i] / cnt[i] });
    }
    // is there a tilt worth speaking of?
    out.tilted = (none.sse - tilt.sse) / Math.max(1e-12, none.sse) >= 0.3 && Math.abs(tilt.growth - 1) >= 0.04;
    if (!tstep || !tramp) return out;
    var rl = tramp.y1 - tramp.y0;
    var isRamp = ((rl >= 2.5 * wh && tramp.sse <= 0.9 * tstep.sse) || (rl >= 1.2 * wh && tramp.sse <= 0.5 * tstep.sse)) &&
                 tramp.y0 - ymin >= 1.5 * wh,                 // rows above the ramp where nothing changes: without them it is just tilt
        best = isRamp ? tramp : tstep;
    // The filter term must explain a real share of what the tilt alone leaves unexplained, and
    // lengthen by more than a few percent. Without edges to pin the tilt down, ask for more.
    var gain = (tilt.sse - best.sse) / Math.max(1e-12, tilt.sse);
    if (gain >= (cRange ? 0.3 : 0.4) && best.k >= 1.04 && best.k <= 2.2) out.model = isRamp ? "ramp" : "step";
    // the texture ends before the factor levels off: what was read is a lower bound
    var after = 0; for (i = 0; i < n; i++) if (Y[i] > tramp.y1 + wh / 2) after++;
    out.open = isRamp && (tramp.y1 >= ymax - gs2 || after < Math.max(6, 0.08 * n));
    out.shape = isRamp ? { c: best.c, y0: tramp.y0, y1: tramp.y1 } : null;
    out.k = best.k; out.y0 = best.y0; out.rampLen = isRamp ? tramp.y1 - tramp.y0 : 0; out.c = best.c; out.gain = gain;
    if (kRange) {
      var ks = kRange[isRamp ? "ramp" : "step"].filter(Boolean).map(function (m) { return m.k; }).concat([best.k]);
      out.kLo = Math.min.apply(null, ks); out.kHi = Math.max.apply(null, ks);
    }
    return out;
  }
  /* Tracks for every strip of the frame, then the fit. Works on a reduced copy of tall frames. */
  AF.scaleProfile = function (g, w, h, cRange) {
    var d = AF.downscale(g, w, h, 1300), W = d.w, H = d.h, sc = d.s;
    var gb = sc === 1 ? g : AF.blur(d.g, W, H, 1);
    var sw = Math.min(80, Math.max(40, Math.round(W / 8))), tracks = [];
    for (var x0 = 0; x0 + sw <= W; x0 += sw >> 1) {
      var t = AF.periodTrack(gb, W, H, x0, x0 + sw);
      if (t) tracks.push(t);
    }
    var fit = AF.fitScale(tracks, H, cRange ? cRange.map(function (c) { return c * sc; }) : null);
    if (!fit) return null;
    // back to full-resolution rows
    fit.scale = sc; fit.ymin *= sc; fit.ymax *= sc; fit.wh *= sc; fit.c /= sc;
    if (fit.y0 != null) { fit.y0 = Math.round(fit.y0 * sc); fit.rampLen = Math.round(fit.rampLen * sc); }
    if (fit.tilt) fit.tilt.c /= sc;
    fit.tracks = (fit.used || tracks).map(function (t) { return { x0: t.x0 * sc, x1: t.x1 * sc, n: t.pts.length, seed: t.seed * sc }; });
    delete fit.used;
    return fit;
  };

  /* ---------- camera tilt from upright edges ---------- */
  /* Long, straight, nearly vertical edges (door frames, wall corners). With the camera tilted up or
     down they lean towards one point: lean = (x - xv) / (ymid - yv). The slope of lean against x,
     c = 1 / (ymid - yv), is the same c as in the "tilt" law above when the wall faces the camera,
     so the edges say how much of a change in period the camera angle can explain.
     Returns {lines, c, se, ok}; c and se are per full-resolution pixel. */
  AF.uprightEdges = function (gFull, w, h) {
    var d = AF.downscale(gFull, w, h, 720), W = d.w, H = d.h, S = d.s, g = AF.blur(d.g, W, H, 1);
    var gx = new Float32Array(W * H), x, y, i, THR = 7, ym = H / 2;
    for (y = 0; y < H; y++) for (x = 1; x < W - 1; x++) { i = y * W + x; gx[i] = g[i + 1] - g[i - 1]; }
    var cand = [], NA = 35, DA = 0.004;
    for (var ai = -NA; ai <= NA; ai++) {
      var a = ai * DA;
      for (var xm = 3; xm < W - 3; xm++) {
        var pos = 0, neg = 0;
        for (y = 2; y < H - 2; y += 2) {
          x = Math.round(xm + a * (y - ym));
          if (x < 1 || x >= W - 1) continue;
          var v = gx[y * W + x];
          if (v > THR) pos++; else if (v < -THR) neg++;
        }
        var sup = Math.max(pos, neg) / ((H - 4) / 2);
        if (sup >= 0.4) cand.push({ x: xm, a: a, sup: sup, sign: pos >= neg ? 1 : -1 });
      }
    }
    cand.sort(function (p, q) { return q.sup - p.sup; });
    var lines = [];
    cand.forEach(function (c) {
      if (lines.length >= 12 || lines.some(function (l) { return Math.abs(l.x0 - c.x) <= 6; })) return;
      // sub-pixel edge position row by row, then a straight-line fit with outliers dropped
      var px = [], py = [];
      for (y = 2; y < H - 2; y++) {
        var xc = Math.round(c.x + c.a * (y - ym)), bx = -1, bv = THR;
        for (x = Math.max(1, xc - 2); x <= Math.min(W - 2, xc + 2); x++) { var vv = c.sign * gx[y * W + x]; if (vv > bv) { bv = vv; bx = x; } }
        if (bx < 1 || bx > W - 2) continue;
        var l = c.sign * gx[y * W + bx - 1], r = c.sign * gx[y * W + bx + 1], den = l - 2 * bv + r;
        px.push(bx + (den < 0 ? 0.5 * (l - r) / den : 0)); py.push(y - ym);
      }
      var keep = px.map(function () { return true; }), A = c.a, B = c.x, res = 9;
      for (var pass = 0; pass < 3; pass++) {
        var n = 0, sy = 0, sx = 0, syy = 0, sxy = 0;
        for (i = 0; i < px.length; i++) if (keep[i]) { n++; sy += py[i]; sx += px[i]; syy += py[i] * py[i]; sxy += py[i] * px[i]; }
        var dd = n * syy - sy * sy;
        if (n < 0.3 * H || dd <= 0) return;
        A = (n * sxy - sy * sx) / dd; B = (sx - A * sy) / n;
        var ss = 0;
        for (i = 0; i < px.length; i++) if (keep[i]) { var e = px[i] - B - A * py[i]; ss += e * e; }
        res = Math.sqrt(ss / n);
        for (i = 0; i < px.length; i++) keep[i] = Math.abs(px[i] - B - A * py[i]) < Math.max(0.8, 2.5 * res);
      }
      if (res > 0.7) return;                               // not straight: a limb, a cable, a curtain fold
      var ys = py.filter(function (_, j) { return keep[j]; });
      lines.push({ x0: c.x, x: B * S, lean: A, support: c.sup, res: res, ya: (ys[0] + ym) * S, yb: (ys[ys.length - 1] + ym) * S });
    });
    var out = { lines: lines, c: null, se: null, ok: false };
    if (lines.length < 3) return out;                       // two lines always agree with some tilt
    var mx = 0, ml = 0, sxx = 0, sxl = 0, m = lines.length;
    lines.forEach(function (l) { mx += l.x; ml += l.lean; }); mx /= m; ml /= m;
    lines.forEach(function (l) { sxx += (l.x - mx) * (l.x - mx); sxl += (l.x - mx) * (l.lean - ml); });
    if (Math.sqrt(sxx / m) < 0.04 * w) return out;          // all in one place: no leverage
    var c1 = sxl / sxx, rs = 0;
    lines.forEach(function (l) { var e = l.lean - ml - c1 * (l.x - mx); rs += e * e; });
    // upright things are not perfectly plumb, and two lines always fit exactly: keep a floor
    var sig = Math.max(0.003, m > 2 ? Math.sqrt(rs / (m - 2)) : 0);
    out.c = c1; out.se = sig / Math.sqrt(sxx); out.ok = true;
    return out;
  };

  /* ---------- everything the background alone can say ---------- */
  /* g: grey frame, gb: the same lightly blurred. body (optional): rows {sh, hip, K} of shoulders,
     hips and knees; a boundary outside chest..knee is not believed when a body is known.
     Returns {how: "ramp" | "step" | null, y0, ramp, k, n, adopt, tilt: {c, growth, seen, from}, prof, step, edges}.
       step  a jump in period at one row (findBoundary), the long-standing path
       ramp  no clean jump, but the period rises steadily over a stretch of rows (scaleProfile)
     tilt.c is the camera tilt that was separated out first (0 = none); pass it to
     findRepeatCandidates so that a factor read across the boundary is not inflated by it. */
  AF.autoBackground = function (g, gb, w, h, body) {
    function inBody(y) { return !body || (y >= body.sh + 0.3 * (body.hip - body.sh) && y <= body.K); }
    // on a tall frame the search for a jump runs on a reduced copy (it is by far the slowest step)
    var d = AF.downscale(gb, w, h, 1300), cl = (d.s === 1 ? AF.findBoundary(gb, w, h) : AF.findBoundary(AF.blur(d.g, d.w, d.h, 1), d.w, d.h)) || [];
    if (d.s > 1) cl.forEach(function (c) { c.y0 *= d.s; c.yLo *= d.s; c.yHi *= d.s; c.strips.forEach(function (t) { t.x0 *= d.s; t.x1 *= d.s; t.y0 *= d.s; t.pA *= d.s; t.pB *= d.s; }); });
    var strong = cl.filter(function (c) { return c.strong && inBody(c.y0); });
    var ed = AF.uprightEdges(g, w, h);
    var prof = AF.scaleProfile(gb, w, h, ed.ok ? [ed.c - 2 * ed.se, ed.c, ed.c + 2 * ed.se] : null);
    var out = { how: null, y0: null, ramp: 0, k: null, n: 0, adopt: false, prof: prof, step: null, edges: ed,
                tilt: { c: 0, growth: 1, seen: false, from: ed.ok ? "edges" : "texture" } };
    if (prof) {
      // a tilt counts when the edges measure one clearly, or, without edges, when the texture shows one
      // (the texture only counts when tilt alone explains it: with a filter term in the fit, the
      //  split between the two is too uncertain to correct a jump with)
      var c = ed.ok ? (Math.abs(ed.c) > 2 * ed.se ? ed.c : 0) : prof.model === "none" && prof.tilted ? prof.tilt.c : prof.model === "ramp" ? prof.c : 0;
      var gr = AF.tiltGrowth(c, 0, h, h);
      if (Math.abs(gr - 1) >= 0.04) { out.tilt.c = c; out.tilt.growth = gr; out.tilt.seen = true; }
    }
    // A tilted camera makes the period creep up all the way down, and the jump finder then reports
    // small "jumps" wherever its rounding flips. Keep the first jump that is still there once the
    // tilt is taken out of the comparison.
    var pick = strong[0] || null;
    if (out.tilt.seen) {
      pick = null;
      for (var si = 0; si < strong.length && !pick; si++) {
        var rc = AF.findRepeatCandidates(gb, w, h, strong[si].y0, h, 0, out.tilt.c);
        if (rc.consensus && rc.consensus.n >= 2 && rc.consensus.k >= 1.05) pick = strong[si];
      }
    }
    out.step = pick;
    var ramp = !!prof && prof.model === "ramp" && (!body || (prof.y0 >= body.sh && prof.y0 <= body.K));
    // A jump reported inside the ramp, no bigger than the ramp itself, is the ramp seen through a
    // coarse window. A jump elsewhere, or a much bigger one, is a real hard edge: keep it.
    if (ramp && pick && !(pick.y0 > prof.y0 - prof.wh && pick.y0 < prof.y0 + prof.rampLen + prof.wh && pick.k <= prof.k * 1.06)) ramp = false;
    // a ramp whose end was not seen gives way to a jump when there is one
    if (ramp && prof.open && pick) ramp = false;
    if (ramp) { out.how = "ramp"; out.y0 = prof.y0; out.ramp = prof.rampLen; out.k = prof.k; out.n = prof.strips; out.kLo = prof.kLo; out.kHi = prof.kHi; out.open = !!prof.open; }
    else if (pick) { out.how = "step"; out.y0 = pick.y0; out.k = pick.k; out.n = pick.n; }
    // Not adopted on its own authority: a ramp read only up to where the texture ends (a lower
    // bound), and a jump under a tilt that no upright edge confirms (the factor can be 10% off).
    out.adopt = !!out.how && !(out.how === "ramp" && out.open) && !(out.how === "step" && out.tilt.seen && !ed.ok);
    out.why = !out.how || out.adopt ? "" : out.how === "ramp" ? "open" : "tilt-unconfirmed";
    return out;
  };

  /* ---------- cue 2: shapes that should be square / circular ---------- */
  function gradMag(g, w, h) {
    var m = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++)
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x, gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
        m[i] = Math.sqrt(gx * gx + gy * gy);
      }
    return m;
  }
  AF.gradMag = gradMag;

  /* Downscale by integer-ish factor with area averaging. */
  AF.downscale = function (g, w, h, maxSide) {
    var s = Math.max(1, Math.round(Math.max(w, h) / maxSide));
    if (s === 1) return { g: g, w: w, h: h, s: 1 };
    var W = Math.floor(w / s), H = Math.floor(h / s), o = new Float32Array(W * H);
    for (var y = 0; y < H; y++)
      for (var x = 0; x < W; x++) {
        var sum = 0;
        for (var dy = 0; dy < s; dy++) for (var dx = 0; dx < s; dx++) sum += g[(y * s + dy) * w + x * s + dx];
        o[y * W + x] = sum / (s * s);
      }
    return { g: o, w: W, h: H, s: s };
  };

  /* Regions enclosed by edges; keep the ones whose outline fills its bounding box like a
     rectangle or like an ellipse (holes inside, e.g. socket pins, are ignored).
     Runs at two edge thresholds because pale-on-pale objects need a low one.
     Returned boxes are in full-resolution pixels. */
  AF.findShapeCandidates = function (gFull, w, h, opts) {
    opts = opts || {};
    var d = AF.downscale(gFull, w, h, opts.maxSide || 560), W = d.w, H = d.h, S = d.s;
    var g = AF.blur(d.g, W, H, 1), mag = gradMag(g, W, H);
    var gSnap = AF.blur(gFull, w, h, 1);
    var sample = [], i;
    for (i = 0; i < mag.length; i += 7) sample.push(mag[i]);
    sample.sort(function (a, b) { return a - b; });
    var med = sample[sample.length >> 1], out = [];
    /* thick edges close pale outlines; thin edges survive smooth shading (a lit ball) */
    [[Math.max(1.6, 1.8 * med), false], [Math.max(2.4, 3.2 * med), false], [Math.max(2.0, 2.2 * med), true]].forEach(function (cfg) {
      collect(cfg[0], cfg[1]).forEach(function (c) {
        var dup = out.some(function (o) {
          var ix = Math.max(0, Math.min(o.x + o.w, c.x + c.w) - Math.max(o.x, c.x));
          var iy = Math.max(0, Math.min(o.y + o.h, c.y + c.h) - Math.max(o.y, c.y));
          return (ix * iy) / (o.w * o.h + c.w * c.h - ix * iy) > 0.6;
        });
        if (!dup) out.push(c);
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, opts.max || 14);

    function collect(T, thin) {
      var res = [], edge = new Uint8Array(W * H), x, y, i;
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        i = y * W + x;
        var m = mag[i];
        if (m <= T) continue;
        var gx = g[i + 1] - g[i - 1], gy = g[i + W] - g[i - W], ax = Math.abs(gx), ay = Math.abs(gy), o;
        if (ax > 2.414 * ay) o = 1; else if (ay > 2.414 * ax) o = W; else o = (gx > 0) === (gy > 0) ? W + 1 : W - 1;
        if (!thin || (m > mag[i + o] * 1.02 && m >= mag[i - o])) edge[i] = 1;
      }
      if (thin) { // thicken the thinned lines once so small breaks close
        var th = new Uint8Array(edge);
        for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
          i = y * W + x;
          if (edge[i - 1] || edge[i + 1] || edge[i - W] || edge[i + W]) th[i] = 1;
        }
        edge = th;
      }
      var grow = thin ? 1.5 : 1.5;
      var e2 = new Uint8Array(edge);
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        i = y * W + x;
        if (!edge[i] && ((edge[i - 1] && edge[i + 1]) || (edge[i - W] && edge[i + W]) ||
            (edge[i - W - 1] && edge[i + W + 1]) || (edge[i - W + 1] && edge[i + W - 1]))) e2[i] = 1;
      }
      var label = new Uint8Array(W * H), stack = new Int32Array(W * H);
      var minArea = Math.max(50, W * H * 0.0005), maxArea = W * H * 0.14;
      var rowL = new Int32Array(H), rowR = new Int32Array(H);
      for (var start = 0; start < W * H; start++) {
        if (e2[start] || label[start]) continue;
        var sp = 0, area = 0, minx = W, maxx = 0, miny = H, maxy = 0, border = false, px = [];
        stack[sp++] = start; label[start] = 1;
        while (sp) {
          var q = stack[--sp], qx = q % W, qy = (q / W) | 0;
          area++; if (area <= maxArea) px.push(q);
          if (qx < minx) minx = qx; if (qx > maxx) maxx = qx; if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
          if (qx === 0 || qy === 0 || qx === W - 1 || qy === H - 1) border = true;
          if (qx > 0 && !e2[q - 1] && !label[q - 1]) { label[q - 1] = 1; stack[sp++] = q - 1; }
          if (qx < W - 1 && !e2[q + 1] && !label[q + 1]) { label[q + 1] = 1; stack[sp++] = q + 1; }
          if (qy > 0 && !e2[q - W] && !label[q - W]) { label[q - W] = 1; stack[sp++] = q - W; }
          if (qy < H - 1 && !e2[q + W] && !label[q + W]) { label[q + W] = 1; stack[sp++] = q + W; }
        }
        if (border || area < minArea || area > maxArea) continue;
        var bw = maxx - minx + 1, bh = maxy - miny + 1;
        if (bw < 9 || bh < 9 || bw / bh > 3.5 || bh / bw > 3.5) continue;
        for (y = miny; y <= maxy; y++) { rowL[y] = W; rowR[y] = -1; }
        for (var t = 0; t < px.length; t++) {
          var ux = px[t] % W, uy = (px[t] / W) | 0;
          if (ux < rowL[uy]) rowL[uy] = ux; if (ux > rowR[uy]) rowR[uy] = ux;
        }
        var span = 0, inter = 0, cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, ra = bw / 2, rb = bh / 2;
        for (y = miny; y <= maxy; y++) {
          if (rowR[y] < 0) continue;
          span += rowR[y] - rowL[y] + 1;
          var ey = (y - cy) / rb, half = ey * ey < 1 ? ra * Math.sqrt(1 - ey * ey) : 0;
          inter += Math.max(0, Math.min(rowR[y] + 0.5, cx + half) - Math.max(rowL[y] - 0.5, cx - half));
        }
        if (area < 0.55 * span) continue;           // mostly hollow: a ring or clutter, not a face
        var fill = span / (bw * bh), type = null, fit = 0;
        var iou = inter / (Math.PI * ra * rb + span - inter);
        if (fill >= 0.88) { type = "rect"; fit = fill; }
        else if (iou >= 0.86) { type = "ellipse"; fit = iou; }
        if (!type) continue;
        // the edge line sits one pixel outside the region: grow, then refine at full resolution
        var box = { x: (minx - grow) * S, y: (miny - grow) * S, w: (bw + 2 * grow) * S, h: (bh + 2 * grow) * S };
        var ref = type === "rect" ? AF.snapRect(gSnap, w, h, box, 3 * S + 1) : AF.snapEllipse(gSnap, w, h, box, 2 * S + 1);
        res.push({ type: type, x: ref.x, y: ref.y, w: ref.w, h: ref.h, ratio: ref.h / ref.w, fit: fit, score: fit * Math.sqrt(span) });
      }
      return res;
    }
  };

  /* Snap each side of a rough box to the strongest nearby edge (sub-pixel). */
  AF.snapRect = function (g, w, h, b, r) {
    r = Math.max(2, Math.round(r || Math.max(4, 0.12 * Math.min(b.w, b.h))));
    function sideV(xc, ya, yb) { // vertical edge near column xc
      var bestV = -1, bestX = xc, vals = [];
      for (var x = Math.round(xc) - r; x <= Math.round(xc) + r; x++) {
        var s = 0, n = 0;
        if (x < 1 || x >= w - 1) { vals.push(0); continue; }
        for (var y = Math.max(1, Math.round(ya)); y < Math.min(h - 1, Math.round(yb)); y++) { s += Math.abs(g[y * w + x + 1] - g[y * w + x - 1]); n++; }
        s = n ? s / n : 0; vals.push(s);
        if (s > bestV) { bestV = s; bestX = x; }
      }
      var i = bestX - (Math.round(xc) - r), d = 0;
      if (i > 0 && i < vals.length - 1) { var den = vals[i - 1] - 2 * vals[i] + vals[i + 1]; if (den < 0) d = (0.5 * (vals[i - 1] - vals[i + 1])) / den; }
      return bestX + d;
    }
    function sideH(yc, xa, xb) {
      var bestV = -1, bestY = yc, vals = [];
      for (var y = Math.round(yc) - r; y <= Math.round(yc) + r; y++) {
        var s = 0, n = 0;
        if (y < 1 || y >= h - 1) { vals.push(0); continue; }
        for (var x = Math.max(1, Math.round(xa)); x < Math.min(w - 1, Math.round(xb)); x++) { s += Math.abs(g[(y + 1) * w + x] - g[(y - 1) * w + x]); n++; }
        s = n ? s / n : 0; vals.push(s);
        if (s > bestV) { bestV = s; bestY = y; }
      }
      var i = bestY - (Math.round(yc) - r), d = 0;
      if (i > 0 && i < vals.length - 1) { var den = vals[i - 1] - 2 * vals[i] + vals[i + 1]; if (den < 0) d = (0.5 * (vals[i - 1] - vals[i + 1])) / den; }
      return bestY + d;
    }
    var my = b.h * 0.2, mx = b.w * 0.2;
    var L = sideV(b.x, b.y + my, b.y + b.h - my), R = sideV(b.x + b.w, b.y + my, b.y + b.h - my);
    var T = sideH(b.y, b.x + mx, b.x + b.w - mx), B = sideH(b.y + b.h, b.x + mx, b.x + b.w - mx);
    if (R - L < 4 || B - T < 4) return { x: b.x, y: b.y, w: b.w, h: b.h };
    return { x: L, y: T, w: R - L, h: B - T };
  };

  /* Fit an axis-aligned ellipse near a rough box. The cost is a trimmed mean of the
     outward gradient along the perimeter, so a partly hidden ball still fits. */
  AF.snapEllipse = function (g, w, h, b, r) {
    r = Math.max(2, Math.round(r || Math.max(4, 0.12 * Math.min(b.w, b.h))));
    var N = 96, cs = new Float32Array(N), sn = new Float32Array(N), i;
    for (i = 0; i < N; i++) { cs[i] = Math.cos((2 * Math.PI * i) / N); sn[i] = Math.sin((2 * Math.PI * i) / N); }
    function samp(x, y) {
      if (x < 1 || y < 1 || x >= w - 2 || y >= h - 2) return 0;
      var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, o = yi * w + xi;
      return g[o] * (1 - fx) * (1 - fy) + g[o + 1] * fx * (1 - fy) + g[o + w] * (1 - fx) * fy + g[o + w + 1] * fx * fy;
    }
    var vals = new Float32Array(N);
    /* Two readings of "the outline lies on an edge":
       - signed: inside-vs-outside brightness keeps one sign all the way round a real outline, while
         background clutter (bricks, tiles) flips sign and cancels out;
       - trimmed: the strongest 55% of the perimeter, for a ball that is partly hidden or lit from one side. */
    function cost(cx, cy, a, bb) {
      var sum = 0;
      for (var j = 0; j < N; j++) {
        var nx = cs[j] / a, ny = sn[j] / bb, nl = Math.sqrt(nx * nx + ny * ny); nx /= nl; ny /= nl;
        var px = cx + a * cs[j], py = cy + bb * sn[j];
        var dlt = samp(px + 1.5 * nx, py + 1.5 * ny) - samp(px - 1.5 * nx, py - 1.5 * ny);
        sum += dlt; vals[j] = Math.abs(dlt);
      }
      var s = Array.prototype.slice.call(vals).sort(function (p, q) { return q - p; }), keep = Math.round(N * 0.55), t = 0;
      for (var m = 0; m < keep; m++) t += s[m];
      return Math.max(Math.abs(sum) / N, 0.6 * t / keep);
    }
    var P = [b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2], bestC = cost(P[0], P[1], P[2], P[3]);
    for (var stepSize = r; stepSize >= 0.25; stepSize /= 2) {
      var improved = true, guard = 0;
      while (improved && guard++ < 12) {
        improved = false;
        for (var d = 0; d < 4; d++) for (var sg = -1; sg <= 1; sg += 2) {
          var Q = P.slice(); Q[d] += sg * stepSize;
          if (Q[2] < 3 || Q[3] < 3) continue;
          var c = cost(Q[0], Q[1], Q[2], Q[3]);
          if (c > bestC * 1.002) { bestC = c; P = Q; improved = true; }
        }
      }
    }
    return { x: P[0] - P[2], y: P[1] - P[3], w: 2 * P[2], h: 2 * P[3], strength: bestC };
  };

  /* How much of a shape's height lies in the stretched band → k from its h/w.
     trueRatio = real height / real width (1 for a square or a sphere). */
  AF.kFromBox = function (box, p, trueRatio) {
    var top = box.y, bot = box.y + box.h, tr = trueRatio || 1, kx = p.kx || 1;
    var inBand = Math.max(0, Math.min(bot, p.y1) - Math.max(top, p.y0)), outBand = box.h - inBand;
    if (inBand < 0.15 * box.h) return { k: null, frac: inBand / box.h };
    // true width = box.w / kx ; true height (stretch undone with factor k) = true width * tr
    var want = (box.w / kx) * tr;
    if (want - outBand <= 0) return { k: null, frac: inBand / box.h };
    if (!rampOf(p)) return { k: inBand / (want - outBand), frac: inBand / box.h };
    function trueH(k) { var q = { y0: p.y0, y1: p.y1, k: k, ramp: p.ramp }; return AF.unmapY(bot, q) - AF.unmapY(top, q); }
    var lo = 0.3, hi = 6;                                   // trueH falls as k grows
    if (trueH(lo) < want || trueH(hi) > want) return { k: null, frac: inBand / box.h };
    for (var i = 0; i < 60; i++) { var m = 0.5 * (lo + hi); if (trueH(m) > want) lo = m; else hi = m; }
    return { k: 0.5 * (lo + hi), frac: inBand / box.h };
  };
  /* Whole-frame horizontal squeeze. kx = width now / true width (0.9 = squeezed to 90%).
     Nothing inside the frame escaped it, so only an object of known shape can measure it:
     kx = (width now * trueRatio) / true height, the height taken with the vertical stretch undone. */
  AF.kxFromBox = function (box, p, trueRatio) {
    var top = box.y, bot = box.y + box.h, tr = trueRatio || 1;
    var inBand = Math.max(0, Math.min(bot, p.y1) - Math.max(top, p.y0));
    var q = { y0: p.y0, y1: p.y1, k: p.k || 1, ramp: p.ramp }, trueH = AF.unmapY(bot, q) - AF.unmapY(top, q);
    if (trueH <= 0) return { kx: null, frac: inBand / box.h };
    return { kx: (box.w * tr) / trueH, frac: inBand / box.h };
  };

  /* ---------- cue 3: body-proportion prior ---------- */
  /* Knee (mid-patella) height / stature and crotch height / stature, computed from
     ANSUR II (2012 US Army survey, 4,082 men + 1,986 women, public data). */
  AF.PRIORS = {
    knee:   { label: "膝盖高 / 身高", p05: 0.263, p50: 0.277, p95: 0.293 },
    crotch: { label: "裆高 / 身高",   p05: 0.458, p50: 0.481, p95: 0.505 }
  };
  /* pts: stretched-image y of head top (H), joint (J = knee or crotch), sole (S). */
  AF.kFromBody = function (H, J, S, p, r) {
    function ratio(k) {
      var q = { y0: p.y0, y1: p.y1, k: k, ramp: p.ramp };
      var h = AF.unmapY(H, q), j = AF.unmapY(J, q), s = AF.unmapY(S, q);
      return (s - j) / (s - h);
    }
    var lo = 0.4, hi = 4, flo = ratio(lo) - r, fhi = ratio(hi) - r;
    if (!(S > J && J > H) || flo * fhi > 0) return null;
    for (var i = 0; i < 60; i++) {
      var mid = 0.5 * (lo + hi), fm = ratio(mid) - r;
      if (fm * flo > 0) { lo = mid; flo = fm; } else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  AF.bodyEstimate = function (H, J, S, p, which) {
    var pr = AF.PRIORS[which];
    return { k50: AF.kFromBody(H, J, S, p, pr.p50), kA: AF.kFromBody(H, J, S, p, pr.p05), kB: AF.kFromBody(H, J, S, p, pr.p95),
             observed: (S - J) / (S - H) };
  };

  if (typeof module !== "undefined" && module.exports) module.exports = AF;
  root.AF = AF;
})(typeof globalThis !== "undefined" ? globalThis : this);
