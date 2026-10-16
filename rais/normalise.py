"""Raw EP3 records to the normalised publication list the site reads.

Two pieces of reconciliation happen here, both reported in the build report
so they can be reviewed:

* keywords are free text; they are folded, plural-merged and mapped through
  ``config/keyword_aliases.json`` onto one label each;
* authors are free-text names; they are grouped by GND id first, then by
  folded full name, then an initial-only given name ("M.") joins the one
  person of that surname whose given name starts with it, when exactly one does.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import CONFIG_DIR

TYPE_LABELS = {
    "article": "Journal article",
    "book": "Book",
    "book_section": "Book chapter",
    "conference_item": "Conference contribution",
    "working_paper": "Working paper",
    "preprint": "Preprint",
    "online": "Online publication",
    "report": "Report",
    "thesis": "Thesis",
}
LANGUAGE_LABELS = {"eng": "English", "ger": "German", "fre": "French"}
PAREN_SUFFIX_RE = re.compile(r"\s*\([^()]*\)\s*$")
SEPARATOR_RE = re.compile(r"[\s\-‐‑‒–—_/]+")
DOT_RE = re.compile(r"\.")


def fold(text: str) -> str:
    """Case-, accent- and punctuation-insensitive comparison key."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return SEPARATOR_RE.sub(" ", text.casefold()).strip()


def keyword_key(text: str) -> str:
    return fold(PAREN_SUFFIX_RE.sub("", text)) or fold(text)


def _sentence_case(text: str) -> bool:
    """No capitalised word after the first, acronyms ("AI", "GPT-3") aside."""
    words = PAREN_SUFFIX_RE.sub("", text).split()[1:]
    return not any(w[:1].isupper() and not w.isupper() for w in words)


@dataclass
class KeywordMap:
    alias_to_label: dict[str, str]
    ignore: set[str]

    @classmethod
    def load(cls, path: Path = CONFIG_DIR / "keyword_aliases.json") -> KeywordMap:
        raw = json.loads(path.read_text(encoding="utf-8"))
        alias_to_label: dict[str, str] = {}
        for label, variants in raw.get("aliases", {}).items():
            for variant in [label, *variants]:
                key = keyword_key(variant)
                previous = alias_to_label.setdefault(key, label)
                if previous != label:
                    raise ValueError(f"Keyword variant {variant!r} maps to both {previous!r} and {label!r}")
        return cls(alias_to_label, {keyword_key(v) for v in raw.get("ignore", [])})


def reconcile_keywords(
    records: list[dict[str, Any]], kmap: KeywordMap
) -> tuple[dict[int, list[str]], dict[str, list[str]]]:
    """Per-record canonical keyword labels, and label → merged spellings."""
    spellings: dict[str, Counter[str]] = defaultdict(Counter)
    for record in records:
        for keyword in record["keywords"]:
            spellings[keyword_key(keyword)][keyword] += 1

    # A plural folds into its singular when the corpus uses both.
    key_target: dict[str, str] = {}
    for key in spellings:
        target = key
        if key not in kmap.alias_to_label and key.endswith("s") and key[:-1] in spellings:
            target = key[:-1]
        key_target[key] = target

    def label_for(target: str) -> str:
        if target in kmap.alias_to_label:
            return kmap.alias_to_label[target]
        variants: Counter[str] = Counter()
        for key, mapped in key_target.items():
            if mapped == target:
                variants.update(spellings[key])
        # A sentence-case spelling ("Process mining") beats a Title Case one
        # ("Process Mining") whatever their counts; spellings are only ever
        # chosen, never re-cased, so proper nouns and acronyms survive.
        best = sorted(variants.items(), key=lambda kv: (not _sentence_case(kv[0]), -kv[1], kv[0]))[0][0]
        return best[:1].upper() + best[1:]

    labels = {key: label_for(target) for key, target in key_target.items()}
    per_record: dict[int, list[str]] = {}
    merged: dict[str, set[str]] = defaultdict(set)
    for record in records:
        out: list[str] = []
        for keyword in record["keywords"]:
            key = keyword_key(keyword)
            if key in kmap.ignore or key_target[key] in kmap.ignore:
                continue
            label = labels[key]
            merged[label].add(keyword)
            if label not in out:
                out.append(label)
        per_record[record["id"]] = out
    return per_record, {label: sorted(v) for label, v in merged.items() if len(v) > 1}


@dataclass
class Person:
    key: str
    gnd: str | None = None
    ubt: bool = False
    orcid: str | None = None
    names: Counter[tuple[str, str]] = field(default_factory=Counter)

    @property
    def family_key(self) -> str:
        return fold(self.names.most_common(1)[0][0][0])

    @property
    def label(self) -> str:
        # The fullest given name wins over an initial, then the commonest form.
        family, given = sorted(
            self.names.items(), key=lambda kv: (-len(DOT_RE.sub("", kv[0][1])), -kv[1], kv[0])
        )[0][0]
        return f"{family}, {given}" if family and given else (family or given)


def _name_key(family: str, given: str) -> str:
    return fold(family) + "|" + fold(DOT_RE.sub(" ", given))


def _is_initials(given: str) -> bool:
    parts = fold(DOT_RE.sub(" ", given)).split()
    return bool(parts) and all(len(p) == 1 for p in parts)


def reconcile_authors(records: list[dict[str, Any]]) -> tuple[list[Person], dict[int, list[int]], list[str]]:
    """Group creator mentions into people; returns people, per-record person
    indices (author order kept) and a human-readable merge log."""
    people: list[Person] = []
    by_gnd: dict[str, int] = {}
    by_name: dict[str, int] = {}
    log: list[str] = []

    def person_for(creator: dict[str, Any]) -> int:
        key = _name_key(creator["family"], creator["given"])
        gnd = creator.get("gnd")
        if gnd and gnd in by_gnd:
            index = by_gnd[gnd]
        elif key in by_name and (not gnd or not people[by_name[key]].gnd):
            index = by_name[key]
            if gnd:
                people[index].gnd = gnd
                by_gnd[gnd] = index
        else:
            index = len(people)
            people.append(Person(key=gnd or key, gnd=gnd))
            if gnd:
                by_gnd[gnd] = index
        by_name.setdefault(key, index)
        return index

    mentions: dict[int, list[int]] = {}
    for record in records:
        indices: list[int] = []
        for creator in record["creators"]:
            index = person_for(creator)
            person = people[index]
            person.names[(creator["family"], creator["given"])] += 1
            person.ubt = person.ubt or creator["ubt"]
            person.orcid = person.orcid or creator.get("orcid")
            if index not in indices:
                indices.append(index)
        mentions[record["id"]] = indices

    # An initial-only given name joins the single fuller name it abbreviates.
    redirect: dict[int, int] = {}
    by_family: dict[str, list[int]] = defaultdict(list)
    for index, person in enumerate(people):
        by_family[person.family_key].append(index)

    def given_of(person: Person) -> str:
        return person.names.most_common(1)[0][0][1]

    for index, person in enumerate(people):
        (family, given), _ = person.names.most_common(1)[0]
        if person.gnd or not _is_initials(given):
            continue
        initial = fold(DOT_RE.sub(" ", given))[:1]
        candidates = [
            other
            for other in by_family[person.family_key]
            if other != index
            and not _is_initials(given_of(people[other]))
            and fold(given_of(people[other]))[:1] == initial
        ]
        if len(candidates) == 1:
            redirect[index] = candidates[0]
            log.append(f"{family}, {given} -> {people[candidates[0]].label}")

    keep = [i for i in range(len(people)) if i not in redirect]
    for index, target in redirect.items():
        people[target].names.update(people[index].names)
        people[target].ubt = people[target].ubt or people[index].ubt
    new_index = {old: new for new, old in enumerate(keep)}
    for old, target in redirect.items():
        new_index[old] = new_index[target]
    remapped: dict[int, list[int]] = {}
    for record_id, indices in mentions.items():
        out: list[int] = []
        for i in indices:
            if new_index[i] not in out:
                out.append(new_index[i])
        remapped[record_id] = out
    return [people[i] for i in keep], remapped, log


def primary_abstract(record: dict[str, Any]) -> str:
    abstracts = record["abstracts"]
    for preferred in ("eng", "en"):
        for abstract in abstracts:
            if abstract["lang"] == preferred:
                return abstract["text"]
    return abstracts[0]["text"] if abstracts else ""


def venue(record: dict[str, Any]) -> str | None:
    return record["publication"] or record["book_title"] or record["event_title"] or record["publisher"]


def normalise(records: list[dict[str, Any]], kmap: KeywordMap | None = None) -> dict[str, Any]:
    """The site's publication payload plus a reconciliation report."""
    kmap = kmap or KeywordMap.load()
    live = [r for r in records if r["status"] in ("", "archive") and r["title"]]
    # EPrints keeps a superseded version as its own record; show the newest only.
    superseded = {r["succeeds"] for r in live if r["succeeds"]}
    dropped = [r["id"] for r in live if r["id"] in superseded]
    live = [r for r in live if r["id"] not in superseded]
    live.sort(key=lambda r: (-(r["year"] or 0), r["date"] or "", r["id"]))

    keywords_by_record, merged_keywords = reconcile_keywords(live, kmap)
    people, authors_by_record, author_merges = reconcile_authors(live)
    keyword_counts = Counter(k for r in live for k in keywords_by_record[r["id"]])
    keyword_labels = sorted(keyword_counts, key=lambda k: (-keyword_counts[k], fold(k)))
    keyword_index = {label: i for i, label in enumerate(keyword_labels)}
    person_counts = Counter(i for r in live for i in authors_by_record[r["id"]])

    publications = []
    for record in live:
        publications.append(
            {
                "id": record["id"],
                "url": record["url"],
                "title": record["title"],
                "year": record["year"],
                "date": record["date"],
                "type": record["type"],
                "language": record["language"],
                "authors": authors_by_record[record["id"]],
                "keywords": [keyword_index[k] for k in keywords_by_record[record["id"]]],
                "abstract": primary_abstract(record),
                "venue": venue(record),
                "doi": record["doi"],
                "refereed": record["refereed"],
            }
        )
    types = sorted(
        {p["type"] for p in publications},
        key=lambda t: (list(TYPE_LABELS).index(t) if t in TYPE_LABELS else 99, t),
    )
    return {
        "publications": publications,
        "authors": [
            {"label": p.label, "ubt": p.ubt, "gnd": p.gnd, "orcid": p.orcid, "count": person_counts[i]}
            for i, p in enumerate(people)
        ],
        # Variants let a URL preset or a typed filter use any merged spelling.
        "keywords": [
            {
                "label": k,
                "count": keyword_counts[k],
                **({"variants": merged_keywords[k]} if k in merged_keywords else {}),
            }
            for k in keyword_labels
        ],
        "types": {t: TYPE_LABELS.get(t, t.replace("_", " ").capitalize()) for t in types},
        "languages": {
            code: LANGUAGE_LABELS.get(code, code)
            for code in sorted({p["language"] for p in publications if p["language"]})
        },
        "report": {
            "records": len(records),
            "published": len(publications),
            "supersededDropped": dropped,
            "withAbstract": sum(bool(p["abstract"]) for p in publications),
            "withKeywords": sum(bool(p["keywords"]) for p in publications),
            "rawKeywordSpellings": len({k for r in live for k in r["keywords"]}),
            "keywords": len(keyword_labels),
            "mergedKeywords": merged_keywords,
            "authors": len(people),
            "authorMerges": author_merges,
        },
    }
