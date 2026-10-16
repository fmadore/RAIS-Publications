/**
 * Publications dashboard: headline counts, publications per year by type,
 * types, topics, top keywords and top authors, and the matching publication
 * list. Every chart follows the shared facet bar, and clicking a bar sets
 * that facet, so the dashboard doubles as a drill-down.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
    'use strict';

    var ns = window.RV;
    var el = ns.el;
    var TOP = 15;

    function baseOption() {
        var t = ns.THEME;
        return {
            animation: !ns.prefersReducedMotion(),
            animationDuration: 300,
            textStyle: { fontFamily: t.fontFamily, color: t.textMuted },
            aria: { enabled: true },
            tooltip: {
                confine: true,
                backgroundColor: t.surface,
                borderColor: t.border,
                textStyle: { color: t.text }
            }
        };
    }
    function valueAxis() {
        var t = ns.THEME;
        return {
            type: 'value',
            minInterval: 1,
            axisLabel: { color: t.textMuted },
            splitLine: { lineStyle: { color: t.grid, opacity: 0.5 } }
        };
    }
    function categoryAxis(data, horizontal) {
        var t = ns.THEME;
        return {
            type: 'category',
            data: data,
            inverse: !!horizontal,
            axisTick: { show: false },
            axisLine: { lineStyle: { color: t.grid } },
            axisLabel: {
                color: t.text,
                width: horizontal ? 190 : undefined,
                overflow: horizontal ? 'truncate' : undefined
            }
        };
    }
    function counted(items) {
        var counts = {};
        items.forEach(function (key) { counts[key] = (counts[key] || 0) + 1; });
        return counts;
    }

    function chartPanel(title, cls, note) {
        var panel = el('section', 'panel ' + (cls || ''));
        panel.appendChild(el('h2', null, title));
        var box = el('div', 'dash-chart');
        panel.appendChild(box);
        if (note) panel.appendChild(el('p', 'rv-note', note));
        return { panel: panel, box: box };
    }

    function render(container, data) {
        var facetHost = el('div');
        var stats = el('div', 'stat-row');
        var grid = el('div', 'dash-grid');
        ns.setChildren(container, [facetHost, stats, grid]);
        var facets = ns.facets.create(facetHost, data, { embedHeight: 1500 });

        var byYear = chartPanel('Publications per year', 'wide', 'Click a bar to filter to that year.');
        var byType = chartPanel('Publication types');
        var byTopic = data.clusters ? chartPanel('Topics', null, 'Groups of similar publications on the semantic map.') : null;
        var byKeyword = chartPanel('Top keywords');
        var byAuthor = chartPanel('Top authors');
        byKeyword.box.classList.add('tall');
        byAuthor.box.classList.add('tall');
        [byYear, byType, byTopic, byKeyword, byAuthor].forEach(function (c) { if (c) grid.appendChild(c.panel); });
        var listPanel = el('section', 'panel wide');
        var listHead = el('h2');
        var listBody = el('div');
        var csv = el('button', 'btn', 'Download list (CSV)');
        csv.type = 'button';
        listPanel.appendChild(listHead);
        listPanel.appendChild(listBody);
        listPanel.appendChild(csv);
        grid.appendChild(listPanel);

        var charts = {};
        function chart(key, box) { return charts[key] || (charts[key] = ns.initChart(box)); }

        function statTile(value, label) {
            var tile = el('div', 'stat');
            tile.appendChild(el('div', 'v', ns.formatNumber(value)));
            tile.appendChild(el('div', 'l', label));
            return tile;
        }

        function draw() {
            var pubs = facets.filtered();
            var authorSet = {};
            var ubtSet = {};
            var keywordSet = {};
            pubs.forEach(function (p) {
                p.authors.forEach(function (a) { authorSet[a] = 1; if (data.authors[a].ubt) ubtSet[a] = 1; });
                p.keywords.forEach(function (k) { keywordSet[k] = 1; });
            });
            ns.setChildren(stats, [
                statTile(pubs.length, 'Publications'),
                statTile(Object.keys(authorSet).length, 'Authors'),
                statTile(Object.keys(ubtSet).length, 'University of Bayreuth authors'),
                statTile(Object.keys(keywordSet).length, 'Distinct keywords')
            ]);

            /* -- per year, stacked by type -- */
            var yearList = [];
            for (var y = facets.state.from; y <= facets.state.to; y++) yearList.push(y);
            var typeCodes = data.typeCodes.filter(function (code) { return pubs.some(function (p) { return p.type === code; }); });
            var yearOption = baseOption();
            yearOption.tooltip.trigger = 'axis';
            yearOption.tooltip.axisPointer = { type: 'shadow' };
            yearOption.legend = { top: 0, textStyle: { color: ns.THEME.textMuted }, inactiveColor: ns.THEME.grid };
            yearOption.grid = { left: 40, right: 12, top: 48, bottom: 28 };
            yearOption.xAxis = categoryAxis(yearList.map(String));
            yearOption.yAxis = valueAxis();
            yearOption.series = typeCodes.map(function (code, i) {
                return {
                    name: data.types[code],
                    type: 'bar',
                    stack: 'year',
                    barMaxWidth: 48,
                    itemStyle: {
                        color: ns.typeColor(code),
                        borderColor: ns.THEME.surface,
                        borderWidth: 1,
                        borderRadius: i === typeCodes.length - 1 ? [4, 4, 0, 0] : 0
                    },
                    emphasis: { focus: 'series' },
                    data: yearList.map(function (yy) {
                        return pubs.filter(function (p) { return p.year === yy && p.type === code; }).length;
                    })
                };
            });
            var yc = chart('year', byYear.box);
            yc.setOption(yearOption, true);

            /* -- types -- */
            var typeCounts = counted(pubs.map(function (p) { return p.type; }));
            var typeRows = data.typeCodes.filter(function (c) { return typeCounts[c]; })
                .sort(function (a, b) { return typeCounts[b] - typeCounts[a]; });
            horizontalBar(chart('type', byType.box), typeRows.map(function (c) { return data.types[c]; }),
                typeRows.map(function (c) { return { value: typeCounts[c], code: c, itemStyle: { color: ns.typeColor(c) } }; }));

            /* -- topics -- */
            if (byTopic) {
                var topicCounts = counted(pubs.map(function (p) { return p.cluster; }));
                var topics = data.clusters.filter(function (c) { return topicCounts[c.id]; });
                horizontalBar(chart('topic', byTopic.box),
                    topics.map(function (c) { return (c.id + 1) + '. ' + c.label; }),
                    topics.map(function (c) { return { value: topicCounts[c.id], cluster: c.id, itemStyle: { color: ns.clusterColor(c.id) } }; }));
            }

            /* -- keywords -- */
            var kwCounts = {};
            pubs.forEach(function (p) { p.keywords.forEach(function (k) { kwCounts[k] = (kwCounts[k] || 0) + 1; }); });
            var kwTop = Object.keys(kwCounts).map(Number)
                .sort(function (a, b) { return kwCounts[b] - kwCounts[a] || a - b; }).slice(0, TOP);
            horizontalBar(chart('keyword', byKeyword.box), kwTop.map(function (k) { return data.keywords[k].label; }),
                kwTop.map(function (k) { return { value: kwCounts[k], keyword: k, itemStyle: { color: ns.COLORS[0] } }; }));

            /* -- authors, split by affiliation -- */
            var auCounts = {};
            pubs.forEach(function (p) { p.authors.forEach(function (a) { auCounts[a] = (auCounts[a] || 0) + 1; }); });
            var auTop = Object.keys(auCounts).map(Number)
                .sort(function (a, b) { return auCounts[b] - auCounts[a] || data.authors[a].label.localeCompare(data.authors[b].label); })
                .slice(0, TOP);
            var ac = chart('author', byAuthor.box);
            var authorOption = baseOption();
            authorOption.tooltip.trigger = 'item';
            authorOption.legend = { top: 0, textStyle: { color: ns.THEME.textMuted }, inactiveColor: ns.THEME.grid };
            authorOption.grid = { left: 8, right: 24, top: 32, bottom: 8, containLabel: true };
            authorOption.xAxis = valueAxis();
            authorOption.yAxis = categoryAxis(auTop.map(function (a) { return data.authors[a].label; }), true);
            authorOption.series = [['University of Bayreuth', true, 0], ['External', false, 1]].map(function (s) {
                return {
                    name: s[0],
                    type: 'bar',
                    stack: 'a',
                    barMaxWidth: 18,
                    itemStyle: { color: ns.COLORS[s[2]], borderRadius: [0, 4, 4, 0] },
                    data: auTop.map(function (a) {
                        return data.authors[a].ubt === s[1] ? { value: auCounts[a], author: a } : { value: 0, author: a };
                    })
                };
            });
            ac.setOption(authorOption, true);

            /* -- list -- */
            listHead.textContent = 'Publications (' + pubs.length + ')';
            ns.setChildren(listBody, [ns.pubList(pubs, 15)]);
            csv.onclick = function () {
                var rows = [['ERef id', 'Year', 'Type', 'Title', 'Authors', 'Venue', 'DOI', 'Keywords', 'URL']];
                pubs.forEach(function (p) {
                    rows.push([p.id, p.year, data.types[p.type], p.title, ns.authorNames(p), p.venue || '', p.doi || '',
                        p.keywords.map(function (k) { return data.keywords[k].label; }).join('; '), p.url]);
                });
                ns.downloadCsv(rows, 'rais-publications');
            };
        }

        function horizontalBar(c, labels, values) {
            var option = baseOption();
            option.tooltip.trigger = 'item';
            option.tooltip.formatter = function (p) {
                return echarts.format.encodeHTML(p.name) + ': <strong>' + p.value + '</strong>';
            };
            option.grid = { left: 8, right: 24, top: 8, bottom: 8, containLabel: true };
            option.xAxis = valueAxis();
            option.yAxis = categoryAxis(labels, true);
            option.series = [{
                type: 'bar',
                barMaxWidth: 18,
                itemStyle: { borderRadius: [0, 4, 4, 0] },
                label: { show: true, position: 'right', color: ns.THEME.textMuted },
                data: values
            }];
            c.setOption(option, true);
        }

        function wireClicks() {
            charts.year.on('click', function (p) { facets.set({ from: Number(p.name), to: Number(p.name) }); });
            charts.type.on('click', function (p) { facets.set({ types: [p.data.code] }); });
            if (charts.topic) charts.topic.on('click', function (p) { facets.set({ cluster: p.data.cluster }); });
            charts.keyword.on('click', function (p) { facets.set({ keyword: p.data.keyword }); });
            charts.author.on('click', function (p) { if (p.data && p.value) facets.set({ author: p.data.author }); });
        }

        draw();
        wireClicks();
        facets.onChange(draw);
        // One redraw per theme switch repaints every chart.
        charts.year._rvRebuild = draw;
    }

    function init(container) {
        var state = ns.asyncState(container);
        function run() {
            state.loading();
            ns.loadPublications().then(function (data) {
                render(container, data);
                state.ready();
            }).catch(function (error) {
                console.error('dashboard:', error);
                state.error('The dashboard could not be loaded.', run);
            });
        }
        run();
    }

    document.querySelectorAll('[data-rv="dashboard"]').forEach(init);
})();
