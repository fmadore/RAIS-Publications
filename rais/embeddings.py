"""Semantic map: cards, EmbeddingGemma 2 vectors, UMAP, clusters, neighbours.

The model contract is the one DREVisualizations publishes for AMIRA
(``tools/embeddings/build_embeddings.py``, ``docs/SEMANTIC_EMBEDDINGS.md``):
the same open model at the same pinned revision, CPU float32 inference, the
sentence-similarity task prefix and unit-L2 vectors. A card is title, type,
keywords and abstract under the same 900-word budget, and a record is
low-signal under the same 100-character rule. Vectors are cached by card
hash, so a scheduled rebuild only embeds new or edited records.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MODEL = "google/embeddinggemma-2"
# Pinned Hub commit: a new revision is a new vector space, like a new model.
MODEL_REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
OUTPUT_DIMS = 768
TASK_PREFIX = "task: sentence similarity | query: "
# float16 overflows this model and yields NaN or silently degraded vectors.
INFERENCE_DTYPE = "float32"
BATCH_SIZE = 16
CARD_MAX_WORDS = 900
LOW_SIGNAL_THRESHOLD = 100
SIMILAR_TOP_K = 8
UMAP_NEIGHBORS = 15
UMAP_MIN_DIST = 0.1
SEED = 42
MAX_CLUSTERS = 8
SCHEMA_VERSION = 1

Embedder = Callable[[Sequence[str]], Any]

TOKEN_RE = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-]{2,}")
STOPWORDS = frozenset(
    """a an and are as at be between by can de der die das for from how in into is its of on or our
    the their this through to towards toward using use via what when which with within without und
    zur zum von mit für über eine einer ein study studies approach approaches case analysis based
    new paper research towards toward perspective perspectives""".split()
)


@dataclass
class Card:
    id: int
    text: str
    content_hash: str
    low_signal: bool
    truncated: bool


def build_card(publication: dict[str, Any], type_label: str, keyword_labels: list[str]) -> Card:
    keywords = [keyword_labels[i] for i in publication["keywords"]]
    parts = [f"Title: {publication['title']}", f"Type: {type_label}"]
    if keywords:
        parts.append("Keywords: " + "; ".join(keywords))
    if publication["abstract"]:
        parts.append(f"Abstract: {publication['abstract']}")
    text = "\n".join(parts)
    words = text.split()
    truncated = len(words) > CARD_MAX_WORDS
    if truncated:
        text = " ".join(words[:CARD_MAX_WORDS])
    signal = len(" ".join(filter(None, [publication["title"], publication["abstract"], *keywords])))
    return Card(
        id=publication["id"],
        text=text,
        content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        low_signal=signal < LOW_SIGNAL_THRESHOLD,
        truncated=truncated,
    )


class GemmaEmbedder:
    """EmbeddingGemma 2 text encoder on CPU; vision and audio stay unloaded."""

    def __init__(self) -> None:
        import torch
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(
            MODEL,
            revision=MODEL_REVISION,
            device="cpu",
            config_kwargs={"vision_config": None, "audio_config": None},
            model_kwargs={"dtype": getattr(torch, INFERENCE_DTYPE)},
        )
        # The checkpoint declares no limit; cards stay far below the 8K window.
        self._model.max_seq_length = 8192

    def __call__(self, texts: Sequence[str]):
        import numpy as np

        vectors = self._model.encode(
            list(texts),
            prompt=TASK_PREFIX,
            batch_size=BATCH_SIZE,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        if vectors.shape != (len(texts), OUTPUT_DIMS):
            raise RuntimeError(f"EmbeddingGemma returned shape {vectors.shape}")
        if not np.isfinite(vectors).all():
            raise RuntimeError("EmbeddingGemma returned non-finite values; check the inference dtype")
        return vectors.astype(np.float32)


def _contract() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "model": MODEL,
        "modelRevision": MODEL_REVISION,
        "dimensions": OUTPUT_DIMS,
        "taskPrefix": TASK_PREFIX,
        "inferenceDtype": INFERENCE_DTYPE,
        "normalization": "l2",
    }


def load_cache(path: Path) -> dict[str, list[float]]:
    """Vectors by card hash, or nothing when the cache was built under
    another model contract (a different space is not reusable)."""
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(cache, dict) or cache.get("contract") != _contract():
        return {}
    vectors = cache.get("vectors")
    return vectors if isinstance(vectors, dict) else {}


def save_cache(path: Path, vectors: dict[str, list[float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"contract": _contract(), "vectors": vectors}), encoding="utf-8")
    tmp.replace(path)


def embed_cards(
    cards: Sequence[Card], cache_path: Path, embedder_factory: Callable[[], Embedder], force: bool = False
):
    """Return the L2-normalised matrix (row order = cards) and cache stats.
    The model is only loaded when some card is not in the cache."""
    import numpy as np

    cached = {} if force else load_cache(cache_path)
    live = {card.content_hash for card in cards}
    pending: dict[str, str] = {}
    for card in cards:
        if card.content_hash not in cached:
            pending.setdefault(card.content_hash, card.text)
    if pending:
        embed = embedder_factory()
        queue = list(pending.items())
        for offset in range(0, len(queue), BATCH_SIZE):
            batch = queue[offset : offset + BATCH_SIZE]
            vectors = np.asarray(embed([text for _, text in batch]), dtype=np.float32)
            if vectors.shape != (len(batch), OUTPUT_DIMS) or not np.isfinite(vectors).all():
                raise RuntimeError(f"Embedder returned an invalid batch of shape {vectors.shape}")
            for (content_hash, _), vector in zip(batch, vectors, strict=True):
                cached[content_hash] = [round(float(v), 7) for v in vector]
            print(f"  embedded {min(offset + len(batch), len(queue))}/{len(queue)}")
            # Keep finished batches, so an interrupted run resumes.
            save_cache(cache_path, {h: v for h, v in cached.items() if h in live})
    save_cache(cache_path, {h: v for h, v in cached.items() if h in live})

    matrix = np.asarray([cached[card.content_hash] for card in cards], dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise ValueError("Embedding matrix contains a zero vector")
    stats = {
        "embedded": len(pending),
        "reused": len(cards) - sum(1 for c in cards if c.content_hash in pending),
    }
    return matrix / norms, stats


def cluster_count(count: int) -> int:
    # DREVisualizations' sqrt(n/2) rule, capped at the eight categorical
    # colours the pages have: a ninth group would need a cycled hue.
    return min(count, max(2, min(MAX_CLUSTERS, round(math.sqrt(count / 2)))))


def project_and_cluster(matrix):
    import numpy as np
    import umap
    from sklearn.cluster import KMeans

    count = matrix.shape[0]
    if count < 3:
        coords = np.asarray([[float(i), 0.0] for i in range(count)], dtype=np.float32)
        return coords, np.arange(count, dtype=np.int32)
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=min(UMAP_NEIGHBORS, count - 1),
        min_dist=UMAP_MIN_DIST,
        metric="cosine",
        random_state=SEED,
        n_jobs=1,
    )
    coords = reducer.fit_transform(matrix)
    clusters = KMeans(n_clusters=cluster_count(count), random_state=SEED, n_init="auto").fit_predict(matrix)
    return coords, clusters


def similar(cards: Sequence[Card], matrix, top_k: int = SIMILAR_TOP_K) -> dict[str, list[list[float]]]:
    """Top-k cosine neighbours per recommendable card, as ``[id, score]``.
    Low-signal cards are neither sources nor neighbours; an identical card
    is never listed as its source's neighbour."""
    import numpy as np

    eligible = [i for i, card in enumerate(cards) if not card.low_signal]
    out: dict[str, list[list[float]]] = {}
    if len(eligible) < 2:
        return out
    sub = matrix[eligible]
    scores = sub @ sub.T
    np.fill_diagonal(scores, -np.inf)
    for row, source in enumerate(eligible):
        order = np.argsort(-scores[row])
        neighbours: list[list[float]] = []
        for column in order:
            target = eligible[int(column)]
            score = float(scores[row, column])
            if not math.isfinite(score) or score <= 0:
                break
            if cards[target].content_hash == cards[source].content_hash:
                continue
            neighbours.append([cards[target].id, round(score, 4)])
            if len(neighbours) == top_k:
                break
        out[str(cards[source].id)] = neighbours
    return out


def cluster_labels(
    publications: Sequence[dict[str, Any]], clusters: Sequence[int], keyword_labels: list[str]
) -> list[dict[str, Any]]:
    """Name each cluster by its most distinctive keywords (class-based
    TF-IDF), falling back to title words for clusters without keywords."""
    ids = sorted(set(int(c) for c in clusters))

    def distinctive(terms_per_pub: list[list[str]], limit: int) -> dict[int, list[str]]:
        per_cluster: dict[int, Counter[str]] = {c: Counter() for c in ids}
        for terms, cluster in zip(terms_per_pub, clusters, strict=True):
            per_cluster[int(cluster)].update(set(terms))
        spread = Counter(term for counts in per_cluster.values() for term in counts)
        out: dict[int, list[str]] = {}
        for cluster, counts in per_cluster.items():
            ranked = sorted(
                (term for term, n in counts.items() if n >= 2),
                key=lambda term: (-counts[term] * math.log(1 + len(ids) / spread[term]), term),
            )
            out[cluster] = ranked[:limit]
        return out

    by_keyword = distinctive([[keyword_labels[i] for i in p["keywords"]] for p in publications], 3)
    by_title = distinctive(
        [
            [w.lower() for w in TOKEN_RE.findall(p["title"]) if w.lower() not in STOPWORDS]
            for p in publications
        ],
        3,
    )
    sizes = Counter(int(c) for c in clusters)
    labels = []
    for cluster in ids:
        terms = list(by_keyword[cluster])
        # Few shared keywords: top up with distinctive title words.
        for word in by_title[cluster]:
            if len(terms) >= 3:
                break
            if not any(word in term.casefold() for term in terms):
                terms.append(word.capitalize())
        labels.append(
            {
                "id": cluster,
                "label": " · ".join(terms[:3]) if terms else f"Group {cluster + 1}",
                "size": sizes[cluster],
            }
        )
    return labels


def build_semantic(
    data: dict[str, Any], cache_path: Path, embedder_factory: Callable[[], Embedder] = GemmaEmbedder
) -> dict[str, Any]:
    """Map payload for the site, and the cluster of each publication (the
    other pages facet on it)."""
    publications = data["publications"]
    keyword_labels = [k["label"] for k in data["keywords"]]
    cards = [build_card(p, data["types"][p["type"]], keyword_labels) for p in publications]
    matrix, cache_stats = embed_cards(cards, cache_path, embedder_factory)
    coords, clusters = project_and_cluster(matrix)
    neighbours = similar(cards, matrix)
    labels = cluster_labels(publications, [int(c) for c in clusters], keyword_labels)
    return {
        **_contract(),
        "cardMaxWords": CARD_MAX_WORDS,
        "lowSignalThreshold": LOW_SIGNAL_THRESHOLD,
        "umap": {"neighbors": UMAP_NEIGHBORS, "minDist": UMAP_MIN_DIST, "metric": "cosine", "seed": SEED},
        "clustering": {"algorithm": "k-means", "clusters": len(labels), "seed": SEED},
        "clusters": labels,
        # Row-aligned with publications.json: [x, y, cluster, lowSignal].
        "points": [
            [
                round(float(coords[i][0]), 5),
                round(float(coords[i][1]), 5),
                int(clusters[i]),
                int(card.low_signal),
            ]
            for i, card in enumerate(cards)
        ],
        "similar": neighbours,
        "stats": {
            **cache_stats,
            "cards": len(cards),
            "lowSignal": sum(c.low_signal for c in cards),
            "truncated": sum(c.truncated for c in cards),
        },
    }
