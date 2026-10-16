"""Command line: ``python -m rais build``.

Steps: fetch the ERef export, normalise it, embed and project it, lay out
the two networks, and write the static site to ``dist/``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import BUILD_DIR, DIST_DIR, FEED_URL, WEB_DIR
from .ep3 import fetch_feed, parse_feed
from .networks import coauthor_network, keyword_network
from .normalise import normalise

RAW_PATH = BUILD_DIR / "raw" / "eref-310022.xml"
CACHE_PATH = BUILD_DIR / "cache" / "embeddings.json"


def write_json(path: Path, payload: Any, pretty: bool = False) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(
        payload, ensure_ascii=False, indent=2 if pretty else None, separators=None if pretty else (",", ":")
    )
    path.write_text(text, encoding="utf-8")
    return path.stat().st_size


def build(args: argparse.Namespace) -> int:
    started = time.time()
    out: Path = args.out
    raw_path: Path = args.input or RAW_PATH
    if args.input is None and not args.offline:
        print(f"Fetching {FEED_URL} ...")
        fetch_feed(raw_path)
    if not raw_path.is_file():
        print(f"No ERef export at {raw_path}; run without --offline first.", file=sys.stderr)
        return 1

    records = parse_feed(raw_path.read_bytes())
    data = normalise(records)
    report = data.pop("report")
    print(
        f"Normalised {report['published']} publications: {report['keywords']} keywords "
        f"(from {report['rawKeywordSpellings']} spellings), {report['authors']} authors."
    )

    semantic = None
    if args.skip_embeddings:
        print("Skipping the semantic map (--skip-embeddings).")
    else:
        from .embeddings import build_semantic

        print("Building the semantic map (EmbeddingGemma 2, CPU float32) ...")
        semantic = build_semantic(data, CACHE_PATH)
        clusters = semantic["clusters"]
        for publication, point in zip(data["publications"], semantic["points"], strict=True):
            publication["cluster"] = point[2]
        data["clusters"] = clusters
        report["semantic"] = semantic["stats"] | {"clusters": [c["label"] for c in clusters]}
        print(f"  {semantic['stats']['embedded']} embedded, {semantic['stats']['reused']} from cache.")

    print("Laying out the keyword and co-author networks ...")
    keywords = keyword_network(data)
    coauthors = coauthor_network(data)
    report["networks"] = {
        name: {"nodes": len(net["nodes"]), "edges": len(net["edges"]), **net["meta"]}
        for name, net in (("keywords", keywords), ("coauthors", coauthors))
    }

    generated = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    data = {"generatedAt": generated, "source": FEED_URL, **data}
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(WEB_DIR, out)
    sizes = {
        "publications": write_json(out / "data" / "publications.json", data),
        "keywordNetwork": write_json(out / "data" / "keyword-network.json", keywords),
        "coauthorNetwork": write_json(out / "data" / "coauthor-network.json", coauthors),
    }
    if semantic is not None:
        semantic.pop("stats")
        sizes["semanticMap"] = write_json(
            out / "data" / "semantic-map.json", {"generatedAt": generated, **semantic}
        )
    report = {"generatedAt": generated, "source": FEED_URL, **report, "bytes": sizes}
    write_json(out / "data" / "report.json", report, pretty=True)
    print(f"Wrote {out} in {time.time() - started:.0f} s.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rais", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="Fetch, process and write the static site.")
    b.add_argument("--out", type=Path, default=DIST_DIR, help="Output directory (default: dist/).")
    b.add_argument("--input", type=Path, help="Read this EP3 XML file instead of fetching the feed.")
    b.add_argument("--offline", action="store_true", help="Reuse the last downloaded feed in build/raw/.")
    b.add_argument(
        "--skip-embeddings",
        action="store_true",
        help="Build without the model stack (no semantic map, no cluster facet).",
    )
    args = parser.parse_args(argv)
    if args.command == "build":
        return build(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
