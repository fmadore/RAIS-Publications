"""Vendor the two browser libraries into web/vendor/ from their npm tarballs.

Self-hosted rather than CDN-loaded, so an embedded page makes no third-party
request. Each tarball is checked against the sha512 integrity the npm
registry publishes before a byte of it is read; every file written is
reported with its SHA-256 for THIRD_PARTY_NOTICES.

MapLibre 6 ships ES modules only, as ``.mjs``. Some static servers do not
type ``.mjs`` as JavaScript and browsers refuse such a module, so the two
self-contained builds are copied under ``.js`` names, byte for byte (the
same rename DREVisualizations' scripts/vendor-maplibre.mjs does).

Usage: python scripts/vendor_libs.py
"""

from __future__ import annotations

import base64
import hashlib
import io
import re
import sys
import tarfile
from pathlib import Path

import requests

VENDOR = Path(__file__).resolve().parents[1] / "web" / "vendor"
PACKAGES = {
    "echarts": (
        "6.1.0",
        {
            "package/dist/echarts.min.js": "echarts.min.js",
            "package/LICENSE": "echarts.LICENSE.txt",
            "package/NOTICE": "echarts.NOTICE.txt",
        },
    ),
    "maplibre-gl": (
        "6.14.0",
        {
            "package/dist/maplibre-gl.mjs": "maplibre-gl.js",
            "package/dist/maplibre-gl-worker.mjs": "maplibre-gl-worker.js",
            "package/dist/maplibre-gl.css": "maplibre-gl.css",
            "package/LICENSE.txt": "maplibre-gl.LICENSE.txt",
        },
    ),
}
RELATIVE_IMPORT = re.compile(rb"""(?:\bfrom\s*|\bimport\s*\(\s*)["'`]\.\.?/""")


def main() -> int:
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name, (version, files) in PACKAGES.items():
        meta = requests.get(f"https://registry.npmjs.org/{name}/{version}", timeout=60)
        meta.raise_for_status()
        dist = meta.json()["dist"]
        archive = requests.get(dist["tarball"], timeout=120)
        archive.raise_for_status()
        algorithm, expected = dist["integrity"].split("-", 1)
        if algorithm != "sha512":
            raise SystemExit(f"{name}: unexpected integrity algorithm {dist['integrity']}")
        actual = base64.b64encode(hashlib.sha512(archive.content).digest()).decode()
        if actual != expected:
            raise SystemExit(f"{name}@{version}: tarball does not match the registry integrity hash")
        with tarfile.open(fileobj=io.BytesIO(archive.content), mode="r:gz") as tar:
            for member, target in files.items():
                extracted = tar.extractfile(member)
                if extracted is None:
                    raise SystemExit(f"{name}@{version}: {member} missing from the tarball")
                content = extracted.read()
                if target.endswith(".js") and name == "maplibre-gl" and RELATIVE_IMPORT.search(content):
                    raise SystemExit(f"{name}@{version}: {member} imports a sibling chunk; cannot rename it")
                (VENDOR / target).write_bytes(content)
                print(f"{name}@{version}  {target:28} {hashlib.sha256(content).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
