#!/usr/bin/env python3
# 还原尺 unstretch — Copyright (C) 2026 songj33
# SPDX-License-Identifier: GPL-3.0-only
"""Make stretched images with known answers.

Takes your own photos (any folder) and/or procedurally drawn scenes, applies the row remap a
leg-lengthening filter applies (rows below y0 stretched by k), then degrades the result the way a
video platform would (downscale + JPEG). Writes, per sample:

    NNNN.jpg   the stretched, compressed picture
    NNNN.pgm   the same picture as 8-bit grey, for tools/evaluate.js (no image library needed)
and one labels.json with the truth: y0, y1, k in the pixels of the written picture.

About a quarter of the samples are controls (k = 1): a detector must stay silent on those.

    python3 tools/make_dataset.py --src ~/Pictures/mine --procedural 100 --n 300 --out data/gen

Needs: numpy, opencv-python. Only use pictures you have the right to use; data/ is git-ignored.
"""
import argparse, json, os, sys
import numpy as np
import cv2

EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
INTERP = {"linear": cv2.INTER_LINEAR, "cubic": cv2.INTER_CUBIC, "lanczos": cv2.INTER_LANCZOS4}


def stretch(img, y0, y1, k, interp):
    """Rows [y0, y1) stretched vertically by k; everything else untouched."""
    top, band, rest = img[:y0], img[y0:y1], img[y1:]
    new_h = max(1, int(round((y1 - y0) * k)))
    band = cv2.resize(band, (img.shape[1], new_h), interpolation=INTERP[interp])
    return np.vstack([top, band, rest]), y0 + new_h


def procedural(rng, w=540, h=960):
    """A wall (bricks, tiles or plain), a floor, and maybe a socket and a ball. No people."""
    img = np.zeros((h, w, 3), np.float32)
    floor_y = int(h * rng.uniform(0.62, 0.8))
    kind = rng.choice(["brick", "tile", "plain"], p=[0.45, 0.3, 0.25])
    base = rng.uniform(110, 200, 3)
    info = {"wall": str(kind)}
    if kind == "plain":
        img[:floor_y] = base
    else:
        ph = int(rng.integers(10, 34)) if kind == "brick" else int(rng.integers(28, 70))
        pw = int(ph * rng.uniform(2.2, 3.4)) if kind == "brick" else ph
        gap = max(1, int(round(ph * rng.uniform(0.06, 0.14))))
        mortar = base * rng.uniform(0.55, 0.8)
        img[:floor_y] = mortar
        for j in range(floor_y // ph + 1):
            off = (pw // 2) if (kind == "brick" and j % 2) else 0
            for i in range(-1, w // pw + 2):
                x0, y0 = i * pw + off, j * ph
                shade = base + rng.normal(0, 9, 3)
                cv2.rectangle(img, (x0 + gap, y0 + gap), (x0 + pw - 1, min(floor_y, y0 + ph) - 1), shade.tolist(), -1)
        info["period"] = ph
    fl = rng.uniform(120, 190, 3)
    grad = np.linspace(0.85, 1.05, h - floor_y)[:, None, None]
    img[floor_y:] = fl * grad
    if rng.random() < 0.6:                       # socket: a true square
        s = int(rng.integers(34, 60)); x = int(rng.integers(20, w - s - 20)); y = int(rng.integers(int(h * 0.45), max(int(h * 0.45) + 1, floor_y - s - 10)))
        cv2.rectangle(img, (x - 3, y - 3), (x + s + 3, y + s + 3), (90, 90, 92), -1)
        cv2.rectangle(img, (x, y), (x + s, y + s), (242, 242, 238), -1)
        info["socket"] = [x, y, s]
    if rng.random() < 0.5:                       # ball: a true circle
        r = int(rng.integers(26, 52)); x = int(rng.integers(r + 10, w - r - 10)); y = int(rng.integers(floor_y + r // 2, h - r - 4))
        cv2.circle(img, (x, y), r, rng.uniform(120, 210, 3).tolist(), -1, cv2.LINE_AA)
        cv2.circle(img, (x, y), r, (70, 66, 62), 2, cv2.LINE_AA)
        info["ball"] = [x, y, r]
    img += rng.normal(0, rng.uniform(1.5, 5), img.shape)
    return np.clip(img, 0, 255).astype(np.uint8), info


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", help="folder of your own images (searched recursively)")
    ap.add_argument("--procedural", type=int, default=0, help="how many of the samples to draw procedurally")
    ap.add_argument("--n", type=int, default=200, help="total number of samples")
    ap.add_argument("--out", default="data/gen")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--controls", type=float, default=0.25, help="share of unstretched samples")
    ap.add_argument("--hsqueeze", type=float, default=0.0, help="share of samples that are also squeezed horizontally (whole frame, to 85-97%% width)")
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    files = []
    if a.src:
        for root, _, names in os.walk(os.path.expanduser(a.src)):
            files += [os.path.join(root, n) for n in sorted(names) if n.lower().endswith(EXT)]
    if not files and a.procedural <= 0:
        sys.exit("nothing to do: give --src with images and/or --procedural N")
    os.makedirs(a.out, exist_ok=True)
    labels = []
    for idx in range(a.n):
        use_proc = idx < a.procedural or not files
        if use_proc:
            img, info = procedural(rng)
            src = {"kind": "procedural", **info}
        else:
            path = files[int(rng.integers(len(files)))]
            img = cv2.imread(path, cv2.IMREAD_COLOR)
            if img is None:
                continue
            if max(img.shape[:2]) > 1600:        # keep it phone-sized
                f = 1600 / max(img.shape[:2]); img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
            src = {"kind": "image", "file": os.path.relpath(path, os.path.expanduser(a.src))}
        h = img.shape[0]
        control = rng.random() < a.controls
        k = 1.0 if control else float(rng.uniform(1.1, 1.8))
        y0 = int(h * rng.uniform(0.35, 0.65))
        y1 = h if rng.random() < 0.8 else int(h * rng.uniform(0.82, 0.95))
        interp = str(rng.choice(list(INTERP)))
        out, y1s = (img, y1) if control else stretch(img, y0, y1, k, interp)
        keep_size = rng.random() < 0.5           # most apps keep the frame size and lose the bottom
        if keep_size:
            out = out[:h]; y1s = min(y1s, h)
        kx = 1.0
        if rng.random() < a.hsqueeze:            # whole-frame "slimming": everything gets narrower
            kx = float(rng.uniform(0.85, 0.97))
            out = cv2.resize(out, (max(8, int(round(out.shape[1] * kx))), out.shape[0]), interpolation=cv2.INTER_AREA)
        scale = float(rng.uniform(0.55, 1.0))    # platform downscale
        if scale < 0.98:
            out = cv2.resize(out, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        quality = int(rng.integers(35, 91))
        name = "%04d" % idx
        jpg = os.path.join(a.out, name + ".jpg")
        cv2.imwrite(jpg, out, [cv2.IMWRITE_JPEG_QUALITY, quality])
        cv2.imwrite(os.path.join(a.out, name + ".pgm"), cv2.imread(jpg, cv2.IMREAD_GRAYSCALE))
        labels.append({"id": name, "w": out.shape[1], "h": out.shape[0], "k": round(k, 4), "kx": round(kx, 4), "control": bool(control),
                       "y0": round(y0 * scale, 1), "y1": round(y1s * scale, 1), "interp": interp, "scale": round(scale, 3),
                       "jpeg_quality": quality, "kept_frame_size": bool(keep_size), "source": src})
    json.dump(labels, open(os.path.join(a.out, "labels.json"), "w"), indent=1, ensure_ascii=False)
    n_c = sum(l["control"] for l in labels)
    print(f"wrote {len(labels)} samples to {a.out} ({len(labels) - n_c} stretched, {n_c} controls)")


if __name__ == "__main__":
    main()
