"""Body-proportion priors from ANSUR II (2012 US Army anthropometric survey, public data).

Download "ANSUR II FEMALE Public.csv" and "ANSUR II MALE Public.csv", then:
    python3 tools/ansur_ratios.py /path/to/folder

Prints the percentiles used in src/core.js (AF.PRIORS).
"""
import csv, os, sys
import numpy as np

folder = sys.argv[1] if len(sys.argv) > 1 else "."
ratios = {"knee (midpatella) / stature": [], "crotch / stature": []}
for name in ("ANSUR II FEMALE Public.csv", "ANSUR II MALE Public.csv"):
    with open(os.path.join(folder, name), encoding="latin-1", newline="") as f:
        rows = list(csv.DictReader(f))
    col = lambda k: np.array([float(r[k]) for r in rows])
    stature = col("stature")
    ratios["knee (midpatella) / stature"].append(col("kneeheightmidpatella") / stature)
    ratios["crotch / stature"].append(col("crotchheight") / stature)
    print(f"{name}: n = {len(rows)}")
for label, parts in ratios.items():
    r = np.concatenate(parts)
    p5, p50, p95 = np.percentile(r, [5, 50, 95])
    print(f"{label}: p5 {p5:.3f}  p50 {p50:.3f}  p95 {p95:.3f}")
