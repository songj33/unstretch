"""Assemble src/ into a single self-contained index.html (no dependencies)."""
import os
d = os.path.dirname(os.path.abspath(__file__))
r = lambda n: open(os.path.join(d, "src", n), encoding="utf-8").read()
html = (r("template.html")
        .replace("/*__STYLE__*/", r("style.css"))
        .replace("/*__CORE__*/", r("core.js"))
        .replace("/*__APP__*/", r("app.js")))
open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(html)
print("built index.html,", len(html), "bytes")
