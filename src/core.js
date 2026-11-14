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
  /* stretched y -> original y */
  AF.unmapY = function (y, p) {
    if (y <= p.y0) return y;
    if (y <= p.y1) return p.y0 + (y - p.y0) / p.k;
    return p.y0 + (p.y1 - p.y0) / p.k + (y - p.y1);
  };
  AF.restoredHeight = function (h, p) { return AF.unmapY(h, p); };

  /* ---------- cue 1: repeating structure (bricks, tiles, railings) ---------- */
  /* Dominant vertical period of a column strip between rows ya..yb.
     Returns {period, snr}; snr = spectral peak / median amplitude. */
  AF.periodScan = function (g, w, h, x0, x1, ya, yb) {
    x0 = Math.max(0, x0 | 0); x1 = Math.min(w, x1 | 0);
    ya = Math.max(1, ya | 0); yb = Math.min(h - 1, yb | 0);
    var n = yb - ya, cols = x1 - x0;
    if (n < 60 || cols < 8) return null;
    var p = new Float32Array(n), mean = 0, i, x;
    for (i = 0; i < n; i++) {
      var y = ya + i, up = (y - 1) * w, dn = (y + 1) * w, s = 0;
      for (x = x0; x < x1; x++) s += Math.abs(g[dn + x] - g[up + x]);
      p[i] = s / cols; mean += p[i];
    }
    mean /= n;
    for (i = 0; i < n; i++) p[i] = (p[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    var pmin = 5, pmax = Math.min(48, n / 4);
    if (pmax <= pmin + 1) return null;
    var F = 320, f0 = 1 / pmax, f1 = 1 / pmin, amp = new Float32Array(F), best = 0;
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
    var fpk = f0 + ((f1 - f0) * (best + d)) / (F - 1);
    return { period: 1 / fpk, snr: amp[best] / med, edge: best === 0 || best === F - 1 };
  };

  function blocky(p) { return [8, 16, 32].some(function (b) { return Math.abs(p / b - 1) < 0.025; }); }
  /* Compare the period just above the boundary with the period just below it, strip by strip. */
  AF.findRepeatCandidates = function (g, w, h, y0, y1) {
    var win = Math.max(130, Math.round(h * 0.17)), m = 6;
    /* narrow strips: on a wide frame the clean patch of wall may be small */
    var sw = Math.min(80, Math.max(40, Math.round(w / 8))), step = Math.max(20, sw >> 1), out = [];
    for (var x0 = 0; x0 + sw <= w; x0 += step) {
      var ua = Math.max(0, y0 - m - win), ub = y0 - m, da = y0 + m, db = Math.min(y1, y0 + m + win);
      var up = AF.periodScan(g, w, h, x0, x0 + sw, ua, ub);
      var dn = AF.periodScan(g, w, h, x0, x0 + sw, da, db);
      if (!up || !dn || up.edge || dn.edge) continue;
      if (up.snr < 4 || dn.snr < 4) continue;
      // 8/16/32 px in both windows is the video codec's block grid, not a texture
      if (blocky(up.period) && blocky(dn.period)) continue;
      var k = dn.period / up.period;
      if (k < 0.75 || k > 2.6) continue;
      out.push({ type: "repeat", x0: x0, x1: x0 + sw, ua: ua, ub: ub, da: da, db: db,
                 pUp: up.period, pDown: dn.period, snr: Math.min(up.snr, dn.snr), k: k });
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
    return { cands: out, consensus: consensus, clusters: clusters };
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
        if (blocky(A.p) && blocky(B.p)) continue;
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
        var amb = (A.p * B.p) / (B.p - A.p), half = Math.min(14, Math.floor(amb / 2)), bestJ = -1, bestT2 = bestT;
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
    function cost(cx, cy, a, bb) {
      for (var j = 0; j < N; j++) {
        var nx = cs[j] / a, ny = sn[j] / bb, nl = Math.sqrt(nx * nx + ny * ny); nx /= nl; ny /= nl;
        var px = cx + a * cs[j], py = cy + bb * sn[j];
        vals[j] = Math.abs(samp(px + 1.5 * nx, py + 1.5 * ny) - samp(px - 1.5 * nx, py - 1.5 * ny));
      }
      var s = Array.prototype.slice.call(vals).sort(function (p, q) { return q - p; }), keep = Math.round(N * 0.55), t = 0;
      for (var m = 0; m < keep; m++) t += s[m];
      return t / keep;
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
    var top = box.y, bot = box.y + box.h, tr = trueRatio || 1;
    var inBand = Math.max(0, Math.min(bot, p.y1) - Math.max(top, p.y0)), outBand = box.h - inBand;
    if (inBand < 0.15 * box.h) return { k: null, frac: inBand / box.h };
    // box.w * tr = outBand + inBand / k
    var need = box.w * tr - outBand;
    if (need <= 0) return { k: null, frac: inBand / box.h };
    return { k: inBand / need, frac: inBand / box.h };
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
      var q = { y0: p.y0, y1: p.y1, k: k };
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
