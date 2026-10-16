from __future__ import annotations

import json

import numpy as np
import pytest

from rais import embeddings
from rais.__main__ import main
from rais.ep3 import parse_feed
from rais.networks import build_network, coauthor_network, keyword_network
from rais.normalise import KeywordMap, keyword_key, normalise


def test_parse_feed(feed_xml):
    records = parse_feed(feed_xml)
    assert [r["id"] for r in records] == [1, 2, 3]
    first = records[0]
    assert first["title"] == "Explaining models to people"
    assert first["year"] == 2024
    assert first["keywords"] == ["XAI", "Machine Learning", "knowledge graphs"]
    assert first["doi"] == "10.1234/abc"
    assert first["creators"][0] == {
        "family": "Kühl",
        "given": "Niklas",
        "gnd": "111",
        "orcid": None,
        "ubt": True,
    }
    assert first["abstracts"][0]["lang"] == "eng"
    assert records[2]["succeeds"] == 99


def test_keyword_reconciliation(feed_xml):
    data = normalise(parse_feed(feed_xml))
    labels = [k["label"] for k in data["keywords"]]
    # XAI spellings collapse onto the alias label; the plural joins its
    # singular; "workshop" is in the ignore list.
    assert "Explainable AI (XAI)" in labels
    assert sum("graph" in label.lower() for label in labels) == 1
    assert not any(label.lower() == "workshop" for label in labels)
    xai = labels.index("Explainable AI (XAI)")
    assert data["keywords"][xai]["count"] == 2


def test_alias_file_is_consistent():
    kmap = KeywordMap.load()
    assert kmap.alias_to_label[keyword_key("explainable artificial intelligence")] == "Explainable AI (XAI)"
    assert kmap.alias_to_label[keyword_key("Large Language Models (LLMs)")] == "Large language models (LLMs)"


def test_author_reconciliation(feed_xml):
    data = normalise(parse_feed(feed_xml))
    labels = sorted(a["label"] for a in data["authors"])
    # Same GND id despite the spelling; "Doe, J." joins the only Jane Doe.
    assert labels == ["Doe, Jane", "Kühl, Niklas", "Roe, Richard"]
    kuehl = next(a for a in data["authors"] if a["label"] == "Kühl, Niklas")
    assert kuehl["count"] == 2 and kuehl["ubt"] and kuehl["gnd"] == "111"


def test_cards_and_low_signal(feed_xml):
    data = normalise(parse_feed(feed_xml))
    labels = [k["label"] for k in data["keywords"]]
    cards = {
        p["id"]: embeddings.build_card(p, data["types"][p["type"]], labels) for p in data["publications"]
    }
    assert cards[1].text.startswith("Title: Explaining models to people\nType: Journal article\nKeywords: ")
    assert "\nAbstract: An abstract" in cards[1].text
    assert cards[3].low_signal and not cards[1].low_signal


class FakeEmbedder:
    calls = 0

    def __call__(self, texts):
        FakeEmbedder.calls += len(texts)
        rows = []
        for text in texts:
            rng = np.random.default_rng(abs(hash(text)) % 2**32)
            v = rng.normal(size=embeddings.OUTPUT_DIMS).astype(np.float32)
            rows.append(v / np.linalg.norm(v))
        return np.asarray(rows)


def test_embedding_cache_reuses_vectors(feed_xml, tmp_path):
    data = normalise(parse_feed(feed_xml))
    labels = [k["label"] for k in data["keywords"]]
    cards = [embeddings.build_card(p, data["types"][p["type"]], labels) for p in data["publications"]]
    cache = tmp_path / "cache.json"
    FakeEmbedder.calls = 0
    matrix, stats = embeddings.embed_cards(cards, cache, FakeEmbedder)
    assert matrix.shape == (3, embeddings.OUTPUT_DIMS) and stats["embedded"] == 3
    assert np.allclose(np.linalg.norm(matrix, axis=1), 1, atol=1e-5)

    def no_model():
        raise AssertionError("the model must not load when every card is cached")

    _, stats = embeddings.embed_cards(cards, cache, no_model)
    assert stats == {"embedded": 0, "reused": 3}
    # A cache built under another contract is not reused.
    payload = json.loads(cache.read_text(encoding="utf-8"))
    payload["contract"]["modelRevision"] = "other"
    cache.write_text(json.dumps(payload), encoding="utf-8")
    assert embeddings.load_cache(cache) == {}


def test_similar_skips_low_signal_and_identical():
    def card(i, h, low=False):
        return embeddings.Card(id=i, text="", content_hash=h, low_signal=low, truncated=False)

    cards = [card(1, "a"), card(2, "a"), card(3, "b"), card(4, "c", low=True)]
    matrix = np.eye(4, dtype=np.float32)
    matrix[1] = matrix[0]
    matrix[2] = (matrix[0] + matrix[2]) / np.sqrt(2)
    matrix[3] = matrix[0]
    result = embeddings.similar(cards, matrix)
    assert "4" not in result
    assert [n[0] for n in result["1"]] == [3]


def test_projection_and_clusters():
    pytest.importorskip("umap")
    rng = np.random.default_rng(0)
    matrix = rng.normal(size=(40, 16)).astype(np.float32)
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    coords, clusters = embeddings.project_and_cluster(matrix)
    assert coords.shape == (40, 2) and len(set(clusters.tolist())) == embeddings.cluster_count(40)


def test_networks_carry_publications(feed_xml):
    data = normalise(parse_feed(feed_xml))
    net = coauthor_network(data)
    assert net["types"] == ["University of Bayreuth", "External"]
    labels = [n[0] for n in net["nodes"]]
    edge = next(e for e in net["edges"] if {labels[e[0]], labels[e[1]]} == {"Doe, Jane", "Roe, Richard"})
    # Joint publications 2 (conference) and 3 (preprint), by publication index.
    assert len(edge[2]) == 2
    assert all(-60 <= n[3] <= 60 and -40 <= n[4] <= 40 for n in net["nodes"])
    assert keyword_network(data)["nodes"]


def test_build_network_ranks_hubs_first():
    net = build_network([[0, 1], [0, 2], [0, 3], [4]], ["hub", "a", "b", "c", "alone"], [0] * 5, ["Keyword"])
    assert net["nodes"][0][0] == "hub" and net["nodes"][0][5] == 0
    assert net["meta"]["isolatedOmitted"] == 1


def test_build_without_model(feed_xml, tmp_path):
    source = tmp_path / "feed.xml"
    source.write_text(feed_xml, encoding="utf-8")
    out = tmp_path / "dist"
    assert main(["build", "--input", str(source), "--skip-embeddings", "--out", str(out)]) == 0
    for page in (
        "index.html",
        "semantic-map.html",
        "keyword-network.html",
        "coauthor-network.html",
        "dashboard.html",
    ):
        assert (out / page).is_file()
    payload = json.loads((out / "data" / "publications.json").read_text(encoding="utf-8"))
    assert len(payload["publications"]) == 3
    assert not (out / "data" / "semantic-map.json").exists()
