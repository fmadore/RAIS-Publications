"""RAIS publications: ERef EP3 export to static, embeddable visualisations."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = REPO_ROOT / "config"
WEB_DIR = REPO_ROOT / "web"
BUILD_DIR = REPO_ROOT / "build"
DIST_DIR = REPO_ROOT / "dist"

# The ERef (University of Bayreuth repository) division of RAIS.
DIVISION_ID = "310022"
FEED_URL = f"https://eref.uni-bayreuth.de/cgi/exportview/divisions/{DIVISION_ID}/XML/{DIVISION_ID}.xml"
EPRINT_URL = "https://eref.uni-bayreuth.de/id/eprint/{id}"
