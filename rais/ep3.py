"""Fetch and parse the ERef EPrints EP3 XML export.

Parsing follows MongoDB2OmekaS ``clients/publications/ep3.py``: every abstract
language version is collected from ``abstract_original`` and
``abstract_translated``, keywords are split on commas and semicolons, people
come from ``<item><name><family>/<given></name>`` lists with their GND id.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import requests

from . import EPRINT_URL, FEED_URL

EP3_NS = {"ep": "http://eprints.org/ep2/data/2.0"}
SPACE_RE = re.compile(r"\s+")
YEAR_RE = re.compile(r"^(\d{4})")
USER_AGENT = "rais-publications/0.1 (+https://github.com/fmadore/RAIS-Publications)"


def fetch_feed(path: Path, url: str = FEED_URL, attempts: int = 4) -> Path:
    """Download the export to ``path``; a GET is idempotent, so retry it."""
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=120)
            response.raise_for_status()
            break
        except requests.RequestException:
            if attempt == attempts:
                raise
            time.sleep(3 * attempt)
    # Fail closed on an empty or truncated export rather than publishing an
    # empty site: parse before replacing the previous copy.
    root = ET.fromstring(response.content)
    if root.find(".//ep:eprint", EP3_NS) is None:
        raise ValueError(f"ERef export at {url} contains no eprints")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(response.content)
    tmp.replace(path)
    return path


def _text(node: ET.Element | None) -> str:
    if node is None or not node.text:
        return ""
    return SPACE_RE.sub(" ", node.text).strip()


def _field(ep: ET.Element, name: str) -> str:
    return _text(ep.find(f"ep:{name}", EP3_NS))


def _people(parent: ET.Element | None) -> list[dict[str, Any]]:
    """An EPrints name list. ``creators`` nest the name in ``<name>``;
    ``book_editors`` put ``<family>/<given>`` straight on the item."""
    if parent is None:
        return []
    out: list[dict[str, Any]] = []
    for item in parent.findall("ep:item", EP3_NS):
        name = item.find("ep:name", EP3_NS)
        holder = name if name is not None else item
        family = _text(holder.find("ep:family", EP3_NS))
        given = _text(holder.find("ep:given", EP3_NS))
        if not family and not given:
            continue
        orcid = ""
        for tag in ("orcid", "orcidid", "orcid_id"):
            orcid = _text(item.find(f"ep:{tag}", EP3_NS))
            if orcid:
                break
        out.append(
            {
                "family": family,
                "given": given,
                "gnd": _text(item.find("ep:gndid", EP3_NS)) or None,
                "orcid": orcid or None,
                "ubt": _text(item.find("ep:ubt", EP3_NS)).lower() == "yes",
            }
        )
    return out


def _abstracts(ep: ET.Element) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block_name in ("abstract_original", "abstract_translated"):
        block = ep.find(f"ep:{block_name}", EP3_NS)
        if block is None:
            continue
        texts = block.findall("ep:text", EP3_NS)
        langs = block.findall("ep:lang", EP3_NS)
        for index, node in enumerate(texts):
            text = _text(node)
            if not text:
                continue
            key = re.sub(r"\W+", "", text.lower())[:400]
            if key in seen:
                continue
            seen.add(key)
            lang = _text(langs[index]).lower() if index < len(langs) else ""
            out.append({"text": text, "lang": lang if lang and lang != "und" else None})
        if not texts and _text(block):
            out.append({"text": _text(block), "lang": None})
    return out


def _doi(ep: ET.Element) -> str | None:
    for name in ("publisher_doi", "related_doi"):
        doi = _field(ep, name)
        if doi.lower().startswith("doi:"):
            doi = doi[4:].strip()
        doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi, flags=re.I)
        if doi.startswith("10."):
            return doi
    return None


def parse_feed(xml: bytes | str) -> list[dict[str, Any]]:
    """Every ``<eprint>`` as a raw record dict, in feed order."""
    root = ET.fromstring(xml)
    records: list[dict[str, Any]] = []
    for ep in root.findall(".//ep:eprint", EP3_NS):
        eprint_id = _field(ep, "eprintid")
        if not eprint_id.isdigit():
            continue
        date = _field(ep, "date")
        year_match = YEAR_RE.match(date)
        keywords_raw = _field(ep, "keywords")
        records.append(
            {
                "id": int(eprint_id),
                "url": EPRINT_URL.format(id=eprint_id),
                "status": _field(ep, "eprint_status"),
                "type": _field(ep, "type").lower(),
                "title": _field(ep, "title"),
                "date": date or None,
                "year": int(year_match.group(1)) if year_match else None,
                "language": (_field(ep, "language").lower() or None),
                "creators": _people(ep.find("ep:creators", EP3_NS)),
                "keywords": [k.strip() for k in re.split(r"[;,]", keywords_raw) if k.strip()],
                "abstracts": _abstracts(ep),
                "publication": _field(ep, "publication") or None,
                "book_title": _field(ep, "book_title") or None,
                "event_title": _field(ep, "event_title") or None,
                "publisher": _field(ep, "publisher") or None,
                "doi": _doi(ep),
                "official_url": _field(ep, "official_url") or None,
                "refereed": _field(ep, "refereed").lower() == "yes",
                "succeeds": int(_field(ep, "succeeds")) if _field(ep, "succeeds").isdigit() else None,
            }
        )
    return records
