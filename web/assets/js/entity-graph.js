/**
 * Co-occurrence network (keywords or co-authors) of the RAIS publications.
 *
 * Ported from DREVisualizations asset/js/entity-graph.js (the AMIRA Entity
 * Network): the graph is drawn with MapLibre GL over a layout baked at build
 * time (ForceAtlas2, projected to pseudo lng/lat), so the browser does no
 * layout work and the picture is identical on every load. Kept from the
 * original: hover popup, click-to-select with the neighbourhood highlighted
 * through feature-state, search combobox, type chips, minimum-link filter,
 * group isolation, colour by type/group, reset, PNG/CSV export, keyboard
 * walk and the text alternative.
 *
 * Changed: every node and edge carries the publications behind it, so the
 * shared facet bar (year, type, keyword, author, topic) recounts node sizes
 * and edge weights in the browser while the layout stays put; and the
 * sidebar lists a node's publications with links to ERef.
 *
 * Payload (rais/networks.py):
 *   { types: [...], nodes: [[label, type, community, lng, lat, rank, [pub], entity]],
 *     edges: [[source, target, [pub]]], meta: { communityCount, bounds } }
 *
 * Copyright (C) the DREVisualizations authors and contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
    'use strict';

    var ns = window.RV;
    if (!ns) return;
    var el = ns.el;
    var escapeHtml = ns.escapeHtml;

    var SRC_NODES = 'eg-nodes';
    var SRC_EDGES = 'eg-edges';
    var L_EDGES = 'eg-edge-lines';
    var L_NODES = 'eg-node-circles';
    var L_LABELS = 'eg-node-labels';
    var MIN_RADIUS = 3;
    var MAX_RADIUS = 18;
    var COLOURED_GROUPS = 8;

    function decode(payload) {
        var meta = payload.meta || {};
        return {
            types: payload.types || [],
            communityCount: meta.communityCount || 0,
            bounds: meta.bounds || null,
            nodes: (payload.nodes || []).map(function (r) {
                return { label: r[0], type: r[1], community: r[2], lng: r[3], lat: r[4], rank: r[5], pubs: r[6], entity: r[7] };
            }),
            edges: (payload.edges || []).map(function (r) { return { s: r[0], t: r[1], pubs: r[2] }; })
        };
    }

    function build(container, data, pubData, spec) {
        var types = data.types;
        var noun = spec.noun;            // { one: 'keyword', many: 'keywords' }
        var aNoun = (/^[aeiou]/i.test(noun.one) ? 'an ' : 'a ') + noun.one;
        var facetKey = spec.facet;       // facet the node maps to: 'keyword' | 'author'

        function typeColor(typeIdx) {
            return types.length > 1 ? ns.COLORS[typeIdx % ns.COLORS.length] : ns.COLORS[0];
        }
        function dimColor() { return ns.withAlpha(ns.THEME.muted, 0.45); }
        function groupColor(comm) {
            return comm >= 0 && comm < COLOURED_GROUPS ? ns.COLORS[comm] : dimColor();
        }

        container.innerHTML = '';
        var facetHost = el('div');
        container.appendChild(facetHost);
        var panel = el('section', 'panel');
        var toolbar = el('div', 'rv-toolbar');
        panel.appendChild(toolbar);
        var stage = el('div', 'stage');
        var canvasWrap = el('div');
        var canvas = el('div', 'canvas');
        canvas.setAttribute('role', 'application');
        canvas.tabIndex = 0;
        canvas.setAttribute('aria-label', spec.canvasLabel
            + ' Use the arrow keys to move between connected ' + noun.many + ' and Enter to select one.');
        var status = el('p', 'rv-status');
        canvasWrap.appendChild(canvas);
        canvasWrap.appendChild(status);
        var sidebar = el('aside', 'panel sidebar');
        stage.appendChild(canvasWrap);
        stage.appendChild(sidebar);
        panel.appendChild(stage);
        var legend = el('div', 'legend');
        panel.appendChild(legend);
        container.appendChild(panel);

        /* -- static structure -- */
        var adjacencyAll = data.nodes.map(function () { return []; });
        data.edges.forEach(function (e, k) {
            adjacencyAll[e.s].push({ j: e.t, k: k });
            adjacencyAll[e.t].push({ j: e.s, k: k });
        });
        var commSizes = {};
        data.nodes.forEach(function (n) { if (n.community >= 0) commSizes[n.community] = (commSizes[n.community] || 0) + 1; });
        var clusters = Object.keys(commSizes).map(Number).map(function (id) {
            var anchor = null, best = Infinity;
            data.nodes.forEach(function (n) {
                if (n.community === id && n.rank < best) { best = n.rank; anchor = n.label; }
            });
            return { id: id, size: commSizes[id], anchor: anchor };
        }).sort(function (a, b) { return (b.size - a.size) || (a.id - b.id); });
        var byLabel = {};
        data.nodes.forEach(function (n, i) { byLabel[ns.fold(n.label)] = i; });

        var bounds = data.bounds;

        /* -- interaction state -- */
        var enabledTypes = {};
        types.forEach(function (_t, i) { enabledTypes[i] = true; });
        var weightMin = 1;
        var colorParam = ns.params.get('color');
        var colorMode = colorParam === 'type' && types.length > 1 ? 'type'
            : (colorParam === 'group' || colorParam === 'community' || types.length < 2 ? 'community' : spec.defaultColor || 'type');
        if (!data.communityCount) colorMode = 'type';
        var commFilter = null;
        var selectedIndex = null;
        var focusIndex = null;
        var map = null;
        var fitted = false;
        var hoverPopup = null;
        var hoverId = null;
        var listPanel = null;
        var facets = null;

        /* -- per-facet counts (recomputed on every facet change) -- */
        var pubOn = [];
        var nodeCount = data.nodes.map(function () { return 0; });
        var edgeWeight = data.edges.map(function () { return 0; });
        var nodeVisible = data.nodes.map(function () { return true; });
        var edgeVisible = data.edges.map(function () { return true; });
        var nodeDegree = data.nodes.map(function () { return 0; });
        var maxWeightNow = 1;

        function countOn(pubs) {
            var n = 0;
            for (var i = 0; i < pubs.length; i++) if (pubOn[pubs[i]]) n++;
            return n;
        }

        function recount() {
            pubOn = pubData.publications.map(function (p) { return facets ? facets.matches(p) : true; });
            data.nodes.forEach(function (n, i) { nodeCount[i] = countOn(n.pubs); });
            data.edges.forEach(function (e, k) { edgeWeight[k] = countOn(e.pubs); });
        }

        function visibleNode(index) { return nodeVisible[index]; }

        function computeVisibility() {
            data.nodes.forEach(function (n, i) {
                nodeVisible[i] = nodeCount[i] > 0 && !!enabledTypes[n.type]
                    && (commFilter == null || n.community === commFilter);
            });
            maxWeightNow = 1;
            data.edges.forEach(function (e, k) {
                edgeVisible[k] = edgeWeight[k] >= weightMin && edgeWeight[k] > 0 && nodeVisible[e.s] && nodeVisible[e.t];
                if (edgeVisible[k] && edgeWeight[k] > maxWeightNow) maxWeightNow = edgeWeight[k];
            });
            nodeDegree = data.nodes.map(function () { return 0; });
            data.edges.forEach(function (e, k) {
                if (!edgeVisible[k]) return;
                nodeDegree[e.s]++;
                nodeDegree[e.t]++;
            });
        }

        function neighboursOf(index) {
            return adjacencyAll[index]
                .filter(function (nb) { return edgeVisible[nb.k]; })
                .map(function (nb) { return { j: nb.j, w: edgeWeight[nb.k], k: nb.k }; })
                .sort(function (a, b) { return b.w - a.w || data.nodes[a.j].rank - data.nodes[b.j].rank; });
        }

        function nodeFeatures() {
            var maxCount = 1;
            nodeCount.forEach(function (c) { if (c > maxCount) maxCount = c; });
            return {
                type: 'FeatureCollection',
                features: data.nodes.map(function (n, i) {
                    return {
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [n.lng, n.lat] },
                        properties: {
                            i: i, type: n.type, comm: n.community, vis: nodeVisible[i] ? 1 : 0,
                            r: MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(nodeCount[i] / maxCount),
                            label: n.label, rank: n.rank
                        }
                    };
                })
            };
        }
        function edgeFeatures() {
            return {
                type: 'FeatureCollection',
                features: data.edges.map(function (e, k) {
                    var s = data.nodes[e.s], t = data.nodes[e.t];
                    return {
                        type: 'Feature',
                        geometry: { type: 'LineString', coordinates: [[s.lng, s.lat], [t.lng, t.lat]] },
                        properties: { k: k, w: edgeWeight[k], vis: edgeVisible[k] ? 1 : 0, wn: Math.sqrt(edgeWeight[k] / maxWeightNow) }
                    };
                })
            };
        }

        /* -- paint expressions -- */
        function nodeColorExpr() {
            var expr, i;
            if (colorMode === 'community') {
                expr = ['match', ['get', 'comm']];
                for (i = 0; i < Math.min(COLOURED_GROUPS, data.communityCount); i++) expr.push(i, groupColor(i));
                expr.push(dimColor());
                return expr;
            }
            if (types.length < 2) return typeColor(0);
            expr = ['match', ['get', 'type']];
            for (i = 0; i < types.length; i++) expr.push(i, typeColor(i));
            expr.push(ns.THEME.textMuted);
            return expr;
        }
        function edgeOpacityExpr(min, max) { return ['+', min, ['*', max - min, ['get', 'wn']]]; }
        function hoverOpacityExpr(base, hovered) {
            return ['case', ['boolean', ['feature-state', 'hover'], false], hovered, base];
        }
        function strokeWidthExpr() {
            return ['case',
                ['boolean', ['feature-state', 'focus'], false], 3.5,
                ['boolean', ['feature-state', 'hover'], false], 2.5,
                1];
        }
        function strokeColorExpr() {
            return ['case', ['boolean', ['feature-state', 'focus'], false], ns.THEME.accent, ns.THEME.surface];
        }
        function edgeColorExpr() {
            return ['case', ['boolean', ['feature-state', 'hl'], false], ns.THEME.accent, ns.THEME.grid];
        }
        var VISIBLE = ['==', ['get', 'vis'], 1];

        function filtersActive() {
            return Object.keys(enabledTypes).some(function (k) { return !enabledTypes[k]; })
                || weightMin > 1 || commFilter != null || selectedIndex != null;
        }
        function updateClearState() { if (clearBtn) clearBtn.disabled = !filtersActive(); }

        function labelFilter() {
            if (selectedIndex == null) return VISIBLE;
            var ids = [selectedIndex].concat(neighboursOf(selectedIndex).map(function (nb) { return nb.j; }));
            if (focusIndex != null && ids.indexOf(focusIndex) === -1) ids.push(focusIndex);
            return ['all', VISIBLE, ['in', ['get', 'i'], ['literal', ids]]];
        }

        /* -- selection as feature-state (promoteId: a feature id IS the index) -- */
        var selectedNodes = [], selectedEdges = [], selectionMode = null;
        function setStates(source, ids, state) {
            ids.forEach(function (id) { map.setFeatureState({ source: source, id: id }, state); });
        }
        function applySelectionPaint() {
            if (!map || !map.getLayer(L_NODES)) return;
            setStates(SRC_NODES, selectedNodes, { sel: false });
            setStates(SRC_EDGES, selectedEdges, { hl: false });
            selectedNodes = [];
            selectedEdges = [];
            if (selectedIndex != null) {
                var nbs = neighboursOf(selectedIndex);
                selectedNodes = [selectedIndex].concat(nbs.map(function (nb) { return nb.j; }));
                selectedEdges = nbs.map(function (nb) { return nb.k; });
                setStates(SRC_NODES, selectedNodes, { sel: true });
                setStates(SRC_EDGES, selectedEdges, { hl: true });
            }
            var mode = selectedIndex == null ? 'none' : 'selected';
            if (mode === selectionMode) return;
            selectionMode = mode;
            var hl = ['boolean', ['feature-state', 'hl'], false];
            map.setPaintProperty(L_EDGES, 'line-opacity', mode === 'none'
                ? edgeOpacityExpr(0.12, 0.6)
                : ['case', hl, 0.9, edgeOpacityExpr(0.03, 0.12)]);
            map.setPaintProperty(L_NODES, 'circle-opacity', mode === 'none'
                ? hoverOpacityExpr(0.9, 1)
                : ['case', ['boolean', ['feature-state', 'sel'], false], 1, 0.18]);
        }

        var focusFeature = null;
        function paintFocus(index) {
            if (!map || !map.getSource(SRC_NODES)) return;
            if (focusFeature !== null) map.setFeatureState({ source: SRC_NODES, id: focusFeature }, { focus: false });
            focusFeature = index == null ? null : index;
            if (focusFeature !== null) map.setFeatureState({ source: SRC_NODES, id: focusFeature }, { focus: true });
        }
        function setFocus(index) {
            focusIndex = index;
            paintFocus(index);
            if (map && map.getLayer(L_LABELS)) map.setFilter(L_LABELS, labelFilter());
            if (index == null) return;
            var n = data.nodes[index];
            hideHover();
            try { map.easeTo({ center: [n.lng, n.lat], zoom: Math.max(map.getZoom(), 3.5), duration: 260 }); } catch (err) { /* ignore */ }
        }

        function updateStatus() {
            var nodes = nodeVisible.filter(Boolean).length;
            var links = edgeVisible.filter(Boolean).length;
            status.textContent = ns.plural(nodes, '', noun.one, noun.many, true) + ' · '
                + ns.plural(links, '', 'link', 'links', true) + ' shown';
        }

        /** Recompute visibility, push it to the sources, repaint. */
        function applyFilters() {
            computeVisibility();
            updateClearState();
            updateStatus();
            if (selectedIndex != null && !visibleNode(selectedIndex)) selectedIndex = null;
            if (focusIndex != null && !visibleNode(focusIndex)) setFocus(null);
            if (listPanel) listPanel.refresh();
            if (map && map.getSource(SRC_NODES)) {
                map.getSource(SRC_NODES).setData(nodeFeatures());
                map.getSource(SRC_EDGES).setData(edgeFeatures());
                // setData drops feature-state; re-apply the selection from scratch.
                selectedNodes = [];
                selectedEdges = [];
                selectionMode = null;
                applySelectionPaint();
                paintFocus(focusIndex);
                map.setFilter(L_LABELS, labelFilter());
            }
            if (selectedIndex == null) showOverview(); else showDetail(selectedIndex);
        }

        function selectIndex(index) {
            selectedIndex = index;
            applySelectionPaint();
            if (map && map.getLayer(L_LABELS)) map.setFilter(L_LABELS, labelFilter());
            updateClearState();
            if (index == null) showOverview(); else showDetail(index);
        }

        /* -- layers -- */
        function addAll(m) {
            m.addSource(SRC_EDGES, { type: 'geojson', data: edgeFeatures(), promoteId: 'k' });
            m.addSource(SRC_NODES, { type: 'geojson', data: nodeFeatures(), promoteId: 'i' });
            m.addLayer({
                id: L_EDGES, type: 'line', source: SRC_EDGES, filter: VISIBLE,
                layout: { 'line-cap': 'round' },
                paint: {
                    'line-color': edgeColorExpr(),
                    'line-width': ['case', ['boolean', ['feature-state', 'hl'], false],
                        ['+', 1, ['*', 2.5, ['get', 'wn']]],
                        ['+', 0.5, ['*', 2.5, ['get', 'wn']]]],
                    'line-opacity': edgeOpacityExpr(0.12, 0.6)
                }
            });
            m.addLayer({
                id: L_NODES, type: 'circle', source: SRC_NODES, filter: VISIBLE,
                paint: {
                    'circle-radius': ['get', 'r'],
                    'circle-color': nodeColorExpr(),
                    'circle-opacity': hoverOpacityExpr(0.9, 1),
                    'circle-stroke-width': strokeWidthExpr(),
                    'circle-stroke-color': strokeColorExpr()
                }
            });
            m.addLayer({
                id: L_LABELS, type: 'symbol', source: SRC_NODES, filter: VISIBLE,
                layout: {
                    'text-field': ['get', 'label'],
                    'text-font': ns.MAP_LABEL_FONT,
                    'text-size': 12,
                    'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
                    'text-radial-offset': ['+', 0.4, ['/', ['get', 'r'], 14]],
                    'text-justify': 'auto',
                    'symbol-sort-key': ['get', 'rank']
                },
                paint: { 'text-color': ns.THEME.text, 'text-halo-color': ns.THEME.surface, 'text-halo-width': 1.3 }
            });
            selectedNodes = [];
            selectedEdges = [];
            selectionMode = null;
            applySelectionPaint();
            if (!fitted && bounds) {
                fitted = true;
                try { m.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 36, duration: 0 }); } catch (err) { /* degenerate */ }
            }
            if (pendingSelect != null) { var p = pendingSelect; pendingSelect = null; focusNode(p); }
        }

        /* -- hover -- */
        function hoverHtml(index) {
            var n = data.nodes[index];
            var bits = [];
            if (types.length > 1) bits.push(escapeHtml(types[n.type]));
            bits.push(escapeHtml(ns.plural(nodeCount[index], '', 'publication', 'publications', true)));
            bits.push(escapeHtml(ns.plural(nodeDegree[index], '', 'link', 'links', true)));
            return '<strong>' + escapeHtml(n.label) + '</strong><span class="popup-meta">' + bits.join(' · ') + '</span>';
        }
        function showHover(e) {
            var f = e.features && e.features[0];
            if (!f) return;
            map.getCanvas().style.cursor = 'pointer';
            hoverId = ns.moveHover(map, SRC_NODES, hoverId, f.id);
            var index = Number(f.properties.i);
            var n = data.nodes[index];
            if (!hoverPopup) hoverPopup = ns.mapPopup({ closeButton: false, closeOnClick: false, offset: 12 });
            hoverPopup.setLngLat([n.lng, n.lat]).setHTML(hoverHtml(index)).addTo(map);
        }
        function hideHover() {
            if (!map) return;
            map.getCanvas().style.cursor = '';
            hoverId = ns.moveHover(map, SRC_NODES, hoverId, null);
            if (hoverPopup) hoverPopup.remove();
        }

        /* -- map -- */
        function graphStyle() {
            return {
                version: 8,
                glyphs: ns.mapGlyphs(),
                sources: {},
                layers: [{ id: 'bg', type: 'background', paint: { 'background-color': ns.THEME.surface } }]
            };
        }
        function createMap() {
            map = ns.createMap({
                container: canvas,
                style: graphStyle(),
                center: [0, 0],
                zoom: 1,
                attributionControl: false,
                renderWorldCopies: false,
                dragRotate: false,
                pitchWithRotate: false,
                touchPitch: false,
                maxZoom: 9,
                maxBounds: [[-179, -85], [179, 85]],
                // Keep the drawing buffer so the PNG export can read it back.
                canvasContextAttributes: { preserveDrawingBuffer: true },
                // The arrow keys walk the graph instead of panning it.
                keyboard: false
            });
            map.addControl(ns.navControl(), 'top-right');
            map.on('load', function () { addAll(map); });
            map.on('click', function (e) {
                if (!map.getLayer(L_NODES)) return;
                var feats = map.queryRenderedFeatures(e.point, { layers: [L_NODES] });
                selectIndex(feats.length ? Number(feats[0].properties.i) : null);
            });
            map.on('mousemove', L_NODES, showHover);
            map.on('mouseleave', L_NODES, hideHover);
            var inner = canvas.querySelector('.maplibregl-canvas');
            if (inner) inner.setAttribute('tabindex', '-1');
        }

        /* -- sidebar -- */
        function showOverview() {
            sidebar.innerHTML = '';
            sidebar.appendChild(el('div', 'side-title', spec.title));
            var counts = {};
            data.nodes.forEach(function (n, i) { if (nodeVisible[i]) counts[n.type] = (counts[n.type] || 0) + 1; });
            types.forEach(function (label, i) {
                if (!counts[i]) return;
                var row = el('div', 'type-row');
                var sw = el('span', 'swatch');
                sw.style.background = colorMode === 'type' ? typeColor(i) : ns.THEME.muted;
                row.appendChild(sw);
                row.appendChild(el('span', null, label));
                row.appendChild(el('span', 'type-val', String(counts[i])));
                sidebar.appendChild(row);
            });
            var hubs = [];
            for (var i = 0; i < data.nodes.length && hubs.length < 12; i++) {
                if (nodeVisible[i] && nodeDegree[i] > 0) hubs.push(i);
            }
            hubs.sort(function (a, b) { return nodeDegree[b] - nodeDegree[a] || data.nodes[a].rank - data.nodes[b].rank; });
            if (hubs.length) {
                sidebar.appendChild(el('div', 'side-sub', 'Most connected'));
                sidebar.appendChild(neighbourButtons(hubs.map(function (j) { return { j: j, w: nodeDegree[j] }; }), 'links'));
            }
            sidebar.appendChild(el('p', 'side-hint', 'Hover over ' + aNoun + ', or click it, to see what it is connected to and its publications.'));
        }

        function neighbourButtons(list, unit) {
            var wrap = el('div', 'neighbours');
            list.forEach(function (nb) {
                var ni = data.nodes[nb.j];
                var btn = el('button', 'neighbour');
                btn.type = 'button';
                var sw = el('span', 'swatch');
                sw.style.background = colorMode === 'community' ? groupColor(ni.community) : typeColor(ni.type);
                btn.appendChild(sw);
                btn.appendChild(el('span', 'name', ni.label));
                btn.appendChild(el('span', 'w', String(nb.w)));
                btn.title = ni.label + ': ' + nb.w + ' ' + unit;
                btn.addEventListener('click', function () { focusNode(nb.j); });
                wrap.appendChild(btn);
            });
            return wrap;
        }

        function showDetail(index) {
            var info = data.nodes[index];
            sidebar.innerHTML = '';
            var typeTag = el('div', 'side-type', types.length > 1 ? types[info.type] : noun.label);
            typeTag.style.color = colorMode === 'community' ? groupColor(info.community) : typeColor(info.type);
            sidebar.appendChild(typeTag);
            sidebar.appendChild(el('div', 'side-heading', info.label));
            sidebar.appendChild(el('div', 'side-stats',
                ns.plural(nodeCount[index], '', 'publication', 'publications', true) + ' · '
                + ns.plural(nodeDegree[index], '', 'connection', 'connections', true)));
            var actions = el('div', 'side-actions');
            var filterBtn = el('button', 'btn', spec.filterLabel);
            filterBtn.type = 'button';
            filterBtn.title = 'Filter every view to publications with this ' + noun.one;
            filterBtn.addEventListener('click', function () {
                var patch = {};
                patch[facetKey] = info.entity;
                facets.set(patch);
            });
            var back = el('button', 'btn', 'Back to overview');
            back.type = 'button';
            back.addEventListener('click', function () { selectIndex(null); });
            actions.appendChild(filterBtn);
            actions.appendChild(back);
            sidebar.appendChild(actions);

            var nbrs = neighboursOf(index);
            if (nbrs.length) {
                sidebar.appendChild(el('div', 'side-sub',
                    'Strongest connections (' + Math.min(nbrs.length, 15) + ' of ' + nbrs.length + ')'));
                sidebar.appendChild(neighbourButtons(nbrs.slice(0, 15), 'shared publications'));
            }
            var pubs = info.pubs.filter(function (p) { return pubOn[p]; }).map(function (p) { return pubData.publications[p]; });
            sidebar.appendChild(el('div', 'side-sub', 'Publications (' + pubs.length + ')'));
            sidebar.appendChild(ns.pubList(pubs, 6));
        }

        function focusNode(index) {
            var n = data.nodes[index];
            if (!n) return;
            hideHover();
            try { map.easeTo({ center: [n.lng, n.lat], zoom: Math.max(map.getZoom(), 4), duration: 500 }); } catch (err) { /* ignore */ }
            selectIndex(index);
        }

        /* -- toolbar -- */
        var searchWrap = el('div', 'search');
        var search = el('input');
        search.type = 'search';
        search.placeholder = 'Find ' + aNoun + '…';
        search.setAttribute('aria-label', 'Find ' + aNoun);
        var results = el('div', 'search-results');
        results.hidden = true;
        searchWrap.appendChild(search);
        searchWrap.appendChild(results);
        toolbar.appendChild(searchWrap);
        var hitSeq = 0;
        function currentHits() { return Array.prototype.slice.call(results.querySelectorAll('.search-hit')); }
        function closeResults() { results.hidden = true; }
        function takeHit(option) {
            var idx = Number(option.dataset.index);
            search.value = data.nodes[idx].label;
            closeResults();
            searchKeys.reset();
            focusNode(idx);
        }
        var searchKeys = ns.egUI.wireSearchKeys(search, results, { hits: currentHits, onPick: takeHit, onClose: closeResults });
        search.addEventListener('input', function () {
            var q = ns.fold(search.value.trim());
            ns.setChildren(results);
            if (q.length < 2) { closeResults(); searchKeys.sync(); return; }
            var hits = [];
            for (var i = 0; i < data.nodes.length && hits.length < 8; i++) {
                if (visibleNode(i) && ns.fold(data.nodes[i].label).indexOf(q) !== -1) hits.push(i);
            }
            if (!hits.length) { closeResults(); searchKeys.sync(); return; }
            hits.forEach(function (idx) {
                var n = data.nodes[idx];
                var item = el('div', 'search-hit');
                item.id = 'graph-hit-' + (++hitSeq);
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', 'false');
                item.dataset.index = String(idx);
                item.appendChild(el('span', null, n.label));
                item.appendChild(el('span', 'meta', String(nodeCount[idx])));
                item.addEventListener('mousedown', function (ev) { ev.preventDefault(); takeHit(item); });
                results.appendChild(item);
            });
            results.hidden = false;
            searchKeys.sync();
        });

        var chips = el('div', 'chips');
        if (types.length > 1) {
            types.forEach(function (label, i) {
                var chip = el('button', 'chip');
                chip.type = 'button';
                chip.setAttribute('aria-pressed', 'true');
                var sw = el('span', 'swatch');
                sw.style.background = typeColor(i);
                chip.appendChild(sw);
                chip.appendChild(el('span', null, label));
                chip.addEventListener('click', function () {
                    enabledTypes[i] = !enabledTypes[i];
                    chip.setAttribute('aria-pressed', String(enabledTypes[i]));
                    applyFilters();
                });
                chip._sw = sw;
                chip._i = i;
                chips.appendChild(chip);
            });
            toolbar.appendChild(chips);
        }

        var wWrap = el('label', 'select-label');
        wWrap.appendChild(el('span', null, 'Shared publications'));
        var weightSelect = el('select');
        [1, 2, 3, 5].forEach(function (v) {
            var o = el('option', null, v === 1 ? 'Any' : v + ' or more');
            o.value = String(v);
            weightSelect.appendChild(o);
        });
        weightSelect.addEventListener('change', function () {
            weightMin = Number(weightSelect.value) || 1;
            applyFilters();
        });
        wWrap.appendChild(weightSelect);
        toolbar.appendChild(wWrap);

        var clusterSelect = null;
        if (clusters.length > 1) {
            clusterSelect = ns.egUI.buildClusterSelect(clusters, function (id) {
                commFilter = id;
                if (id != null && map) {
                    var w = 180, s = 90, e2 = -180, n2 = -90, found = false;
                    data.nodes.forEach(function (nd) {
                        if (nd.community !== id) return;
                        found = true;
                        if (nd.lng < w) w = nd.lng;
                        if (nd.lng > e2) e2 = nd.lng;
                        if (nd.lat < s) s = nd.lat;
                        if (nd.lat > n2) n2 = nd.lat;
                    });
                    if (found) {
                        try { map.fitBounds([[w, s], [e2, n2]], { padding: 48, duration: 500, maxZoom: 7 }); } catch (err) { /* degenerate */ }
                    }
                }
                applyFilters();
            });
            toolbar.appendChild(clusterSelect.el);
        }

        var clearBtn = el('button', 'btn', 'Clear');
        clearBtn.type = 'button';
        clearBtn.title = 'Show every ' + noun.one + ' again and drop the selection (the facets above stay)';
        clearBtn.disabled = true;
        clearBtn.addEventListener('click', function () {
            types.forEach(function (_t, i) { enabledTypes[i] = true; });
            Array.prototype.forEach.call(chips.querySelectorAll('.chip'), function (chip) { chip.setAttribute('aria-pressed', 'true'); });
            weightMin = 1;
            weightSelect.value = '1';
            commFilter = null;
            if (clusterSelect) clusterSelect.reset();
            search.value = '';
            results.hidden = true;
            searchKeys.reset();
            setFocus(null);
            selectedIndex = null;
            applyFilters();
        });
        toolbar.appendChild(clearBtn);
        toolbar.appendChild(el('div', 'rv-spacer'));

        var colorModes = [];
        if (types.length > 1) colorModes.push({ id: 'type', label: 'Affiliation' });
        if (data.communityCount > 0) colorModes.push({ id: 'community', label: 'Group' });
        if (colorModes.length > 1) {
            var modeWrap = el('div', 'rv-group');
            modeWrap.setAttribute('role', 'group');
            modeWrap.setAttribute('aria-label', 'Colour by');
            modeWrap.appendChild(el('span', null, 'Colour by'));
            var modeBtns = {};
            colorModes.forEach(function (m) {
                var b = el('button', 'btn', m.label);
                b.type = 'button';
                b.setAttribute('aria-pressed', String(colorMode === m.id));
                b.addEventListener('click', function () {
                    if (colorMode === m.id) return;
                    colorMode = m.id;
                    Object.keys(modeBtns).forEach(function (k) { modeBtns[k].setAttribute('aria-pressed', String(k === m.id)); });
                    if (map && map.getLayer(L_NODES)) map.setPaintProperty(L_NODES, 'circle-color', nodeColorExpr());
                    rebuildLegend();
                    if (selectedIndex != null) showDetail(selectedIndex); else showOverview();
                });
                modeBtns[m.id] = b;
                modeWrap.appendChild(b);
            });
            toolbar.appendChild(modeWrap);
        }

        var resetBtn = ns.iconButton(ns.ICONS.reset, 'Reset view');
        resetBtn.addEventListener('click', resetView);
        toolbar.appendChild(resetBtn);
        function resetView() {
            setFocus(null);
            selectIndex(null);
            if (map && bounds) {
                try { map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 36, duration: 500 }); } catch (err) { /* degenerate */ }
            }
        }
        ns.egUI.buildExportButtons({
            name: spec.name,
            png: function () { return map ? ns.mapPng(map) : null; },
            rows: function () {
                var head = [noun.label, 'Publications', 'Links', 'Group'];
                if (types.length > 1) head.splice(1, 0, 'Affiliation');
                var rows = [head];
                data.nodes.forEach(function (n, i) {
                    if (!visibleNode(i)) return;
                    var row = [n.label, nodeCount[i], nodeDegree[i], n.community >= 0 ? n.community + 1 : ''];
                    if (types.length > 1) row.splice(1, 0, types[n.type]);
                    rows.push(row);
                });
                return rows;
            }
        }).forEach(function (btn) { toolbar.appendChild(btn); });

        /* -- legend -- */
        function rebuildLegend() {
            legend.innerHTML = '';
            if (colorMode === 'community') {
                clusters.slice(0, COLOURED_GROUPS).forEach(function (c) {
                    if (c.id >= COLOURED_GROUPS) return;
                    var row = el('span', 'legend-item');
                    var sw = el('span', 'swatch');
                    sw.style.background = groupColor(c.id);
                    row.appendChild(sw);
                    row.appendChild(el('span', null, ns.truncateLabel(c.anchor, 28) + ' …'));
                    legend.appendChild(row);
                });
                var other = el('span', 'legend-item');
                var osw = el('span', 'swatch');
                osw.style.background = dimColor();
                other.appendChild(osw);
                other.appendChild(el('span', null, 'Smaller groups'));
                legend.appendChild(other);
                legend.appendChild(el('span', 'legend-note',
                    'A group is a set of ' + noun.many + ' that keep appearing together (Louvain), named after its most connected member.'));
                return;
            }
            types.forEach(function (label, i) {
                var row = el('span', 'legend-item');
                var sw = el('span', 'swatch');
                sw.style.background = typeColor(i);
                row.appendChild(sw);
                row.appendChild(el('span', null, label));
                legend.appendChild(row);
            });
        }

        /* -- theme: recolour in place -- */
        ns.trackRenderer(container, function () {
            if (map && map.getLayer(L_NODES)) {
                map.setPaintProperty('bg', 'background-color', ns.THEME.surface);
                map.setPaintProperty(L_NODES, 'circle-color', nodeColorExpr());
                map.setPaintProperty(L_NODES, 'circle-stroke-color', strokeColorExpr());
                map.setPaintProperty(L_EDGES, 'line-color', edgeColorExpr());
                map.setPaintProperty(L_LABELS, 'text-color', ns.THEME.text);
                map.setPaintProperty(L_LABELS, 'text-halo-color', ns.THEME.surface);
            }
            Array.prototype.forEach.call(chips.querySelectorAll('.chip'), function (chip) {
                if (chip._sw) chip._sw.style.background = typeColor(chip._i);
            });
            rebuildLegend();
            if (selectedIndex != null) showDetail(selectedIndex); else showOverview();
        });

        /* -- text alternative -- */
        listPanel = ns.egUI.buildListPanel({
            summary: 'See these ' + noun.many + ' as a list',
            groups: function () {
                var byType = {};
                data.nodes.forEach(function (n, i) {
                    if (!visibleNode(i)) return;
                    (byType[n.type] = byType[n.type] || []).push(i);
                });
                return types.map(function (label, t) {
                    if (!byType[t]) return null;
                    return {
                        name: label,
                        color: typeColor(t),
                        rows: byType[t].map(function (i) {
                            return {
                                label: data.nodes[i].label,
                                meta: ns.plural(nodeCount[i], '', 'publication', 'publications', true)
                                    + ' · ' + ns.plural(nodeDegree[i], '', 'link', 'links', true)
                            };
                        })
                    };
                }).filter(Boolean);
            }
        });
        panel.appendChild(listPanel.el);

        /* -- keyboard -- */
        ns.egUI.attachKeyboard(canvas, {
            order: function () {
                var out = [];
                for (var i = 0; i < data.nodes.length; i++) if (visibleNode(i)) out.push(i);
                return out;
            },
            neighbours: function (i) { return neighboursOf(i).map(function (nb) { return nb.j; }); },
            describe: function (i) {
                var n = data.nodes[i];
                return n.label + (types.length > 1 ? ', ' + types[n.type] : '')
                    + ', ' + ns.plural(nodeCount[i], '', 'publication', 'publications', true)
                    + ', ' + ns.plural(nodeDegree[i], '', 'link', 'links', true) + '. Press Enter to select.';
            },
            onFocus: setFocus,
            onActivate: function (i) { selectIndex(i === selectedIndex ? null : i); },
            onEscape: function () {
                if (selectedIndex == null) return false;
                selectIndex(null);
                return true;
            },
            onZoom: function (direction) {
                if (!map) return;
                try { map.zoomTo(map.getZoom() + (direction > 0 ? 0.6 : -0.6), { duration: 200 }); } catch (err) { /* ignore */ }
            },
            onFit: resetView
        });

        /* -- go -- */
        facets = ns.facets.create(facetHost, pubData, { embedHeight: 960 });
        facets.onChange(function () { recount(); applyFilters(); });
        recount();
        computeVisibility();
        updateStatus();
        rebuildLegend();
        // ?select=<label> opens the page on one node.
        var pendingSelect = null;
        var preset = ns.params.get('select');
        if (preset && byLabel[ns.fold(preset)] != null) {
            pendingSelect = byLabel[ns.fold(preset)];
        }
        showOverview();
        createMap();
    }

    function init(container) {
        var state = ns.asyncState(container);
        var spec = {
            src: container.getAttribute('data-src'),
            facet: container.getAttribute('data-facet'),
            name: container.getAttribute('data-name'),
            title: container.getAttribute('data-title'),
            canvasLabel: container.getAttribute('data-label') || '',
            filterLabel: container.getAttribute('data-filter-label') || 'Filter by this',
            defaultColor: container.getAttribute('data-color') || 'type',
            noun: {
                one: container.getAttribute('data-noun') || 'node',
                many: container.getAttribute('data-nouns') || 'nodes',
                label: container.getAttribute('data-noun-label') || 'Node'
            }
        };
        function run() {
            state.loading();
            Promise.all([ns.fetchJson(spec.src), ns.loadPublications(), ns.ensureLibs({ maplibre: true })]).then(function (res) {
                var data = decode(res[0]);
                if (!data.nodes.length) {
                    state.empty('There is no network to show yet.');
                    return;
                }
                build(container, data, res[1], spec);
                state.ready();
            }).catch(function (err) {
                console.error('network:', err);
                state.error('The network could not be loaded.', run);
            });
        }
        run();
    }

    document.querySelectorAll('[data-rv="network"]').forEach(init);
})();
