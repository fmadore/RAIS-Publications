/**
 * Semantic map of the RAIS publications. Ported from DREVisualizations
 * asset/js/semantic-map.js (the AMIRA "Records by similarity" block): the
 * same ECharts scatter of the precomputed UMAP layout, the same faint
 * series for low-signal records, colour-by control and title search, and
 * the record list as the text alternative. Added here: the shared facet bar
 * (non-matching publications stay on the map as grey context), a detail
 * panel with each publication's nearest neighbours in the embedding space,
 * and ?color=type|cluster.
 *
 * Copyright (C) the DREVisualizations authors and contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
    'use strict';

    var ns = window.RV;
    if (!ns) return;
    var node = ns.el;

    function groupKey(item, mode) { return mode === 'cluster' ? String(item.cluster) : item.type; }

    function groupOrder(mode) {
        return mode === 'cluster'
            ? ns.data.clusters.map(function (c) { return String(c.id); })
            : ns.data.typeCodes.slice();
    }
    function groupName(key, mode) {
        return mode === 'cluster' ? (Number(key) + 1) + '. ' + ns.clusterLabel(Number(key)) : ns.data.types[key];
    }
    function groupColor(key, mode) {
        return mode === 'cluster' ? ns.clusterColor(Number(key)) : ns.typeColor(key);
    }

    function point(item, faint) {
        return { value: [item.x, item.y], index: item.index, lowSignal: faint };
    }

    function seriesFor(items, mode, selected) {
        var series = [];
        var groups = {};
        var rest = [];
        items.forEach(function (item) {
            if (!item.matches) { rest.push(item); return; }
            var key = groupKey(item, mode);
            (groups[key] = groups[key] || []).push(item);
        });
        // Context first, so the coloured points draw on top of it.
        if (rest.length) {
            series.push({
                name: 'Outside the current filter',
                type: 'scatter',
                symbolSize: 6,
                itemStyle: { color: ns.THEME.muted, opacity: 0.22 },
                emphasis: { disabled: true },
                data: rest.map(function (item) { return point(item, false); })
            });
        }
        groupOrder(mode).forEach(function (key) {
            var rows = groups[key];
            if (!rows) return;
            var name = groupName(key, mode);
            var color = groupColor(key, mode);
            // Faint low-signal points get a series of their own (a per-point
            // opacity would be lost past largeThreshold); both share the
            // group's name, so the legend toggles them as one.
            [false, true].forEach(function (faint) {
                var subset = rows.filter(function (item) { return !!item.lowSignal === faint; });
                if (!subset.length) return;
                series.push({
                    name: name,
                    type: 'scatter',
                    symbolSize: 10,
                    itemStyle: { color: color, opacity: faint ? 0.3 : 0.85, borderColor: ns.THEME.surface, borderWidth: 1 },
                    emphasis: { focus: 'series', scale: 1.5 },
                    data: subset.map(function (item) { return point(item, faint); })
                });
            });
        });
        if (selected) {
            series.push({
                name: '__selected',
                type: 'scatter',
                symbolSize: 20,
                silent: true,
                z: 10,
                itemStyle: { color: 'transparent', borderColor: ns.THEME.text, borderWidth: 2.5 },
                data: [point(selected, false)]
            });
        }
        return series;
    }

    function legendData(items, mode) {
        var present = {};
        var context = false;
        items.forEach(function (item) {
            if (item.matches) present[groupKey(item, mode)] = true; else context = true;
        });
        var names = groupOrder(mode).filter(function (k) { return present[k]; })
            .map(function (k) { return groupName(k, mode); });
        if (context) names.push('Outside the current filter');
        return names;
    }

    function option(items, mode, selected) {
        return {
            animation: !ns.prefersReducedMotion(),
            animationDuration: 300,
            textStyle: { fontFamily: ns.THEME.fontFamily },
            tooltip: {
                trigger: 'item',
                confine: true,
                backgroundColor: ns.THEME.surface,
                borderColor: ns.THEME.border,
                textStyle: { color: ns.THEME.text },
                formatter: function (params) {
                    var pub = ns.data.publications[params.data && params.data.index];
                    if (!pub) return '';
                    var meta = [ns.data.types[pub.type], pub.year].filter(Boolean).join(' · ');
                    return '<strong>' + echarts.format.encodeHTML(ns.truncateLabel(pub.title, 120)) + '</strong><br>'
                        + echarts.format.encodeHTML(ns.authorNames(pub, 3)) + '<br>'
                        + '<span style="opacity:.75">' + echarts.format.encodeHTML(meta) + '</span>';
                }
            },
            // The container has a concise image description; ECharts' own
            // label enumerates every value.
            aria: { enabled: false },
            legend: {
                type: 'scroll',
                bottom: 0,
                left: 'center',
                data: legendData(items, mode),
                textStyle: { color: ns.THEME.textMuted, fontFamily: ns.THEME.fontFamily },
                pageTextStyle: { color: ns.THEME.textMuted },
                inactiveColor: ns.THEME.grid
            },
            grid: { left: 12, right: 12, top: 12, bottom: 56 },
            xAxis: { type: 'value', show: false, scale: true },
            yAxis: { type: 'value', show: false, scale: true },
            dataZoom: [
                { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseMove: true },
                { type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseMove: true }
            ],
            series: seriesFor(items, mode, selected)
        };
    }

    function modeControl(getMode, setMode) {
        var group = node('div', 'rv-group');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Colour by');
        group.appendChild(node('span', null, 'Colour by'));
        var buttons = {};
        [['type', 'Publication type'], ['cluster', 'Topic']].forEach(function (config) {
            var button = node('button', 'btn', config[1]);
            button.type = 'button';
            button.setAttribute('aria-pressed', config[0] === getMode() ? 'true' : 'false');
            button.addEventListener('click', function () {
                if (getMode() === config[0]) return;
                setMode(config[0]);
                Object.keys(buttons).forEach(function (k) {
                    buttons[k].setAttribute('aria-pressed', k === config[0] ? 'true' : 'false');
                });
            });
            buttons[config[0]] = button;
            group.appendChild(button);
        });
        return group;
    }

    function searchControl(items, onPick) {
        var wrap = node('div', 'search');
        var input = node('input');
        input.type = 'search';
        input.placeholder = 'Find a publication by title…';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Find a publication on the map');
        var results = node('div', 'search-results');
        results.hidden = true;
        results.setAttribute('role', 'listbox');
        wrap.appendChild(input);
        wrap.appendChild(results);
        var active = -1;
        function hits() { return Array.prototype.slice.call(results.querySelectorAll('.search-hit')); }
        function paint() {
            hits().forEach(function (h, i) { h.classList.toggle('is-active', i === active); h.setAttribute('aria-selected', String(i === active)); });
        }
        function pick(hit) {
            results.hidden = true;
            input.value = '';
            onPick(Number(hit.dataset.index));
        }
        input.addEventListener('input', function () {
            var query = ns.fold(input.value.trim());
            ns.setChildren(results);
            active = -1;
            if (query.length < 2) { results.hidden = true; return; }
            items.filter(function (item) {
                return ns.fold(item.title).indexOf(query) !== -1;
            }).slice(0, 8).forEach(function (item) {
                var hit = node('div', 'search-hit');
                hit.setAttribute('role', 'option');
                hit.dataset.index = String(item.index);
                hit.appendChild(node('span', null, ns.truncateLabel(item.title, 70)));
                hit.appendChild(node('span', 'meta', String(item.year || '')));
                hit.addEventListener('mousedown', function (ev) { ev.preventDefault(); pick(hit); });
                results.appendChild(hit);
            });
            results.hidden = !results.childNodes.length;
        });
        input.addEventListener('keydown', function (ev) {
            var list = hits();
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                if (!list.length) return;
                active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
                paint();
                ev.preventDefault();
            } else if (ev.key === 'Enter') {
                var hit = list[active >= 0 ? active : 0];
                if (hit) { pick(hit); ev.preventDefault(); }
            } else if (ev.key === 'Escape') {
                results.hidden = true;
            }
        });
        input.addEventListener('blur', function () { results.hidden = true; });
        return wrap;
    }

    /**
     * The map's text alternative: every matching publication, grouped like
     * the colours, as a link. Built on open and rebuilt on facet changes.
     */
    function recordList(getItems, getMode) {
        var details = node('details', 'rv-list');
        details.appendChild(node('summary', null, 'List of the publications on the map'));
        function rebuild() {
            while (details.childNodes.length > 1) details.removeChild(details.lastChild);
            var mode = getMode();
            var groups = {};
            getItems().forEach(function (item) {
                if (!item.matches) return;
                (groups[groupKey(item, mode)] = groups[groupKey(item, mode)] || []).push(item);
            });
            var wrap = node('div', 'rv-list-scroll');
            wrap.tabIndex = 0;
            groupOrder(mode).forEach(function (key) {
                if (!groups[key]) return;
                var head = node('h4');
                var sw = node('span', 'swatch');
                sw.style.background = groupColor(key, mode);
                head.appendChild(sw);
                head.appendChild(node('span', null, groupName(key, mode) + ' (' + groups[key].length + ')'));
                wrap.appendChild(head);
                var list = node('ul');
                groups[key].sort(function (a, b) { return String(a.title).localeCompare(String(b.title), 'en'); })
                    .forEach(function (item) {
                        var li = node('li');
                        var link = node('a', '', item.title);
                        link.href = item.url;
                        link.target = '_blank';
                        link.rel = 'noopener';
                        li.appendChild(link);
                        li.appendChild(node('span', 'rv-list-meta', ' — ' + (item.year || '')));
                        list.appendChild(li);
                    });
                wrap.appendChild(list);
            });
            details.appendChild(wrap);
        }
        details.addEventListener('toggle', function () { if (details.open) rebuild(); });
        return { el: details, refresh: function () { if (details.open) rebuild(); } };
    }

    function render(container, data, semantic) {
        var items = data.publications.map(function (pub, i) {
            var p = semantic.points[i];
            return {
                index: i, id: pub.id, url: pub.url, title: pub.title, year: pub.year, type: pub.type,
                x: p[0], y: p[1], cluster: p[2], lowSignal: !!p[3], matches: true
            };
        });
        var mode = ns.params.get('color') === 'cluster' || ns.params.get('color') === 'topic' ? 'cluster' : 'type';
        var selected = null;

        var facetHost = node('div');
        var toolbar = node('div', 'rv-toolbar');
        var stage = node('div', 'stage');
        var panel = node('section', 'panel');
        var chartEl = node('div', 'canvas');
        chartEl.setAttribute('role', 'img');
        chartEl.setAttribute('aria-label', 'Map of the publications. Publications about similar topics appear close to each other.');
        var status = node('p', 'rv-status');
        var note = node('p', 'rv-note',
            'Only the distance between dots matters; the axes have no meaning. Pale dots have little or no '
            + 'abstract and keywords, so their position is less reliable. '
            + (window.matchMedia('(pointer: coarse)').matches ? 'Pinch to zoom; drag to move.' : 'Hold Ctrl and scroll to zoom; drag to move.'));
        panel.appendChild(toolbar);
        panel.appendChild(chartEl);
        panel.appendChild(status);
        panel.appendChild(note);
        var sidebar = node('aside', 'panel sidebar');
        stage.appendChild(panel);
        stage.appendChild(sidebar);
        ns.setChildren(container, [facetHost, stage]);

        var chart = ns.initChart(chartEl);
        function draw(replace) {
            chart.setOption(option(items, mode, selected), replace ? true : { replaceMerge: ['series'] });
        }

        var facets = ns.facets.create(facetHost, data, { embedHeight: 900 });
        var list = recordList(function () { return items; }, function () { return mode; });

        function applyFacets() {
            items.forEach(function (item) { item.matches = facets.matches(data.publications[item.index]); });
            var shown = items.filter(function (item) { return item.matches; });
            var faint = shown.filter(function (item) { return item.lowSignal; }).length;
            status.textContent = ns.plural(shown.length, '', 'publication', 'publications', true) + ' shown'
                + (faint ? ' · ' + faint + ' with little description' : '');
            draw(true);
            list.refresh();
            if (!selected) showOverview();
        }
        facets.onChange(applyFacets);

        function showOverview() {
            ns.setChildren(sidebar);
            sidebar.appendChild(node('div', 'side-title', mode === 'cluster' ? 'Topics' : 'Publication types'));
            var counts = {};
            items.forEach(function (item) { if (item.matches) counts[groupKey(item, mode)] = (counts[groupKey(item, mode)] || 0) + 1; });
            groupOrder(mode).forEach(function (key) {
                if (!counts[key]) return;
                var row = node(mode === 'cluster' ? 'button' : 'div', mode === 'cluster' ? 'neighbour' : 'type-row');
                var sw = node('span', 'swatch');
                sw.style.background = groupColor(key, mode);
                row.appendChild(sw);
                row.appendChild(node('span', 'name', groupName(key, mode)));
                row.appendChild(node('span', mode === 'cluster' ? 'w' : 'type-val', String(counts[key])));
                if (mode === 'cluster') {
                    row.type = 'button';
                    row.title = 'Show only this topic';
                    row.addEventListener('click', function () { facets.set({ cluster: Number(key) }); });
                }
                sidebar.appendChild(row);
            });
            sidebar.appendChild(node('p', 'side-hint', 'Click a dot to see the publication and its nearest neighbours.'));
        }

        // On a phone the side panel stacks under the map, below the fold, so
        // a tap would change nothing visible: bring the panel (or, going
        // back, the map) into view. Redraws pass no `reveal` and never scroll.
        function stacked() { return window.matchMedia('(max-width: 760px)').matches; }
        function bringIntoView(target) {
            var top = target.getBoundingClientRect().top;
            if (top >= 0 && top < window.innerHeight * 0.6) return;
            target.scrollIntoView({ behavior: ns.prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
        }

        function select(index, reveal) {
            selected = index == null ? null : items[index];
            draw(false);
            if (!selected) {
                showOverview();
                if (reveal && stacked()) bringIntoView(panel);
                return;
            }
            var pub = data.publications[index];
            ns.setChildren(sidebar);
            var tag = node('div', 'side-type', data.types[pub.type]);
            tag.style.color = ns.typeColor(pub.type);
            sidebar.appendChild(tag);
            var heading = node('div', 'side-heading');
            var link = node('a', null, pub.title);
            link.href = pub.url;
            link.target = '_blank';
            link.rel = 'noopener';
            heading.appendChild(link);
            sidebar.appendChild(heading);
            sidebar.appendChild(node('div', 'side-stats', [ns.authorNames(pub), pub.year, pub.venue].filter(Boolean).join(' · ')));
            if (pub.cluster != null) {
                var topic = node('button', 'neighbour');
                topic.type = 'button';
                topic.title = 'Show only this topic';
                var sw = node('span', 'swatch');
                sw.style.background = ns.clusterColor(pub.cluster);
                topic.appendChild(sw);
                topic.appendChild(node('span', 'name', 'Topic ' + (pub.cluster + 1) + ': ' + ns.clusterLabel(pub.cluster)));
                topic.addEventListener('click', function () { facets.set({ cluster: pub.cluster }); });
                sidebar.appendChild(topic);
            }
            if (pub.keywords.length) {
                sidebar.appendChild(node('div', 'side-sub', 'Keywords'));
                var chips = node('div', 'chips');
                pub.keywords.forEach(function (k) {
                    var chip = node('button', 'chip', data.keywords[k].label);
                    chip.type = 'button';
                    chip.title = 'Show only publications with this keyword';
                    chip.addEventListener('click', function () { facets.set({ keyword: k }); });
                    chips.appendChild(chip);
                });
                sidebar.appendChild(chips);
            }
            var neighbours = semantic.similar[String(pub.id)] || [];
            sidebar.appendChild(node('div', 'side-sub', 'Most similar publications'));
            if (!neighbours.length) {
                sidebar.appendChild(node('p', 'side-hint', 'This publication has too little description to recommend neighbours.'));
            }
            var byId = {};
            items.forEach(function (item) { byId[item.id] = item; });
            var wrap = node('div', 'neighbours');
            neighbours.forEach(function (pair) {
                var target = byId[pair[0]];
                if (!target) return;
                var b = node('button', 'neighbour');
                b.type = 'button';
                var dot = node('span', 'swatch');
                dot.style.background = mode === 'cluster' ? ns.clusterColor(target.cluster) : ns.typeColor(target.type);
                b.appendChild(dot);
                b.appendChild(node('span', 'name', target.title));
                b.appendChild(node('span', 'w', pair[1].toFixed(2)));
                b.title = target.title + ' (cosine similarity ' + pair[1].toFixed(2) + ')';
                b.addEventListener('click', function () { select(target.index, true); });
                wrap.appendChild(b);
            });
            sidebar.appendChild(wrap);
            var actions = node('div', 'side-actions');
            var open = node('a', 'btn', 'Open in ERef');
            open.href = pub.url;
            open.target = '_blank';
            open.rel = 'noopener';
            open.style.lineHeight = '30px';
            open.style.textDecoration = 'none';
            var back = node('button', 'btn', 'Back to overview');
            back.type = 'button';
            back.addEventListener('click', function () { select(null, true); });
            actions.appendChild(open);
            actions.appendChild(back);
            sidebar.appendChild(actions);
            // After the panel is filled: the page must be tall enough to scroll.
            if (reveal && stacked()) bringIntoView(sidebar);
        }

        chart.on('click', function (params) {
            var index = params.data && params.data.index;
            if (Number.isInteger(index)) select(index, true);
        });
        chart._rvRebuild = function () { draw(true); if (selected) select(selected.index); else showOverview(); };

        toolbar.appendChild(modeControl(function () { return mode; }, function (next) {
            mode = next;
            draw(true);
            list.refresh();
            if (selected) select(selected.index); else showOverview();
        }));
        toolbar.appendChild(searchControl(items, function (index) { select(index, true); }));
        toolbar.appendChild(node('div', 'rv-spacer'));
        var resetBtn = ns.iconButton(ns.ICONS.reset, 'Reset zoom and selection');
        resetBtn.addEventListener('click', function () {
            chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
            select(null);
        });
        toolbar.appendChild(resetBtn);
        var png = ns.iconButton(ns.ICONS.save, 'Save the map as an image');
        png.addEventListener('click', function () {
            var a = node('a');
            a.href = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: ns.THEME.surface });
            a.download = 'rais-semantic-map.png';
            a.click();
        });
        toolbar.appendChild(png);
        panel.appendChild(list.el);
        applyFacets();
    }

    function init(container) {
        var state = ns.asyncState(container);
        function run() {
            state.loading();
            Promise.all([
                ns.loadPublications(),
                ns.fetchJson('data/semantic-map.json')
            ]).then(function (values) {
                var semantic = values[1];
                if (!semantic || semantic.schemaVersion !== 1 || semantic.points.length !== values[0].publications.length) {
                    var schema = new Error('Unsupported semantic map');
                    schema.unavailable = true;
                    throw schema;
                }
                render(container, values[0], semantic);
                state.ready();
            }).catch(function (error) {
                console.error('semantic-map:', error);
                if (error && (error.unavailable || error.status === 404)) {
                    state.unavailable('The semantic map has not been built yet. It is generated with the embedding model on the next scheduled build.');
                } else {
                    state.error('The map could not be loaded.', run);
                }
            });
        }
        run();
    }

    document.querySelectorAll('[data-rv="semantic-map"]').forEach(init);
})();
