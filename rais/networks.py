"""Keyword co-occurrence and co-author networks with a precomputed layout.

As in DREVisualizations' Entity Network, positions are baked here
(ForceAtlas2) and projected to pseudo longitude/latitude, so the browser does
no layout work and draws the same picture on every load. Communities are
Louvain. Each node and edge carries the publications behind it, so the page
can facet by year, type, author or keyword and recount weights in the browser
while the layout stays put.
"""

from __future__ import annotations

import math
from collections import defaultdict
from itertools import combinations
from typing import Any

import networkx as nx

SEED = 42
FA2_ITERATIONS = 600
MIN_COMMUNITY = 4
PACK_PADDING = 0.8
# Pseudo-coordinate box the layout is fitted into: wide enough to pan
# around, far enough from the poles that Web Mercator barely stretches it.
LNG_SPAN = 60.0
LAT_SPAN = 40.0


def _graph(
    groups: list[list[int]],
) -> tuple[nx.Graph, dict[tuple[int, int], list[int]], dict[int, list[int]]]:
    """``groups[p]`` lists the entities of publication p; entities sharing a
    publication are linked, weighted by how many they share."""
    graph = nx.Graph()
    edge_pubs: dict[tuple[int, int], list[int]] = defaultdict(list)
    node_pubs: dict[int, list[int]] = defaultdict(list)
    for pub, members in enumerate(groups):
        unique = sorted(set(members))
        for node in unique:
            node_pubs[node].append(pub)
        for a, b in combinations(unique, 2):
            edge_pubs[(a, b)].append(pub)
    for (a, b), pubs in edge_pubs.items():
        graph.add_edge(a, b, weight=len(pubs))
    return graph, edge_pubs, node_pubs


def _project(pos: dict[int, Any]) -> dict[int, tuple[float, float]]:
    xs = [float(p[0]) for p in pos.values()]
    ys = [float(p[1]) for p in pos.values()]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span_x = (max(xs) - min(xs)) or 1.0
    span_y = (max(ys) - min(ys)) or 1.0
    # One scale for both axes, so the layout's proportions are kept.
    scale = min(2 * LNG_SPAN / span_x, 2 * LAT_SPAN / span_y)
    return {
        n: (round((float(p[0]) - cx) * scale, 5), round((float(p[1]) - cy) * scale, 5))
        for n, p in pos.items()
    }


def _layout(graph: nx.Graph) -> dict[int, tuple[float, float]]:
    """ForceAtlas2 per connected component, then the components packed in
    rings around the largest one. One FA2 run over the whole graph pushes
    the small components far out and squeezes the main one into a dot."""
    components = sorted((sorted(c) for c in nx.connected_components(graph)), key=lambda c: (-len(c), c[0]))
    shapes = []
    for members in components:
        if len(members) == 2:
            local = {members[0]: (-1.0, 0.0), members[1]: (1.0, 0.0)}
        else:
            local = nx.forceatlas2_layout(
                graph.subgraph(members),
                max_iter=FA2_ITERATIONS,
                weight="weight",
                seed=SEED,
                scaling_ratio=2.0,
            )
        cx = sum(float(local[n][0]) for n in members) / len(members)
        cy = sum(float(local[n][1]) for n in members) / len(members)
        reach = max(math.hypot(float(local[n][0]) - cx, float(local[n][1]) - cy) for n in members) or 1.0
        # Radius grows with sqrt(size): every component gets the same density.
        radius = math.sqrt(len(members))
        shapes.append(
            (
                {
                    n: (
                        (float(local[n][0]) - cx) / reach * radius,
                        (float(local[n][1]) - cy) / reach * radius,
                    )
                    for n in members
                },
                radius,
            )
        )

    pos: dict[int, tuple[float, float]] = dict(shapes[0][0])
    pad = PACK_PADDING
    ring = shapes[0][1] + pad + (shapes[1][1] if len(shapes) > 1 else 0)
    angle = 0.0
    ring_width = 0.0
    for local, radius in shapes[1:]:
        step = (2 * radius + pad) / ring
        if angle + step > 2 * math.pi:
            ring += ring_width + pad
            angle, ring_width = 0.0, 0.0
            step = (2 * radius + pad) / ring
        theta = angle + step / 2
        ox, oy = ring * math.cos(theta), ring * math.sin(theta)
        pos.update({n: (x + ox, y + oy) for n, (x, y) in local.items()})
        angle += step
        ring_width = max(ring_width, 2 * radius)
    return pos


def build_network(
    groups: list[list[int]],
    labels: list[str],
    node_types: list[int],
    type_names: list[str],
) -> dict[str, Any]:
    graph, edge_pubs, node_pubs = _graph(groups)
    if graph.number_of_nodes() == 0:
        return {"types": type_names, "nodes": [], "edges": [], "meta": {"communityCount": 0}}
    pos = _layout(graph)
    coords = _project(pos)

    communities = nx.community.louvain_communities(graph, weight="weight", seed=SEED)
    communities = sorted((sorted(c) for c in communities), key=lambda c: (-len(c), c[0]))
    community_of: dict[int, int] = {}
    kept = 0
    for members in communities:
        # A clique of one paper's keywords is a "group" of its own; only
        # communities bigger than that are worth a colour and a filter entry.
        index = kept if len(members) >= MIN_COMMUNITY else -1
        if index >= 0:
            kept += 1
        for node in members:
            community_of[node] = index

    strength = dict(graph.degree(weight="weight"))
    order = sorted(graph.nodes, key=lambda n: (-strength[n], -len(node_pubs[n]), labels[n]))
    rank = {node: i for i, node in enumerate(order)}
    # Nodes are emitted hubs first, so a node's array index is also its rank.
    index_of = {node: i for i, node in enumerate(order)}
    nodes = [
        [
            labels[node],
            node_types[node],
            community_of[node],
            coords[node][0],
            coords[node][1],
            rank[node],
            node_pubs[node],
            node,
        ]
        for node in order
    ]
    edges = sorted(
        ([index_of[a], index_of[b], pubs] for (a, b), pubs in edge_pubs.items()),
        key=lambda e: (-len(e[2]), e[0], e[1]),
    )
    lngs = [n[3] for n in nodes]
    lats = [n[4] for n in nodes]
    isolated = sorted({n for g in groups for n in g} - set(graph.nodes))
    return {
        "types": type_names,
        # [label, type, community, lng, lat, rank, publication indices, entity index]
        "nodes": nodes,
        # [source, target, publication indices]
        "edges": edges,
        "meta": {
            "communityCount": kept,
            "bounds": [min(lngs), min(lats), max(lngs), max(lats)],
            "layout": {
                "algorithm": "ForceAtlas2 per component, packed in rings",
                "iterations": FA2_ITERATIONS,
                "seed": SEED,
            },
            "communities": {"algorithm": "Louvain", "seed": SEED, "minSize": MIN_COMMUNITY},
            # Entities that never share a publication with another one have no
            # place in a co-occurrence network; they stay in the dashboard.
            "isolatedOmitted": len(isolated),
        },
    }


def keyword_network(data: dict[str, Any]) -> dict[str, Any]:
    keywords = data["keywords"]
    return build_network(
        [p["keywords"] for p in data["publications"]],
        [k["label"] for k in keywords],
        [0] * len(keywords),
        ["Keyword"],
    )


def coauthor_network(data: dict[str, Any]) -> dict[str, Any]:
    authors = data["authors"]
    return build_network(
        [p["authors"] for p in data["publications"]],
        [a["label"] for a in authors],
        [0 if a["ubt"] else 1 for a in authors],
        ["University of Bayreuth", "External"],
    )
