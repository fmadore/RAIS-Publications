/**
 * window.RV — the small subset of DREVisualizations' dashboard-core.js
 * (ns.* helpers) that the ported semantic-map and entity-graph renderers
 * call, re-implemented for a static site with no Omeka behind it, plus the
 * page plumbing every visualisation shares: ?theme=, embed detection, the
 * iframe auto-resize reporter, data loading and the publication list.
 *
 * Copyright (C) the DREVisualizations authors and contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
    'use strict';

    var ns = window.RV = window.RV || {};
    var root = document.documentElement;
    ns.params = new URLSearchParams(window.location.search);

    /* ------------------------------------------------------------------ */
    /*  Page mode: theme, embed, controls                                  */
    /* ------------------------------------------------------------------ */

    var theme = (ns.params.get('theme') || '').toLowerCase();
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    var inFrame = false;
    try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
    ns.embedded = inFrame || ns.params.get('embed') === '1';
    if (ns.embedded) root.classList.add('is-embedded');
    if (ns.params.get('controls') === '0') root.classList.add('no-controls');
    if (ns.params.get('header') === '0') root.classList.add('is-bare');

    var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function isDark() {
        var forced = root.getAttribute('data-theme');
        if (forced) return forced === 'dark';
        return !!(darkQuery && darkQuery.matches);
    }

    /* ------------------------------------------------------------------ */
    /*  Theme tokens, resolved to concrete colours for canvas renderers    */
    /* ------------------------------------------------------------------ */

    ns.THEME = {};
    ns.COLORS = [];
    ns.HALO = ns.COLORS;
    ns.readTheme = function () {
        var css = getComputedStyle(root);
        function v(name) { return css.getPropertyValue(name).trim(); }
        ns._darkMode = isDark();
        root.classList.toggle('is-dark', ns._darkMode);
        var t = ns.THEME;
        t.bg = v('--bg');
        t.surface = v('--surface');
        t.surface2 = v('--surface-2');
        t.text = v('--text');
        t.textMuted = v('--text-2');
        t.muted = v('--muted');
        t.grid = v('--grid');
        t.border = v('--border');
        t.accent = v('--accent');
        t.fontFamily = v('--font');
        ns.COLORS.length = 0;
        for (var i = 1; i <= 8; i++) ns.COLORS.push(v('--series-' + i));
        return t;
    };
    ns.readTheme();

    var renderers = [];
    /** Re-run `fn` after the theme tokens change (OS light/dark switch). */
    ns.trackRenderer = function (_container, fn) { renderers.push(fn); };
    function onThemeChange() {
        ns.readTheme();
        renderers.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
    }
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', onThemeChange);

    ns.withAlpha = function (color, alpha) {
        var m = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());
        if (!m) return color;
        var n = parseInt(m[1], 16);
        return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
    };
    ns.prefersReducedMotion = function () {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    };

    /* ------------------------------------------------------------------ */
    /*  DOM + text helpers                                                 */
    /* ------------------------------------------------------------------ */

    ns.el = function (tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    };
    ns.setChildren = function (parent, children) {
        while (parent.firstChild) parent.removeChild(parent.firstChild);
        (children || []).forEach(function (child) { if (child) parent.appendChild(child); });
    };
    // English only: the key is kept so the ported renderers read unchanged.
    ns.t = function (_key, fallback) { return fallback; };
    ns.locale = 'en';
    ns.fill = function (template, values) {
        return String(template).replace(/\{(\w+)\}/g, function (all, key) {
            return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : all;
        });
    };
    ns.formatNumber = function (n) { return Number(n).toLocaleString('en'); };
    ns.plural = function (n, _key, one, many, withNumber) {
        var word = n === 1 ? one : many;
        return withNumber ? ns.formatNumber(n) + ' ' + word : word;
    };
    ns.fold = function (text) {
        return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    };
    ns.escapeHtml = function (text) {
        return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };
    ns.truncateLabel = function (text, max) {
        text = String(text || '');
        return text.length > max ? text.slice(0, max - 1) + '…' : text;
    };

    ns.ICONS = {
        reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
        save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
        csv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>'
    };
    ns.iconButton = function (svg, label, title) {
        var b = ns.el('button', 'btn btn-icon');
        b.type = 'button';
        b.innerHTML = svg;
        b.setAttribute('aria-label', label);
        b.title = title || label;
        return b;
    };

    /** Shared arrow-key walk (DREVisualizations core/graph-walk.js). */
    ns.graphStep = function (key, order, focus, walk, neighbours) {
        var at = focus == null ? -1 : order.indexOf(focus);
        var dir;
        if (key === 'ArrowRight' || key === 'ArrowLeft') {
            dir = key === 'ArrowRight' ? 1 : -1;
            walk.hub = order[(at + dir + order.length) % order.length];
            walk.cursor = -1;
            return walk.hub;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            dir = key === 'ArrowDown' ? 1 : -1;
            if (walk.hub == null) walk.hub = focus == null ? order[0] : focus;
            var nb = neighbours(walk.hub);
            if (!nb.length) {
                walk.hub = order[(at + dir + order.length) % order.length];
                return walk.hub;
            }
            walk.cursor = (walk.cursor + dir + nb.length) % nb.length;
            return nb[walk.cursor];
        }
        return null;
    };

    /* ------------------------------------------------------------------ */
    /*  Loading                                                            */
    /* ------------------------------------------------------------------ */

    ns.fetchJson = function (path) {
        return fetch(path, { credentials: 'same-origin' }).then(function (response) {
            if (!response.ok) {
                var error = new Error('HTTP ' + response.status + ' for ' + path);
                error.status = response.status;
                throw error;
            }
            return response.json();
        });
    };

    ns.asyncState = function (container) {
        function show(cls, text, retry) {
            var box = ns.el('div', cls, text);
            box.setAttribute('role', 'status');
            if (retry) {
                var b = ns.el('button', 'btn', 'Try again');
                b.type = 'button';
                b.style.marginLeft = '8px';
                b.addEventListener('click', retry);
                box.appendChild(b);
            }
            ns.setChildren(container, [box]);
        }
        return {
            loading: function () { show('rv-loading', 'Loading…'); },
            ready: function () { container.setAttribute('aria-busy', 'false'); },
            empty: function (text) { show('rv-loading', text); },
            unavailable: function (text) { show('rv-error', text); },
            error: function (text, retry) { show('rv-error', text, retry); }
        };
    };

    /** Absolute URL of a file next to the page (glyphs and workers need one). */
    ns.asset = function (path) { return new URL(path, document.baseURI).href; };

    var libPromises = {};
    ns.ensureLibs = function (required) {
        var work = [];
        if (required.maplibre) {
            libPromises.maplibre = libPromises.maplibre || import(ns.asset('vendor/maplibre-gl.js')).then(function (mod) {
                // MapLibre 6 is ESM and defines no global, and the worker is
                // vendored under a .js name, so it is named explicitly.
                window.maplibregl = mod;
                if (typeof mod.setWorkerUrl === 'function') mod.setWorkerUrl(ns.asset('vendor/maplibre-gl-worker.js'));
            });
            work.push(libPromises.maplibre);
        }
        if (required.echarts && typeof window.echarts === 'undefined') {
            work.push(Promise.reject(new Error('ECharts is not loaded')));
        }
        return Promise.all(work);
    };

    /* ------------------------------------------------------------------ */
    /*  ECharts + MapLibre wrappers                                        */
    /* ------------------------------------------------------------------ */

    ns.initChart = function (element) {
        var chart = window.echarts.init(element, null, { renderer: 'canvas' });
        if (window.ResizeObserver) new ResizeObserver(function () { chart.resize(); }).observe(element);
        ns.trackRenderer(element, function () { if (chart._rvRebuild) chart._rvRebuild(); });
        return chart;
    };

    ns.MAP_LABEL_FONT = ['Noto Sans Regular'];
    ns.mapGlyphs = function () { return ns.asset('fonts/') + '{fontstack}/{range}.pbf'; };
    ns.createMap = function (options) { return new window.maplibregl.Map(options); };
    ns.navControl = function () { return new window.maplibregl.NavigationControl({ showCompass: false }); };
    ns.mapPopup = function (options) { return new window.maplibregl.Popup(options); };
    ns.moveHover = function (map, source, previous, next) {
        if (previous != null) map.setFeatureState({ source: source, id: previous }, { hover: false });
        if (next != null) map.setFeatureState({ source: source, id: next }, { hover: true });
        return next;
    };
    ns.mapPng = function (map) {
        try { return map.getCanvas().toDataURL('image/png'); } catch (e) { return null; }
    };

    ns.downloadCsv = function (rows, name) {
        var text = '﻿' + rows.map(function (row) {
            return row.map(function (cell) {
                var s = cell == null ? '' : String(cell);
                return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            }).join(',');
        }).join('\r\n');
        var a = ns.el('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        a.download = name + '.csv';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    };

    ns.copyToClipboard = function (text) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        var ta = ns.el('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        ta.remove();
        return Promise.resolve();
    };

    /* ------------------------------------------------------------------ */
    /*  Embedding: iframe snippet + auto-resize                            */
    /* ------------------------------------------------------------------ */

    // The host-side half of the auto-resize: paste once per page. Guarded, so
    // several snippets on one page install one listener. The escaped <\/script>
    // keeps a copied snippet from closing an inline <script> on the host page.
    /* eslint-disable no-useless-escape */
    ns.embedListener = "<script>(function(){if(window.__raisEmbedResize)return;window.__raisEmbedResize=1;"
        + "window.addEventListener('message',function(e){if(!e.data||e.data.type!=='rais-embed-height')return;"
        + "var f=document.getElementsByTagName('iframe');for(var i=0;i<f.length;i++){"
        + "if(f[i].contentWindow===e.source){f[i].style.height=e.data.height+'px';}}});})();<\/script>";
    /* eslint-enable no-useless-escape */

    ns.embedSnippet = function (src, title, height) {
        var px = Math.max(1, Math.round(Number(height) || 700));
        return '<iframe src="' + ns.escapeHtml(src) + '" title="' + ns.escapeHtml(title || '') + '"'
            + ' loading="lazy" style="width:100%;border:0;height:' + px + 'px"></iframe>\n' + ns.embedListener;
    };

    // The embed's half: post the document height whenever it changes.
    if (inFrame && window.parent) {
        var lastHeight = 0;
        var report = function () {
            var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
            if (Math.abs(height - lastHeight) < 2) return;
            lastHeight = height;
            window.parent.postMessage({ type: 'rais-embed-height', height: height }, '*');
        };
        if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement);
        window.addEventListener('load', report);
        // ResizeObserver only runs with rendering, which a browser pauses in
        // hidden tabs and some offscreen frames; a cheap poll covers those.
        setInterval(report, 1000);
    }

    /* ------------------------------------------------------------------ */
    /*  Publications                                                       */
    /* ------------------------------------------------------------------ */

    /** Load publications.json once and index it. */
    ns.loadPublications = function () {
        ns._pubs = ns._pubs || ns.fetchJson('data/publications.json').then(function (data) {
            data.typeCodes = Object.keys(data.types);
            data.publications.forEach(function (p, i) { p.index = i; });
            ns.data = data;
            return data;
        });
        return ns._pubs;
    };

    /** Fixed colour per type and per topic: by position, never by rank. */
    ns.typeColor = function (code) {
        var i = ns.data.typeCodes.indexOf(code);
        return i < 0 ? ns.THEME.muted : ns.COLORS[i % ns.COLORS.length];
    };
    ns.clusterColor = function (id) {
        return id == null || id < 0 ? ns.THEME.muted : ns.COLORS[id % ns.COLORS.length];
    };
    ns.clusterLabel = function (id) {
        var c = (ns.data.clusters || []).filter(function (x) { return x.id === id; })[0];
        return c ? c.label : 'Topic ' + (id + 1);
    };

    ns.authorNames = function (pub, max) {
        var names = pub.authors.map(function (i) { return ns.data.authors[i].label; });
        if (max && names.length > max) return names.slice(0, max).join('; ') + ' et al.';
        return names.join('; ');
    };

    ns.pubItem = function (pub) {
        var li = ns.el('li');
        var a = ns.el('a', 'pub-title', pub.title);
        a.href = pub.url;
        a.target = '_blank';
        a.rel = 'noopener';
        li.appendChild(a);
        var meta = [ns.authorNames(pub, 4), pub.year, pub.venue, ns.data.types[pub.type]].filter(Boolean);
        li.appendChild(ns.el('div', 'pub-meta', meta.join(' · ')));
        return li;
    };

    /** A list of publications, newest first, `limit` at a time. */
    ns.pubList = function (pubs, limit) {
        limit = limit || 10;
        var wrap = ns.el('div');
        var ul = ns.el('ul', 'pub-list');
        var sorted = pubs.slice().sort(function (a, b) {
            return (b.year || 0) - (a.year || 0) || String(a.title).localeCompare(String(b.title));
        });
        var shown = 0;
        var more = ns.el('button', 'btn pub-more');
        more.type = 'button';
        function grow() {
            sorted.slice(shown, shown + limit).forEach(function (p) { ul.appendChild(ns.pubItem(p)); });
            shown = Math.min(sorted.length, shown + limit);
            more.textContent = 'Show more (' + (sorted.length - shown) + ' left)';
            more.hidden = shown >= sorted.length;
        }
        more.addEventListener('click', grow);
        wrap.appendChild(ul);
        wrap.appendChild(more);
        grow();
        return wrap;
    };
})();
