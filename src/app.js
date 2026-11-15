/* 还原尺 unstretch — Copyright (C) 2026 songj33
   SPDX-License-Identifier: GPL-3.0-only */
(function () {
  "use strict";
  var AF = window.AF;
  var $ = function (id) { return document.getElementById(id); };
  var view = $("view"), vctx = view.getContext("2d"), out = $("out"), octx = out.getContext("2d");
  var ruler = $("ruler"), rctx = ruler.getContext("2d");
  var src = document.createElement("canvas"), sctx = src.getContext("2d", { willReadFrequently: true });
  var video = document.createElement("video");
  video.playsInline = true; video.preload = "auto";

  var TOOLS = ["toolRect", "toolEllipse", "toolGap", "toolBody", "toolCrop"];
  var base = document.createElement("canvas"), bctx = base.getContext("2d");
  var MARK = "#ff4a2b", MARK2 = "#ffd23f", CAND = "#4fd1ff";
  var S = {
    w: 0, h: 0, kind: "none", name: "还原尺", isDemo: false,
    p: { y0: 0, y1: 0, k: 1, kx: 1 }, toBottom: true, adoptedX: null,
    mode: "idle", ev: [], cands: [], adopted: null, hover: null,
    draft: null, pts: [], gapA: null, drag: null, seq: 0, gray: null, ds: 1, recording: false, stopRec: null,
    bw: 0, bh: 0, crop: null, track: false, trackOff: 0, busy: false
  };

  /* ------------------------------------------------------------ helpers */
  function fmt(x, d) { return x == null || !isFinite(x) ? "–" : x.toFixed(d == null ? 2 : d); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function hint(msg, warn) { var el = $("hint"); el.textContent = msg || ""; el.className = "hint" + (warn ? " warn" : ""); }
  function idleHint() {
    hint(S.kind === "none" ? "" : "拖红色分界线到拉伸开始的位置（通常在胯部附近），然后找参照物。");
  }
  function getGray() {
    if (!S.gray) {
      var d = sctx.getImageData(0, 0, S.w, S.h), g = AF.gray(d.data, S.w, S.h);
      S.gray = { g: g, b: AF.blur(g, S.w, S.h, 1) };
    }
    return S.gray;
  }
  function halo(ctx, path, color, lw, dash) {
    ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash(dash || []);
    ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.lineWidth = lw * 2.4; ctx.beginPath(); path(ctx); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); path(ctx); ctx.stroke();
    ctx.restore();
  }
  function label(ctx, text, x, y, color, size) {
    ctx.save(); ctx.font = "600 " + size + "px ui-monospace, Menlo, Consolas, monospace";
    var w = ctx.measureText(text).width, pad = size * 0.35;
    x = clamp(x, 0, S.w - w - 2 * pad); y = clamp(y, size + 2 * pad, S.h);
    ctx.fillStyle = "rgba(0,0,0,.72)"; ctx.fillRect(x, y - size - pad, w + 2 * pad, size + 2 * pad);
    ctx.fillStyle = color; ctx.textBaseline = "alphabetic"; ctx.fillText(text, x + pad, y - pad * 0.4);
    ctx.restore();
  }

  /* ------------------------------------------------------------ evidence */
  function solveGap(A, B, p) {
    function len(s, k) { var q = { y0: p.y0, y1: p.y1, k: k }; return AF.unmapY(s.yb, q) - AF.unmapY(s.ya, q); }
    function f(k) { return len(B, k) - len(A, k); }
    var lo = 0.4, hi = 4, flo = f(lo), fhi = f(hi);
    if (flo * fhi > 0) return null;
    for (var i = 0; i < 60; i++) { var m = 0.5 * (lo + hi), fm = f(m); if (fm * flo > 0) { lo = m; flo = fm; } else hi = m; }
    return 0.5 * (lo + hi);
  }
  function computeEv(e) {
    var p = S.p;
    e.lo = e.hi = null; e.note = "";
    if (e.kind === "box") {
      var r = AF.kFromBox(e.box, p, e.tr);
      var name = e.shape === "ellipse" ? "圆" : "方形";
      e.detail = "量到 " + fmt(e.box.w, 0) + "×" + fmt(e.box.h, 0) + " px，高÷宽 " + fmt(e.box.h / e.box.w);
      if (r.frac < 0.15) {                       // outside the stretched band: it measures the horizontal squeeze
        e.axis = "x"; e.k = AF.kxFromBox(e.box, p, e.tr).kx;
        e.title = "手框" + name + "，量横向" + (Math.abs(e.tr - 1) > 0.005 ? "（真实高÷宽 " + fmt(e.tr) + "）" : "");
        e.note = "它在拉伸带之外，高度没被动过，所以宽度变化就是横向挤压。";
      } else {
        e.axis = "y"; e.k = r.k;
        e.title = "手框" + name + (Math.abs(e.tr - 1) > 0.005 ? "（真实高÷宽 " + fmt(e.tr) + "）" : "");
        if (r.k == null) e.note = "按这个分界线算不出合理倍数。";
        else if (r.frac < 0.98) e.note = "只有 " + Math.round(r.frac * 100) + "% 落在拉伸带里，已按比例折算。";
        if (r.k != null && Math.abs(p.kx - 1) > 0.015) e.note += "已按横向 ×" + fmt(p.kx) + " 折算。";
      }
    } else if (e.kind === "gap") {
      e.k = solveGap(e.A, e.B, p);
      e.title = "两段间距";
      e.detail = "第一段 " + fmt(e.A.yb - e.A.ya, 0) + " px，第二段 " + fmt(e.B.yb - e.B.ya, 0) + " px";
      if (e.k == null) e.note = "两段要一段在分界线上方、一段在拉伸带里。";
    } else if (e.kind === "body") {
      var b = AF.bodyEstimate(e.H, e.J, e.S, p, e.which), pr = AF.PRIORS[e.which];
      e.k = b.k50; e.lo = b.kB; e.hi = b.kA;
      e.title = "人体比例（" + (e.auto ? "自动识别，" : "") + (e.which === "knee" ? "膝盖" : "裆部") + "）";
      e.detail = "画面里 " + pr.label + " = " + fmt(b.observed, 3) + "，人群中位 " + fmt(pr.p50, 3);
      e.note = e.k == null ? "按这个分界线算不出倍数，检查三个点的顺序。" : "人群 5%–95% 对应 " + fmt(e.lo) + "–" + fmt(e.hi) + "。仰拍、厚底鞋会让它偏大。" +
        (e.auto ? "点是模型估的：先按估计倍数还原、再重新识别，反复" + (e.rounds ? " " + e.rounds + " 轮" : "") + "到读数稳定" + (e.direct != null ? "（不还原直接读是 ×" + fmt(e.direct) + "）" : "") + "。" +
          (e.multi ? "视频里看了 " + e.multi.frames + " 帧，其中 " + e.multi.used + " 帧读出了结果，各帧读数 " + fmt(e.multi.lo) + "–" + fmt(e.multi.hi) + "，这里显示的是居中的一帧。" : "") +
          (e.posture ? "这一帧" + e.posture + "，读数不可靠。" : "") + "三个点可以拖动修正。" : "三个点可以拖动微调。");
    } else if (e.kind === "repeat") {
      e.title = "重复结构（" + e.n + " 条竖带" + (e.n > 1 ? "一致" : "") + "）";
      e.detail = "横向 " + e.x0 + "–" + e.x1 + " px：上方周期 " + fmt(e.strips[0].pUp, 1) + " px，下方 " + fmt(e.strips[0].pDown, 1) + " px";
      if (e.n > 1) { e.lo = e.rlo; e.hi = e.rhi; }
      if (e.n === 1) e.note = "只有一条竖带，没有别的印证，谨慎采用。";
      if (Math.abs(e.k - 1) < 0.03) e.note = "上下周期相同：可能没拉伸，也可能只是视频压缩的块网格。";
      if (Math.abs(e.y0At - p.y0) > 4) e.note = "分界线动过了，重新找一次更准。";
    }
  }
  function addEv(e, adoptIt) {
    e.id = ++S.seq; computeEv(e); S.ev.push(e);
    if (adoptIt && e.k != null) adopt(e.id); else { renderLists(); render(); }
    return e;
  }
  function adopt(id) {
    var e = S.ev.filter(function (x) { return x.id === id; })[0];
    if (!e || e.k == null) return;
    if (e.axis === "x") { S.adoptedX = id; setKx(e.k, true); } else { S.adopted = id; setK(e.k, true); }
  }
  function setK(k, keepAdopted) {
    S.p.k = clamp(k, 0.4, 4);
    if (!keepAdopted) S.adopted = null;
    recomputeAll(); renderLists(); render();
  }
  function setKx(kx, keepAdopted) {
    S.p.kx = clamp(kx, 0.5, 1.6);
    if (!keepAdopted) S.adoptedX = null;
    recomputeAll(); renderLists(); render();
  }
  function recomputeAll() {
    // shape evidence for one axis depends on the other axis' factor: two passes settle it
    for (var pass = 0; pass < 2; pass++) {
      S.ev.forEach(computeEv);
      var a = S.ev.filter(function (x) { return x.id === S.adopted; })[0];
      if (a && a.k != null && a.kind !== "repeat" && a.axis !== "x") S.p.k = clamp(a.k, 0.4, 4);
      var ax = S.ev.filter(function (x) { return x.id === S.adoptedX; })[0];
      if (ax && ax.k != null && ax.axis === "x") S.p.kx = clamp(ax.k, 0.5, 1.6);
    }
    // a shape that moved across the boundary changed axis: drop a stale adoption
    if (S.adopted != null && S.ev.some(function (x) { return x.id === S.adopted && x.axis === "x"; })) S.adopted = null;
    if (S.adoptedX != null && !S.ev.some(function (x) { return x.id === S.adoptedX && x.axis === "x"; })) S.adoptedX = null;
  }

  /* ------------------------------------------------------------ drawing */
  /* Paint the frame with the vertical band squeezed back by p.k, into a canvas cw pixels wide. */
  function paintRestored(ctx, cw, p) {
    var w = S.w, h = S.h, bh = (p.y1 - p.y0) / p.k;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    if (p.y0 > 0) ctx.drawImage(src, 0, 0, w, p.y0, 0, 0, cw, p.y0);
    if (p.y1 > p.y0) ctx.drawImage(src, 0, p.y0, w, p.y1 - p.y0, 0, p.y0, cw, bh + (p.y1 < h ? 0.6 : 0));
    if (p.y1 < h) ctx.drawImage(src, 0, p.y1, w, h - p.y1, 0, p.y0 + bh, cw, h - p.y1);
  }
  function renderOut() {
    var p = S.p, W = Math.max(1, Math.round(S.w / p.kx)), H = Math.max(1, Math.round(AF.restoredHeight(S.h, p)));
    var resized = out.width !== W || out.height !== H;
    if (resized) { out.width = W; out.height = H; }
    octx.fillStyle = "#000"; octx.fillRect(0, 0, W, H);
    paintRestored(octx, W, p);
    if (resized) layout();
  }
  function drawBoxShape(c, b, shape) {
    if (shape === "ellipse") c.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(1, b.w / 2), Math.max(1, b.h / 2), 0, 0, Math.PI * 2);
    else c.rect(b.x, b.y, b.w, b.h);
  }
  function drawSeg(c, s, t) { c.moveTo(s.x - t, s.ya); c.lineTo(s.x + t, s.ya); c.moveTo(s.x, s.ya); c.lineTo(s.x, s.yb); c.moveTo(s.x - t, s.yb); c.lineTo(s.x + t, s.yb); }
  function renderView() {
    var p = S.p, w = S.w, h = S.h, ds = S.ds, lw = 1.6 * ds, fs = 12 * ds;
    if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
    vctx.drawImage(src, 0, 0);
    vctx.fillStyle = "rgba(255,74,43,.10)"; vctx.fillRect(0, p.y0, w, p.y1 - p.y0);

    S.cands.forEach(function (c, i) {
      var hot = S.hover === "c" + i;
      halo(vctx, function (x) { drawBoxShape(x, c, c.type); }, CAND, hot ? lw * 1.6 : lw, hot ? [] : [5 * ds, 4 * ds]);
      label(vctx, String.fromCharCode(65 + i), c.x, c.y - 2 * ds, CAND, fs);
    });
    S.ev.forEach(function (e, i) {
      var hot = S.hover === "e" + e.id || S.adopted === e.id, col = hot ? MARK2 : MARK, n = String(i + 1);
      if (e.kind === "box") {
        halo(vctx, function (x) { drawBoxShape(x, e.box, e.shape); }, col, lw);
        label(vctx, n, e.box.x, e.box.y - 2 * ds, col, fs);
      } else if (e.kind === "gap") {
        halo(vctx, function (x) { drawSeg(x, e.A, 7 * ds); drawSeg(x, e.B, 7 * ds); }, col, lw);
        label(vctx, n, e.A.x + 9 * ds, e.A.ya + fs, col, fs);
      } else if (e.kind === "body") {
        halo(vctx, function (x) { x.moveTo(e.px[0], e.H); x.lineTo(e.px[1], e.J); x.lineTo(e.px[2], e.S); }, col, lw, [3 * ds, 4 * ds]);
        [[e.px[0], e.H], [e.px[1], e.J], [e.px[2], e.S]].forEach(function (q) {
          halo(vctx, function (x) { x.arc(q[0], q[1], 5 * ds, 0, 7); }, col, lw);
        });
        label(vctx, n, e.px[0] + 8 * ds, e.H, col, fs);
      } else if (e.kind === "repeat") {
        var shown = [];
        e.strips.slice().sort(function (a, b) { return b.snr - a.snr; }).forEach(function (s) {
          if (shown.length < 3 && !shown.some(function (o) { return s.x0 < o.x1 && o.x0 < s.x1; })) shown.push(s);
        });
        shown.forEach(function (s) {
          halo(vctx, function (x) {
            x.rect(s.x0, s.ua, s.x1 - s.x0, s.ub - s.ua); x.rect(s.x0, s.da, s.x1 - s.x0, s.db - s.da);
          }, col, lw * 0.7, [2 * ds, 3 * ds]);
          vctx.save(); vctx.strokeStyle = col; vctx.lineWidth = Math.max(1, lw * 0.8); vctx.beginPath();
          var y, tl = 10 * ds;
          for (y = s.ub; y > s.ua; y -= s.pUp) { vctx.moveTo(s.x0, y); vctx.lineTo(s.x0 + tl, y); }
          for (y = s.da; y < s.db; y += s.pDown) { vctx.moveTo(s.x0, y); vctx.lineTo(s.x0 + tl, y); }
          vctx.stroke(); vctx.restore();
        });
        label(vctx, n, shown[0].x0, shown[0].ua, col, fs);
      }
    });
    // draft
    var d = S.draft;
    if (d && d.box) halo(vctx, function (x) { drawBoxShape(x, d.box, S.mode); }, "#fff", lw, [4 * ds, 3 * ds]);
    if (d && d.seg) halo(vctx, function (x) { drawSeg(x, d.seg, 7 * ds); }, "#fff", lw);
    if (S.gapA) halo(vctx, function (x) { drawSeg(x, S.gapA, 7 * ds); }, MARK2, lw);
    S.pts.forEach(function (q) { halo(vctx, function (x) { x.arc(q.x, q.y, 5 * ds, 0, 7); }, MARK2, lw); });

    // boundary lines on top
    halo(vctx, function (x) { x.moveTo(0, p.y0); x.lineTo(w, p.y0); }, MARK, lw * 1.2);
    label(vctx, "分界线 " + Math.round(p.y0), w - 96 * ds, p.y0 - 3 * ds, MARK, fs);
    if (!S.toBottom) {
      halo(vctx, function (x) { x.moveTo(0, p.y1); x.lineTo(w, p.y1); }, MARK, lw, [8 * ds, 5 * ds]);
      label(vctx, "拉伸到 " + Math.round(p.y1), w - 96 * ds, p.y1 - 3 * ds, MARK, fs);
    }
  }
  function drawRuler() {
    var cssH = parseFloat(view.style.height) || 0, cssW = 34, dpr = Math.min(2, window.devicePixelRatio || 1);
    ruler.style.width = cssW + "px"; ruler.style.height = cssH + "px";
    ruler.width = Math.round(cssW * dpr); ruler.height = Math.max(1, Math.round(cssH * dpr));
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0); rctx.clearRect(0, 0, cssW, cssH);
    if (!S.h) return;
    var sc = cssH / S.h, step = sc > 0.9 ? 50 : sc > 0.45 ? 100 : 200;
    rctx.strokeStyle = "rgba(201,207,218,.55)"; rctx.fillStyle = "rgba(201,207,218,.85)"; rctx.lineWidth = 1;
    rctx.font = "9px ui-monospace, Menlo, Consolas, monospace"; rctx.textBaseline = "middle"; rctx.textAlign = "right";
    for (var y = 0; y <= S.h; y += step / 5) {
      var major = Math.round(y) % step === 0, py = Math.round(y * sc) + 0.5;
      rctx.beginPath(); rctx.moveTo(cssW - (major ? 9 : 4), py); rctx.lineTo(cssW, py); rctx.stroke();
      if (major && y > 0 && py < cssH - 6) rctx.fillText(String(Math.round(y)), cssW - 11, py);
    }
    rctx.fillStyle = MARK;
    [S.p.y0].concat(S.toBottom ? [] : [S.p.y1]).forEach(function (yy) {
      var q = yy * sc; rctx.beginPath(); rctx.moveTo(cssW, q); rctx.lineTo(cssW - 8, q - 5); rctx.lineTo(cssW - 8, q + 5); rctx.closePath(); rctx.fill();
    });
  }
  function layout() {
    if (!S.w) return;
    var views = $("views"), avail = views.clientWidth, gap = 14, rw = 34;
    var two = avail >= 520;
    var colW = two ? (avail - gap - rw) / 2 : avail - rw;
    var maxH = clamp(window.innerHeight * 0.74, 320, 760);
    var sc = Math.min(colW / Math.max(S.w, out.width || S.w), maxH / S.h, 2);
    view.style.width = S.w * sc + "px"; view.style.height = S.h * sc + "px";
    out.style.width = (out.width || S.w) * sc + "px"; out.style.height = out.height * sc + "px";
    S.ds = 1 / sc;
    drawRuler();
  }
  function renderReadout() {
    var p = S.p, a = S.ev.filter(function (x) { return x.id === S.adopted; })[0];
    $("kBig").innerHTML = "<small>×</small>" + fmt(p.k);
    var st = $("kState"), words = $("kWords"), srcEl = $("kSrc");
    st.className = "state" + (a ? (a.kind === "body" ? " prior" : " backed") : "");
    st.textContent = a ? (a.kind === "body" ? "仅凭统计" : "有依据") : "手动";
    var pct = Math.round((p.k - 1) * 100);
    var ax = S.ev.filter(function (x) { return x.id === S.adoptedX; })[0], px = Math.round((1 - p.kx) * 100);
    words.textContent = (Math.abs(p.k - 1) < 0.03 ? "看不出纵向拉伸" : pct > 0 ? "下半截被拉长约 " + pct + "%" : "下半截被压短约 " + (-pct) + "%") +
      (Math.abs(p.kx - 1) < 0.015 ? "" : px > 0 ? "；整幅被横向压窄约 " + px + "%" : "；整幅被横向拉宽约 " + (-px) + "%");
    srcEl.textContent = (a ? "来源：" + a.title + (a.lo != null ? "，区间 " + fmt(a.lo) + "–" + fmt(a.hi) : "") : "来源：纵向是手动调的，没有依据") +
      (Math.abs(p.kx - 1) < 0.015 ? "" : ax ? "；横向来自 " + ax.title : "；横向是手动调的");
    if (document.activeElement !== $("kxNum")) $("kxNum").value = fmt(p.kx);
    $("kxRange").value = p.kx;
    if (document.activeElement !== $("kNum")) $("kNum").value = fmt(p.k);
    $("kRange").value = p.k;
    if (document.activeElement !== $("y0Num")) $("y0Num").value = Math.round(p.y0);
    if (document.activeElement !== $("y1Num")) $("y1Num").value = Math.round(p.y1);
  }
  function render() {
    if (!S.w) return;
    renderOut(); renderView(); drawRuler(); renderReadout();
  }
  function renderLists() {
    var ev = $("evList"), html = "";
    S.ev.forEach(function (e, i) {
      var on = S.adopted === e.id || S.adoptedX === e.id;
      html += '<li class="item' + (on ? " adopted" : "") + '" data-ev="' + e.id + '"><span class="n">' + (i + 1) + '</span>' +
        '<span class="what">' + e.title + '<small>' + e.detail + (e.note ? "<br>" + e.note : "") + '</small></span>' +
        '<span class="acts"><span class="kv">' + (e.k == null ? "–" : (e.axis === "x" ? "横向 ×" : "×") + fmt(e.k)) + '</span>' +
        (e.k != null && !on ? '<button type="button" class="mini" data-adopt="' + e.id + '">采用</button>' : "") +
        '<button type="button" class="mini x" data-del="' + e.id + '" aria-label="删除这条依据">删除</button></span></li>';
    });
    ev.innerHTML = html;
    $("evEmpty").hidden = S.ev.length > 0;
    $("evCount").textContent = S.ev.length ? S.ev.length + " 条" : "";
    var cl = $("candList"), ch = "";
    S.cands.forEach(function (c, i) {
      var r = AF.kFromBox(c, S.p, 1), nm = c.type === "ellipse" ? "椭圆" : "矩形", outside = r.frac < 0.15;
      var val = outside ? AF.kxFromBox(c, S.p, 1).kx : r.k, btn = "它本来是" + (c.type === "ellipse" ? "正圆" : "正方形");
      ch += '<li class="item cand" data-cand="' + i + '"><span class="n">' + String.fromCharCode(65 + i) + '</span>' +
        '<span class="what">' + nm + " " + fmt(c.w, 0) + "×" + fmt(c.h, 0) + " px" +
        '<small>高÷宽 ' + fmt(c.ratio) + (outside ? "，在拉伸带之外：可以用来量横向" : r.k != null && r.k < 0.97 ? "。按正方形算会小于 1，它多半本来就是扁的" : "") + '</small></span>' +
        '<span class="acts">' + (val != null ? '<span class="kv">' + (outside ? "横向 ×" : "×") + fmt(val) + '</span><button type="button" class="mini" data-use="' + i + '">' + btn + '</button>' : "") + '</span></li>';
    });
    cl.innerHTML = ch;
  }

  /* ------------------------------------------------------------ auto scan */
  function scan() {
    if (!S.w) return;
    var g = getGray(), p = S.p;
    S.ev = S.ev.filter(function (e) { return e.kind !== "repeat"; });
    var r = AF.findRepeatCandidates(g.b, S.w, S.h, Math.round(p.y0), Math.round(p.y1)), rep = null;
    var strong = r.clusters.filter(function (c) { return c.n >= 2; }).slice(0, 3), reps = [];
    strong.forEach(function (c) { reps.push({ kind: "repeat", k: c.k, rlo: c.lo, rhi: c.hi, n: c.n, x0: c.x0, x1: c.x1, strips: c.strips, y0At: p.y0 }); });
    if (!reps.length && r.cands.length) { var c0 = r.cands[0]; reps.push({ kind: "repeat", k: c0.k, n: 1, x0: c0.x0, x1: c0.x1, strips: [c0], y0At: p.y0 }); }
    rep = reps[0] || null;
    var shapes = AF.findShapeCandidates(g.g, S.w, S.h, {});
    shapes.forEach(function (c) { var q = AF.kFromBox(c, p, 1).k; c.inBand = q != null; c.plaus = q != null && q > 1.03 && q < 2.4; });
    shapes.sort(function (a, b) { return (b.plaus - a.plaus) || (b.inBand - a.inBand) || (b.score - a.score); });
    // keep shapes that could be a stretched square or circle, plus a couple outside the band as controls
    var keep = shapes.filter(function (c) { return c.plaus; }).slice(0, 5);
    // outside the band a square or circle measures the horizontal squeeze; keep the ones that could be one
    S.cands = keep.concat(shapes.filter(function (c) {
      if (c.inBand) return false;
      var qx = AF.kxFromBox(c, p, 1).kx; return qx != null && qx > 0.7 && qx < 1.12;
    }).slice(0, 3));
    var conflict = reps.length > 1;
    // identical periods above and below can be a real "no stretch" or just the codec's block grid: never auto-adopt
    var flat = rep && Math.abs(rep.k - 1) < 0.03;
    reps.forEach(function (q) { addEv(q, !conflict && !flat && q.n > 1); });
    var nIn = S.cands.filter(function (c) { return c.inBand; }).length, msg = [];
    if (conflict) msg.push("重复结构给出了互相矛盾的倍数（" + reps.map(function (q) { return "×" + fmt(q.k); }).join("、") + "），画面多半是几块拼成的。先用“只留一块画面”框出被拉伸的那块，再找一次");
    else if (flat) msg.push("重复结构上下周期相同（×" + fmt(rep.k) + "）：可能没拉伸，也可能只是视频压缩的块网格，没自动采用");
    else if (rep) msg.push("重复结构：" + rep.n + " 条竖带，估计 ×" + fmt(rep.k) + (rep.n > 1 ? "，已采用" : "（只有一条，没自动采用）"));
    if (S.cands.length) msg.push("形状候选 " + S.cands.length + " 个（" + nIn + " 个在拉伸带里量纵向，其余量横向），请确认哪个本来是正方形或正圆");
    if (!msg.length) msg.push("没找到可用的参照物。可以手动框选、量间距，或者用人体比例");
    hint(msg.join("；") + "。", conflict || (!rep && !nIn));
    renderLists(); render();
  }

  /* ------------------------------------------------------------ pose model (optional) */
  /* MediaPipe Pose, loaded on demand: first from ./vendor/pose/ (if the site ships it),
     then from jsDelivr. If neither loads, the manual three-point tool still works. */
  var POSE_VER = "0.5.1675469404";
  var POSE_BASES = ["vendor/pose/", "https://cdn.jsdelivr.net/npm/@mediapipe/pose@" + POSE_VER + "/"];
  var Pz = { pose: null, state: "idle", last: null, loading: null, dim: { w: 1, h: 1 } };
  var iterC = document.createElement("canvas"), iterX = iterC.getContext("2d");
  var maskC = document.createElement("canvas"), maskX = maskC.getContext("2d", { willReadFrequently: true });
  function poseStatus(t) { $("poseState").textContent = t; }
  function loadScript(url) {
    return new Promise(function (res, rej) {
      var el = document.createElement("script"); el.src = url; el.onload = res;
      el.onerror = function () { el.remove(); rej(new Error("script")); }; document.head.appendChild(el);
    });
  }
  function withTimeout(pr, ms) {
    return new Promise(function (res, rej) { var t = setTimeout(function () { rej(new Error("timeout")); }, ms); pr.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); }); });
  }
  function onPose(r) {
    var lm = r.poseLandmarks;
    if (!lm) { Pz.last = null; return; }
    var dw = Pz.dim.w, dh = Pz.dim.h;
    var out = { lm: lm.map(function (q) { return { x: q.x * dw, y: q.y * dh, v: q.visibility == null ? 1 : q.visibility }; }), top: null };
    if (r.segmentationMask) {
      try {
        var W = 192, H = Math.max(8, Math.round(192 * dh / dw));
        maskC.width = W; maskC.height = H; maskX.clearRect(0, 0, W, H); maskX.drawImage(r.segmentationMask, 0, 0, W, H);
        var d = maskX.getImageData(0, 0, W, H).data, thr = Math.max(2, Math.round(W * 0.012));
        for (var y = 0; y < H && out.top == null; y++) { var c = 0; for (var x = 0; x < W; x++) if (d[(y * W + x) * 4] > 127) c++; if (c >= thr) out.top = (y + 0.5) * dh / H; }
      } catch (e) {}
    }
    Pz.last = out;
  }
  function ensurePose() {
    if (Pz.pose) return Promise.resolve(Pz.pose);
    if (Pz.state === "failed") return Promise.reject(new Error("pose unavailable"));
    if (Pz.loading) return Pz.loading;
    poseStatus("人体识别：正在加载模型（约 10 MB，只需一次）");
    function tryBase(i) {
      if (i >= POSE_BASES.length) return Promise.reject(new Error("pose unavailable"));
      var base = POSE_BASES[i];
      return (window.Pose ? Promise.resolve() : loadScript(base + "pose.js")).then(function () {
        var pose = new window.Pose({ locateFile: function (f) { return base + f; } });
        pose.setOptions({ modelComplexity: 1, smoothLandmarks: false, enableSegmentation: true, minDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
        pose.onResults(onPose);
        return withTimeout(pose.initialize(), 25000).then(function () { return pose; });
      }).catch(function () { return tryBase(i + 1); });
    }
    Pz.loading = tryBase(0).then(function (pose) { Pz.pose = pose; Pz.state = "ready"; Pz.loading = null; poseStatus("人体识别：可用"); return pose; },
      function (e) { Pz.state = "failed"; Pz.loading = null; poseStatus("人体识别：这个环境加载不了模型，请用“人体比例”手动点三个点"); throw e; });
    return Pz.loading;
  }
  /* Run the model on a canvas. fresh=true forgets the previous frame (still images). */
  function detectOn(canvas, fresh) {
    return ensurePose().then(function (pose) {
      if (fresh) pose.reset();
      Pz.last = null; Pz.dim = { w: canvas.width, h: canvas.height };
      return withTimeout(pose.send({ image: canvas }), 60000).then(function () { return Pz.last; });
    });
  }
  function detectPose(fresh) { return detectOn(src, fresh); }
  /* Head top, knee and sole from one detection, plus a posture check. The proportion prior is for
     someone standing upright, so the knee and sole are taken from the straighter, more vertical leg. */
  function bodyFromPose(r, hgt) {
    var lm = r.lm, sh = (lm[11].y + lm[12].y) / 2, hip = (lm[23].y + lm[24].y) / 2;
    var smx = (lm[11].x + lm[12].x) / 2, hmx = (lm[23].x + lm[24].x) / 2, deg = 180 / Math.PI;
    var torsoTilt = Math.abs(Math.atan2(hmx - smx, hip - sh)) * deg;
    var legs = [[23, 25, 27, 29, 31], [24, 26, 28, 30, 32]].map(function (L) {
      var h = lm[L[0]], k = lm[L[1]], a = lm[L[2]];
      var v1x = k.x - h.x, v1y = k.y - h.y, v2x = a.x - k.x, v2y = a.y - k.y;
      var bend = Math.acos(clamp((v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9), -1, 1)) * deg;
      var tilt = Math.abs(Math.atan2(a.x - h.x, a.y - h.y)) * deg;
      return { k: k, bend: bend, tilt: tilt, foot: Math.max(lm[L[3]].y, lm[L[4]].y), footX: (lm[L[3]].x + lm[L[4]].x) / 2,
               vis: Math.min(k.v, a.v, lm[L[3]].v, lm[L[4]].v) };
    }).sort(function (p, q) { return (p.bend + p.tilt) - (q.bend + q.tilt); });
    var L = legs[0], why = [];
    if (torsoTilt > 20) why.push("身体倾斜");
    if (L.bend > 25 || L.tilt > 25) why.push("腿没有站直");
    if (L.foot > hgt - 6) why.push("脚出画了");
    var H = r.top != null ? r.top : lm[0].y - 0.55 * (sh - lm[0].y);
    return { H: H, K: L.k.y, S: Math.min(L.foot, hgt), px: [lm[0].x, L.k.x, L.footX], sh: sh, hip: hip,
             cut: L.foot > hgt - 6, ok: !why.length, why: why.join("、") };
  }
  /* The pose model has learned normal proportions and pulls a stretched leg back toward them, so one
     reading sees only part of the stretch. Undo the stretch by the current estimate, look again, and
     repeat: when the restored body reads as "median", the accumulated factor is the estimate.
     Returns the three points in the coordinates of the original frame. */
  async function iterBody(first) {
    var y0 = S.p.y0, y1 = S.p.y1, k = 1, best = null, direct = null;
    for (var it = 0; it < 5; it++) {
      var q = { y0: y0, y1: y1, k: k }, ht = Math.round(AF.restoredHeight(S.h, q)), r;
      if (it === 0 && first) r = first;
      else { iterC.width = S.w; iterC.height = ht; paintRestored(iterX, S.w, q); r = await detectOn(iterC, true); }
      if (!r) break;
      var b = bodyFromPose(r, ht), y1t = y0 + (y1 - y0) / k, kk = k;
      var res = AF.kFromBody(b.H, b.K, b.S, { y0: y0, y1: y1t, k: 1 }, AF.PRIORS.knee.p50);
      var back = function (y) { return y <= y0 ? y : y <= y1t ? y0 + (y - y0) * kk : y1 + (y - y1t); };
      if (it === 0) direct = res;
      best = { H: back(b.H), K: back(b.K), S: back(b.S), hip: back(b.hip), px: b.px, ok: b.ok, why: b.why, cut: b.cut, rounds: it + 1, direct: direct };
      if (res == null) break;
      k = clamp(k * res, 0.5, 3);
      if (Math.abs(res - 1) < 0.015) break;
    }
    return best;
  }
  function seekTo(t) {
    return new Promise(function (res) {
      var done = false, f = function () { if (done) return; done = true; video.removeEventListener("seeked", f); res(); };
      video.addEventListener("seeked", f); setTimeout(f, 5000);
      try { video.currentTime = t; } catch (e) { f(); }
    });
  }
  /* One frame is one pose. Across a video the stretch is the same in every frame, so read several
     frames and take the median. */
  async function bodyAcrossFrames(n) {
    var d = video.duration || 0, t0 = video.currentTime, out = [];
    for (var i = 0; i < n; i++) {
      hint("人体比例：正在看第 " + (i + 1) + " / " + n + " 帧…");
      await seekTo(d * (0.06 + 0.88 * i / (n - 1))); drawFrame();
      var b = await iterBody(null);
      if (!b) continue;
      var e = AF.bodyEstimate(b.H, b.K, b.S, S.p, "knee");
      if (e.k50 != null) out.push({ b: b, k: e.k50 });
    }
    await seekTo(t0); drawFrame();
    return out;
  }
  /* Boundary suggestion: a period jump in a repeating background if there is a solid one
     (kept only if it falls between chest and knees when a body was found); otherwise hip height. */
  function suggestBoundary(body) {
    var g = getGray(), cl = AF.findBoundary(g.b, S.w, S.h) || [];
    var pick = cl.filter(function (c) { return c.strong && (!body || (c.y0 >= body.sh + 0.3 * (body.hip - body.sh) && c.y0 <= body.K)); })[0];
    if (pick) return { y0: pick.y0, how: "texture", k: pick.k, n: pick.n };
    if (body) return { y0: body.hip, how: "pose" };
    return null;
  }
  async function autoAll() {
    if (!S.w || S.busy) return;
    S.busy = true; $("autoBtn").disabled = true;
    try {
      if (S.kind === "video") video.pause();
      hint("正在分析：识别人体、找分界线、找参照物…");
      var r = await detectPose(true).catch(function () { return null; });
      await new Promise(function (res) { setTimeout(res, 30); });
      var body = r ? bodyFromPose(r, S.h) : null, sug = suggestBoundary(body), notes = [];
      S.ev = S.ev.filter(function (e) { return !(e.kind === "body" && e.auto); });
      if (sug) {
        S.p.y0 = clamp(Math.round(sug.y0), 1, S.p.y1 - 8); recomputeAll();
        notes.push(sug.how === "texture" ? "分界线按背景周期突变定在 " + S.p.y0 + "（" + sug.n + " 条竖带一致）" : "背景里没有可靠的周期突变，分界线先按胯部粗略放在 " + S.p.y0 + "，请拖准");
      } else notes.push("没找到分界线的线索，请手动拖");
      scan();
      var scanMsg = $("hint").textContent;
      if (body) {
        var pick = null, multi = null;
        if (S.kind === "video" && (video.duration || 0) > 3) {
          if (sug && sug.how === "pose") {
            var pre = await iterBody(r);
            for (var vp = 0; pre && vp < 2 && Math.abs(pre.hip - S.p.y0) > 10; vp++) { S.p.y0 = clamp(Math.round(pre.hip), 1, S.p.y1 - 8); recomputeAll(); pre = await iterBody(null); }
            notes[0] = "背景里没有可靠的周期突变，分界线按还原后的胯部放在 " + S.p.y0 + "，可以再拖准";
            scan(); scanMsg = $("hint").textContent;
          }
          // every frame that gave a reading counts: on real clips a posture filter did not pick better frames
          var fr = await bodyAcrossFrames(7), use = fr;
          if (use.length) {
            var ks = use.map(function (f) { return f.k; }).sort(function (a, b) { return a - b; }), med = ks[ks.length >> 1];
            pick = use.slice().sort(function (a, b) { return Math.abs(a.k - med) - Math.abs(b.k - med); })[0].b;
            multi = { frames: 7, used: use.length, lo: ks[0], hi: ks[ks.length - 1] };
          }
        } else pick = await iterBody(r);
        // The hip found on the raw frame sits too low for the same reason the leg reads short.
        // Once the body is restored the hip is trustworthy: move a hip-based boundary there and read again.
        if (pick && sug && sug.how === "pose" && !multi) {
          for (var pass = 0; pass < 2 && Math.abs(pick.hip - S.p.y0) > 10; pass++) {
            S.p.y0 = clamp(Math.round(pick.hip), 1, S.p.y1 - 8); recomputeAll();
            var again = await iterBody(null);
            if (!again) break;
            pick = again;
          }
          notes[0] = "背景里没有可靠的周期突变，分界线按还原后的胯部放在 " + S.p.y0 + "，可以再拖准";
          scan(); scanMsg = $("hint").textContent;
        }
        if (pick) {
          var eb = addEv({ kind: "body", auto: true, H: pick.H, J: pick.K, S: pick.S, px: pick.px, which: "knee",
                           rounds: pick.rounds, direct: pick.direct, posture: pick.ok ? "" : pick.why, multi: multi }, false);
          // Not adopted automatically: one person's proportions and the camera angle still decide a lot.
          if (eb.k != null) notes.push("人体比例读数 ×" + fmt(eb.k) + "（" + fmt(eb.lo) + "–" + fmt(eb.hi) + "）" +
            (multi ? "，取自 " + multi.used + " 帧的中位" : "") + (pick.ok || multi ? "" : "；这一帧" + pick.why + "，读数不可靠") + "；只供参考，没有自动采用");
        } else notes.push("没识别到人体");
      } else if (Pz.state === "failed") notes.push("人体模型加载不了，人体比例请手动点三个点");
      else notes.push("没识别到人体");
      hint(notes.join("；") + "。" + scanMsg, !sug);
    } catch (e) { hint("自动分析出错：" + (e && e.message || e), true); }
    S.busy = false; $("autoBtn").disabled = false;
  }
  /* Tracking filters: the band follows the body. Keep the boundary at a fixed offset from the hips. */
  var trackBusy = false;
  function trackStep() {
    if (!S.track || trackBusy || !Pz.pose) return;
    trackBusy = true;
    detectPose(false).then(function (r) {
      if (r && S.track) { var hip = (r.lm[23].y + r.lm[24].y) / 2; S.p.y0 = clamp(Math.round(hip + S.trackOff), 1, S.p.y1 - 8); if (video.paused) render(); }
    }).catch(function () {}).then(function () { trackBusy = false; });
  }
  function setTrack(on) {
    if (!on) { S.track = false; $("track").checked = false; return; }
    hint("正在识别人体，用来让分界线跟着胯部走…");
    detectPose(true).then(function (r) {
      if (!r) { hint("这一帧没识别到人体，没法跟随。", true); $("track").checked = false; return; }
      S.trackOff = S.p.y0 - (r.lm[23].y + r.lm[24].y) / 2; S.track = true;
      hint("分界线会保持在胯部" + (S.trackOff >= 0 ? "下方 " : "上方 ") + Math.abs(Math.round(S.trackOff)) + " px。这是实验功能，还没在真正的跟踪特效上验证过。");
    }).catch(function () { hint("人体模型加载不了，没法跟随。", true); $("track").checked = false; });
  }

  /* ------------------------------------------------------------ tools */
  function setMode(m) {
    S.mode = S.mode === m ? "idle" : m; S.draft = null; S.pts = []; S.gapA = null;
    TOOLS.forEach(function (id) { $(id).classList.toggle("on", $(id).dataset.mode === S.mode); });
    if (S.mode === "rect") hint("在原画面上拖一个框，套住本来是方形的东西。");
    else if (S.mode === "ellipse") hint("拖一个框，让椭圆贴住球或圆形物体的轮廓。");
    else if (S.mode === "gap") hint("第一段：在分界线上方，竖着拖过几个重复单元（比如 5 条砖缝）。");
    else if (S.mode === "body") hint("依次点三个点：头顶 → " + ($("joint").value === "knee" ? "膝盖中心" : "裆部") + " → 脚底。");
    else if (S.mode === "crop") hint("拖一个框，只留下被拉伸的那块画面。之前的依据会清空。");
    else idleHint();
    render();
  }
  function pos(e) {
    var r = view.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) * S.w / r.width, 0, S.w), y: clamp((e.clientY - r.top) * S.h / r.height, 0, S.h) };
  }
  function nearLine(y) {
    var t = 11 * S.ds;
    if (!S.toBottom && Math.abs(y - S.p.y1) < t) return "y1";
    if (Math.abs(y - S.p.y0) < t) return "y0";
    return null;
  }
  function hitBodyPoint(q) {
    var t = 12 * S.ds, hit = null;
    S.ev.forEach(function (e) {
      if (e.kind !== "body") return;
      [e.H, e.J, e.S].forEach(function (y, i) { if (Math.abs(q.y - y) < t && Math.abs(q.x - e.px[i]) < t) hit = { e: e, i: i }; });
    });
    return hit;
  }
  function setY0(y) { S.p.y0 = clamp(Math.round(y), 1, S.p.y1 - 8); recomputeAll(); renderLists(); render(); }
  function setY1(y) { S.p.y1 = clamp(Math.round(y), S.p.y0 + 8, S.h); recomputeAll(); renderLists(); render(); }

  view.addEventListener("pointerdown", function (e) {
    if (!S.w || S.recording) return;
    var q = pos(e); view.setPointerCapture(e.pointerId);
    if (S.mode === "idle") {
      var hp = hitBodyPoint(q);
      if (hp) { S.drag = hp; return; }
      var ln = nearLine(q.y); if (ln) S.drag = ln; return;
    }
    if (S.mode === "rect" || S.mode === "ellipse" || S.mode === "crop") S.draft = { sx: q.x, sy: q.y, box: { x: q.x, y: q.y, w: 0, h: 0 } };
    else if (S.mode === "gap") S.draft = { seg: { x: q.x, ya: q.y, yb: q.y } };
  });
  view.addEventListener("pointermove", function (e) {
    if (!S.w) return;
    var q = pos(e);
    if (S.drag && S.drag.e) {
      var de = S.drag.e, key = ["H", "J", "S"][S.drag.i];
      de[key] = q.y; de.px[S.drag.i] = q.x; computeEv(de);
      if (S.adopted === de.id && de.k != null) S.p.k = clamp(de.k, 0.4, 4);
      renderLists(); render(); return;
    }
    if (S.drag === "y0") return setY0(q.y);
    if (S.drag === "y1") return setY1(q.y);
    if (S.mode === "idle") { view.style.cursor = hitBodyPoint(q) ? "grab" : nearLine(q.y) ? "ns-resize" : "default"; return; }
    view.style.cursor = "crosshair";
    if (!S.draft) return;
    if (S.draft.box) S.draft.box = { x: Math.min(S.draft.sx, q.x), y: Math.min(S.draft.sy, q.y), w: Math.abs(q.x - S.draft.sx), h: Math.abs(q.y - S.draft.sy) };
    if (S.draft.seg) S.draft.seg.yb = q.y;
    renderView();
  });
  function endPointer(e) {
    if (!S.w) return;
    var q = pos(e);
    if (S.drag) { S.drag = null; return; }
    if (S.mode === "crop") {
      var cd = S.draft; S.draft = null;
      if (!cd || cd.box.w < 40 || cd.box.h < 40) { hint("框太小了，再拖大一点。", true); renderView(); return; }
      applyCrop(cd.box); return;
    }
    if (S.mode === "rect" || S.mode === "ellipse") {
      var d = S.draft; S.draft = null;
      if (!d || d.box.w < 8 * S.ds || d.box.h < 8 * S.ds) { renderView(); return; }
      var b = d.box, g = getGray();
      if ($("snap").checked) b = S.mode === "rect" ? AF.snapRect(g.b, S.w, S.h, b) : AF.snapEllipse(g.b, S.w, S.h, b, Math.max(3, 0.03 * Math.min(b.w, b.h)));
      var tr = parseFloat($("trueRatio").value) || 1;
      var ev = addEv({ kind: "box", shape: S.mode, box: { x: b.x, y: b.y, w: b.w, h: b.h }, tr: tr }, true);
      hint(ev.k == null ? ev.note : "量到高÷宽 " + fmt(b.h / b.w) + "，估计" + (ev.axis === "x" ? "横向 ×" : " ×") + fmt(ev.k) + "，已采用。框得不准可以关掉“吸附边缘”重框。", ev.k == null);
      setModeSilently("idle");
    } else if (S.mode === "gap") {
      var s = S.draft && S.draft.seg; S.draft = null;
      if (!s || Math.abs(s.yb - s.ya) < 6 * S.ds) { renderView(); return; }
      s = { x: s.x, ya: Math.min(s.ya, s.yb), yb: Math.max(s.ya, s.yb) };
      if (!S.gapA) { S.gapA = s; hint("第二段：在拉伸带里，拖过同样数量的重复单元。"); renderView(); return; }
      var A = S.gapA, B = s; S.gapA = null;
      if ((A.ya + A.yb) > (B.ya + B.yb)) { var t = A; A = B; B = t; }
      var eg = addEv({ kind: "gap", A: A, B: B }, true);
      hint(eg.k == null ? eg.note : "两段相比，估计 ×" + fmt(eg.k) + "，已采用。", eg.k == null);
      setModeSilently("idle");
    } else if (S.mode === "body") {
      S.pts.push(q);
      var names = ["头顶", $("joint").value === "knee" ? "膝盖中心" : "裆部", "脚底"];
      if (S.pts.length < 3) { hint("已点 " + names[S.pts.length - 1] + "，接着点 " + names[S.pts.length] + "。"); renderView(); return; }
      var P = S.pts.slice().sort(function (a, c) { return a.y - c.y; }); S.pts = [];
      var eb = addEv({ kind: "body", H: P[0].y, J: P[1].y, S: P[2].y, px: [P[0].x, P[1].x, P[2].x], which: $("joint").value }, false);
      hint(eb.k == null ? eb.note : "按人群中位比例，估计 ×" + fmt(eb.k) + "（" + fmt(eb.lo) + "–" + fmt(eb.hi) + "）。这只是统计，没有自动采用。", eb.k == null);
      setModeSilently("idle");
    }
  }
  function setModeSilently(m) {
    S.mode = m; S.draft = null;
    TOOLS.forEach(function (id) { $(id).classList.toggle("on", $(id).dataset.mode === S.mode); });
    render();
  }
  view.addEventListener("pointerup", endPointer);
  view.addEventListener("pointercancel", function () { S.drag = null; S.draft = null; renderView(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.mode !== "idle") setMode(S.mode); });

  TOOLS.forEach(function (id) { $(id).addEventListener("click", function () { setMode($(id).dataset.mode); }); });
  $("scanBtn").addEventListener("click", scan);
  $("autoBtn").addEventListener("click", autoAll);
  $("track").addEventListener("change", function () { setTrack(this.checked); });
  $("uncrop").addEventListener("click", clearCrop);
  $("kRange").addEventListener("input", function () { setK(parseFloat(this.value)); });
  $("kNum").addEventListener("change", function () { var v = parseFloat(this.value); if (isFinite(v)) setK(v); });
  $("kxRange").addEventListener("input", function () { setKx(parseFloat(this.value)); });
  $("kxNum").addEventListener("change", function () { var v = parseFloat(this.value); if (isFinite(v)) setKx(v); });
  $("y0Num").addEventListener("change", function () { var v = parseFloat(this.value); if (isFinite(v)) setY0(v); });
  $("y1Num").addEventListener("change", function () { var v = parseFloat(this.value); if (isFinite(v)) setY1(v); });
  $("toBottom").addEventListener("change", function () {
    S.toBottom = this.checked; $("y1Num").hidden = S.toBottom;
    S.p.y1 = S.toBottom ? S.h : Math.round(Math.min(S.h, S.p.y0 + (S.h - S.p.y0) * 0.85));
    recomputeAll(); renderLists(); render();
  });
  $("evList").addEventListener("click", function (e) {
    var t = e.target;
    if (t.dataset.adopt) adopt(+t.dataset.adopt);
    else if (t.dataset.del) {
      var id = +t.dataset.del; S.ev = S.ev.filter(function (x) { return x.id !== id; });
      if (S.adopted === id) S.adopted = null; if (S.adoptedX === id) S.adoptedX = null; renderLists(); render();
    }
  });
  $("candList").addEventListener("click", function (e) {
    var t = e.target; if (t.dataset.use == null) return;
    var c = S.cands[+t.dataset.use]; if (!c) return;
    S.cands.splice(+t.dataset.use, 1);
    var ev = addEv({ kind: "box", shape: c.type, box: { x: c.x, y: c.y, w: c.w, h: c.h }, tr: 1, auto: false }, true);
    hint("按“它本来是" + (c.type === "ellipse" ? "正圆" : "正方形") + "”算，估计" + (ev.axis === "x" ? "横向 ×" : " ×") + fmt(ev.k) + "，已采用。");
  });
  function hoverFrom(list, key, prefix) {
    list.addEventListener("pointerover", function (e) {
      var li = e.target.closest ? e.target.closest("li") : null, v = li ? prefix + li.dataset[key] : null;
      if (v !== S.hover) { S.hover = v; renderView(); }
    });
    list.addEventListener("pointerleave", function () { if (S.hover) { S.hover = null; renderView(); } });
  }
  hoverFrom($("evList"), "ev", "e"); hoverFrom($("candList"), "cand", "c");

  /* ------------------------------------------------------------ loading */
  function resetWork(w, h) {
    S.w = w; S.h = h; src.width = w; src.height = h;
    S.p = { y0: Math.round(h * 0.5), y1: h, k: 1, kx: 1 }; S.adoptedX = null; S.toBottom = true; $("toBottom").checked = true; $("y1Num").hidden = true;
    S.ev = []; S.cands = []; S.adopted = null; S.gray = null; S.mode = "idle"; S.pts = []; S.gapA = null; S.draft = null;
    $("y0Num").max = h; $("y1Num").max = h;
    $("uncrop").hidden = !S.crop; S.track = false; $("track").checked = false;
    TOOLS.forEach(function (id) { $(id).classList.remove("on"); });
  }
  function resetFor(w, h, kind, name) {
    S.kind = kind; S.name = name; S.isDemo = false; S.bw = w; S.bh = h; S.crop = null;
    resetWork(w, h);
    $("transport").hidden = kind !== "video"; $("saveVid").hidden = kind !== "video"; $("trackRow").hidden = kind !== "video";
    $("demoTag").hidden = true;
  }
  function keepBase() { base.width = S.bw; base.height = S.bh; bctx.drawImage(src, 0, 0); }
  function redrawFromBase() {
    var c = S.crop || { x: 0, y: 0, w: S.bw, h: S.bh };
    if (S.kind === "video") drawFrame(); else sctx.drawImage(base, c.x, c.y, c.w, c.h, 0, 0, S.w, S.h);
    S.gray = null;
  }
  function applyCrop(b) {
    var o = S.crop || { x: 0, y: 0 };
    var c = { x: Math.round(o.x + b.x), y: Math.round(o.y + b.y), w: Math.round(b.w), h: Math.round(b.h) };
    c.w = Math.min(c.w, S.bw - c.x); c.h = Math.min(c.h, S.bh - c.y);
    S.crop = c; resetWork(c.w, c.h); redrawFromBase(); renderLists(); layout(); render();
    hint("已只留这一块。拖分界线，再找参照物。");
  }
  function clearCrop() { S.crop = null; resetWork(S.bw, S.bh); redrawFromBase(); renderLists(); layout(); render(); idleHint(); }
  function fitSize(w, h, cap) { var s = Math.min(1, cap / Math.max(w, h)); return [Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s))]; }
  function loadImageFile(file) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var sz = fitSize(img.naturalWidth, img.naturalHeight, 2400);
      stopVideo(); resetFor(sz[0], sz[1], "image", file.name.replace(/\.[^.]+$/, ""));
      sctx.drawImage(img, 0, 0, sz[0], sz[1]); URL.revokeObjectURL(url); keepBase();
      renderLists(); layout(); render(); idleHint();
    };
    img.onerror = function () { URL.revokeObjectURL(url); hint("这张图片打不开。换成 JPG、PNG 或 WebP 再试。", true); };
    img.src = url;
  }
  function stopVideo() { try { video.pause(); } catch (e) {} if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute("src"); video.load(); } }
  function loadVideoFile(file) {
    stopVideo();
    var url = URL.createObjectURL(file);
    video.onloadeddata = function () {
      video.onloadeddata = null;
      var sz = fitSize(video.videoWidth, video.videoHeight, 1920);
      resetFor(sz[0], sz[1], "video", file.name.replace(/\.[^.]+$/, ""));
      drawFrame(); renderLists(); layout(); render(); idleHint();
      try { video.currentTime = Math.min(0.05, video.duration || 0); } catch (e) {}
    };
    video.onerror = function () { hint("这个视频浏览器解不了码。常见的 MP4（H.264）和 WebM 可以。", true); };
    video.muted = true; video.src = url; video.load();
  }
  function drawFrame() {
    if (S.kind !== "video" || !video.videoWidth) return;
    var c = S.crop;
    if (!c) sctx.drawImage(video, 0, 0, S.w, S.h);
    else { var fx = video.videoWidth / S.bw, fy = video.videoHeight / S.bh; sctx.drawImage(video, c.x * fx, c.y * fy, c.w * fx, c.h * fy, 0, 0, S.w, S.h); }
    S.gray = null;
  }
  function tfmt(t) { t = Math.max(0, t || 0); return Math.floor(t / 60) + ":" + ("0" + Math.floor(t % 60)).slice(-2); }
  function updTransport() {
    if (S.kind !== "video") return;
    var d = video.duration || 0;
    if (document.activeElement !== $("seek")) $("seek").value = d ? Math.round((video.currentTime / d) * 1000) : 0;
    $("timeTxt").textContent = tfmt(video.currentTime) + " / " + tfmt(d);
    $("playBtn").textContent = video.paused ? "播放" : "暂停";
  }
  video.addEventListener("seeked", function () { drawFrame(); render(); updTransport(); if (S.track) trackStep(); });
  video.addEventListener("pause", updTransport); video.addEventListener("play", updTransport);
  (function loop() {
    if (S.kind === "video" && !video.paused && !video.ended) { drawFrame(); if (S.track) trackStep(); renderOut(); renderView(); updTransport(); }
    requestAnimationFrame(loop);
  })();
  $("playBtn").addEventListener("click", function () { if (S.recording) return; if (video.paused) { var pr = video.play(); if (pr && pr.catch) pr.catch(function () {}); } else video.pause(); });
  $("seek").addEventListener("input", function () { if (S.recording) return; var d = video.duration || 0; if (d) video.currentTime = (this.value / 1000) * d; });

  function openFile(file) {
    if (!file) return;
    if (/^video\//.test(file.type)) loadVideoFile(file);
    else if (/^image\//.test(file.type)) loadImageFile(file);
    else hint("只支持图片和视频文件。", true);
  }
  $("openBtn").addEventListener("click", function () { $("file").click(); });
  $("file").addEventListener("change", function () { openFile(this.files[0]); this.value = ""; });
  var stage = $("stage");
  stage.addEventListener("dragover", function (e) { e.preventDefault(); stage.classList.add("drop"); });
  stage.addEventListener("dragleave", function () { stage.classList.remove("drop"); });
  stage.addEventListener("drop", function (e) { e.preventDefault(); stage.classList.remove("drop"); openFile(e.dataTransfer.files[0]); });
  window.addEventListener("resize", function () { layout(); renderView(); });

  /* ------------------------------------------------------------ export */
  function saveBlob(blob, filename) {
    function viaAnchor() {
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 20000);
      return "anchor";
    }
    if (!(window.claude && window.claude.use)) return Promise.resolve(viaAnchor());
    return window.claude.use("downloads").then(function (d) {
      if (!d) return "none";
      return d.save({ filename: filename, data: blob }).then(function () { return "saved"; }, function (err) { return err && err.code === "declined" ? "declined" : "none"; });
    }, function () { return "none"; });
  }
  function exportNote(r) {
    $("exportMsg").textContent = r === "none" ? "这个页面所在的环境不允许保存文件。把页面放到自己的站点上打开就能保存。"
      : r === "declined" ? "已取消保存。" : "已交给浏览器保存。导出的是按估计倍数压回去的画面，不是原片。";
  }
  function baseName() { return (S.name || "画面").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + "-还原x" + fmt(S.p.k) + (Math.abs(S.p.kx - 1) > 0.015 ? "-横向x" + fmt(S.p.kx) : ""); }
  $("savePng").addEventListener("click", function () {
    if (!S.w) return;
    out.toBlob(function (b) { if (!b) return exportNote("none"); saveBlob(b, baseName() + ".png").then(exportNote); }, "image/png");
  });
  $("saveVid").addEventListener("click", function () {
    if (S.recording) { if (S.stopRec) S.stopRec(); return; }
    if (S.kind !== "video") return;
    if (!out.captureStream || !window.MediaRecorder) { $("exportMsg").textContent = "这个浏览器不支持录制画布。用桌面版 Chrome 或 Edge 可以。"; return; }
    var mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].filter(function (m) { return MediaRecorder.isTypeSupported(m); })[0];
    if (!mime) { $("exportMsg").textContent = "这个浏览器没有可用的录制格式。"; return; }
    var stream = out.captureStream(30);
    try { var cs = video.captureStream || video.mozCaptureStream; if (cs) cs.call(video).getAudioTracks().forEach(function (t) { stream.addTrack(t); }); } catch (e) {}
    var rec, chunks = [];
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 }); } catch (e) { $("exportMsg").textContent = "录制启动失败：" + e.message; return; }
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.onstop = function () {
      S.recording = false; S.stopRec = null; $("saveVid").textContent = "录制还原视频"; video.muted = true;
      var blob = new Blob(chunks, { type: mime.split(";")[0] });
      if (!blob.size) { $("exportMsg").textContent = "没录到内容。"; return; }
      saveBlob(blob, baseName() + (mime.indexOf("mp4") >= 0 ? ".mp4" : ".webm")).then(exportNote);
    };
    S.recording = true; $("saveVid").textContent = "停止并保存";
    $("exportMsg").textContent = "正在按原速录制，时长等于视频时长。录制时别切走这个页面。";
    var finish = function () { video.removeEventListener("ended", finish); video.pause(); if (rec.state !== "inactive") rec.stop(); };
    S.stopRec = finish; video.addEventListener("ended", finish);
    video.pause(); video.muted = false;
    var go = function () { video.removeEventListener("seeked", go); rec.start(250); var pr = video.play(); if (pr && pr.catch) pr.catch(function () { video.muted = true; video.play(); }); };
    if (video.currentTime < 0.05) go(); else { video.addEventListener("seeked", go); video.currentTime = 0; }
  });

  /* ------------------------------------------------------------ built-in example */
  function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  function demoScene() {
    var W = 540, H = 960, c = document.createElement("canvas"); c.width = W; c.height = H;
    var x = c.getContext("2d"), R = rng(7), i, j;
    // brick wall: 15 px courses (not 8/16/32: those read as a codec block grid and are ignored)
    x.fillStyle = "#8f9094"; x.fillRect(0, 0, W, 700);
    for (j = 0; j < 47; j++) for (i = -1; i < 12; i++) {
      var bx = i * 50 + (j % 2 ? 25 : 0), by = j * 15, v = 150 + Math.floor(R() * 34);
      x.fillStyle = "rgb(" + v + "," + (v - 2) + "," + (v - 8) + ")"; x.fillRect(bx + 1, by + 2, 48, Math.min(13, 700 - by - 2));
    }
    // floor
    var fg = x.createLinearGradient(0, 700, 0, H); fg.addColorStop(0, "#a99b90"); fg.addColorStop(1, "#c3b3a4");
    x.fillStyle = fg; x.fillRect(0, 700, W, H - 700);
    for (i = 0; i < 900; i++) { x.fillStyle = "rgba(60,50,45," + (0.05 + R() * 0.1) + ")"; x.fillRect(R() * W, 700 + R() * (H - 700), 1 + R() * 2, 1 + R()); }
    // window (a real non-square, above the boundary: a decoy)
    x.fillStyle = "#e9edf0"; x.fillRect(38, 150, 114, 164); x.fillStyle = "#58747c"; x.fillRect(44, 156, 102, 152);
    x.fillStyle = "#e9edf0"; x.fillRect(93, 156, 4, 152);
    // socket: 46 x 46 square
    x.fillStyle = "#6f6f72"; x.fillRect(397, 587, 52, 52); x.fillStyle = "#f4f4f1"; x.fillRect(400, 590, 46, 46);
    x.fillStyle = "#3a3a3c"; x.fillRect(413, 602, 4, 9); x.fillRect(429, 602, 4, 9); x.fillRect(421, 620, 4, 8);
    // stone ball: r = 44
    x.fillStyle = "#77706a"; x.fillRect(408, 838, 64, 30);
    var bg = x.createRadialGradient(428, 784, 6, 440, 800, 46); bg.addColorStop(0, "#dedbd6"); bg.addColorStop(1, "#8c8782");
    x.fillStyle = bg; x.beginPath(); x.arc(440, 800, 44, 0, 7); x.fill(); x.strokeStyle = "#57524e"; x.lineWidth = 2; x.stroke();
    // mannequin, stature 620: head top 280, knee 728 (0.277), crotch 602 (0.481), sole 900
    var skin = "#e3b79a", cx = 250;
    function quad(a, col) { x.fillStyle = col; x.beginPath(); x.moveTo(a[0], a[1]); for (var q = 2; q < a.length; q += 2) x.lineTo(a[q], a[q + 1]); x.closePath(); x.fill(); }
    quad([212, 600, 247, 600, 241, 884, 221, 884], skin); quad([253, 600, 288, 600, 279, 884, 259, 884], skin);
    x.fillStyle = "rgba(150,95,70,.55)"; x.beginPath(); x.ellipse(230, 728, 9, 6, 0, 0, 7); x.ellipse(270, 728, 9, 6, 0, 0, 7); x.fill();
    quad([214, 880, 248, 880, 250, 900, 210, 900], "#22222a"); quad([252, 880, 286, 880, 290, 900, 250, 900], "#22222a");
    x.strokeStyle = skin; x.lineWidth = 15; x.lineCap = "round";
    x.beginPath(); x.moveTo(205, 400); x.lineTo(190, 590); x.moveTo(295, 400); x.lineTo(310, 590); x.stroke();
    quad([203, 388, 297, 388, 288, 525, 212, 525], "#f2f1ec");
    quad([208, 520, 292, 520, 306, 642, 194, 642], "#5d6470");
    x.fillStyle = skin; x.fillRect(241, 356, 18, 34);
    x.beginPath(); x.ellipse(cx, 320, 30, 40, 0, 0, 7); x.fill();
    x.fillStyle = "#2a2422"; x.beginPath(); x.ellipse(cx, 304, 32, 26, 0, Math.PI, 0); x.fill();
    return c;
  }
  function loadDemo() {
    stopVideo();
    var o = demoScene(), y0 = 560, k = 1.45, H = Math.round(y0 + (o.height - y0) * k);
    resetFor(o.width, H, "image", "示例"); S.isDemo = true; $("demoTag").hidden = false;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(o, 0, 0, o.width, y0, 0, 0, o.width, y0);
    sctx.drawImage(o, 0, y0, o.width, o.height - y0, 0, y0, o.width, H - y0);
    // a little sensor-style noise so the example is not pixel-perfect
    var d = sctx.getImageData(0, 0, S.w, S.h), a = d.data, R = rng(11);
    for (var i = 0; i < a.length; i += 4) { var n = (R() - 0.5) * 10; a[i] += n; a[i + 1] += n; a[i + 2] += n; }
    sctx.putImageData(d, 0, 0); keepBase();
    S.p.y0 = y0; layout(); scan();
  }
  $("demoBtn").addEventListener("click", loadDemo);

  window.__huanyuan = { S: S, scan: scan, render: render, applyCrop: applyCrop, autoAll: autoAll, Pz: Pz };
  loadDemo();
})();
