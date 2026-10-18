/**
 * Network chrome — the keyboard walker and its live region, the search
 * combobox keys, the group filter, the export buttons and the text
 * alternative. Ported from DREVisualizations asset/js/entity-graph-ui.js;
 * it only talks back through the hooks it is handed and knows nothing about
 * MapLibre. (Its fullscreen control is not ported: the facet bar's
 * page-wide button, RV.fullscreenButton, replaces it.)
 *
 * Copyright (C) the DREVisualizations authors and contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
    'use strict';

    var ns = window.RV;
    var el = ns.el;
    var ICON = ns.ICONS;

    /**
     * Arrow keys run the walk every DRE graph shares (ns.graphStep):
     * left/right step through the nodes and set the "hub", up/down walk that
     * hub's neighbours. Enter selects, +/- zoom, 0 fits, Escape clears.
     */
    function attachKeyboard(host, spec) {
        var status = el('p', 'graph-status');
        status.setAttribute('aria-live', 'polite');
        host.appendChild(status);

        var focusIdx = null;
        var walk = { hub: null, cursor: -1 };

        function announce(text) { status.textContent = text || ''; }
        function moveTo(i) {
            focusIdx = i;
            spec.onFocus(i);
            announce(spec.describe(i));
        }
        function clear() {
            focusIdx = null;
            walk.hub = null;
            walk.cursor = -1;
            announce('');
        }

        host.addEventListener('keydown', function (ev) {
            if (ev.target !== host && ev.target.closest && ev.target.closest('.maplibregl-ctrl')) return;
            var order = spec.order();
            if (!order.length) return;
            var next = ns.graphStep(ev.key, order, focusIdx, walk, spec.neighbours);
            if (next != null) { moveTo(next); ev.preventDefault(); return; }
            if (ev.key === 'Enter' || ev.key === ' ') {
                if (focusIdx != null) { spec.onActivate(focusIdx); ev.preventDefault(); }
            } else if (ev.key === '+' || ev.key === '=') {
                spec.onZoom(1); ev.preventDefault();
            } else if (ev.key === '-' || ev.key === '_') {
                spec.onZoom(-1); ev.preventDefault();
            } else if (ev.key === '0') {
                spec.onFit(); ev.preventDefault();
            } else if (ev.key === 'Escape') {
                if (spec.onEscape()) { ev.stopPropagation(); return; }
                if (focusIdx != null) { clear(); spec.onFocus(null); ev.stopPropagation(); }
            }
        });
        host.addEventListener('blur', function () {
            if (focusIdx == null) return;
            clear();
            spec.onFocus(null);
        });
        return {
            focused: function () { return focusIdx; },
            clear: function () { clear(); spec.onFocus(null); },
            announce: announce
        };
    }

    /** A real combobox: arrow through the hits, Enter takes one. */
    function wireSearchKeys(input, results, spec) {
        var listId = 'graph-search-list-' + (ns._searchSeq = (ns._searchSeq || 0) + 1);
        results.id = listId;
        results.setAttribute('role', 'listbox');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-controls', listId);
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        var active = -1;

        function paint() {
            var hits = spec.hits();
            hits.forEach(function (hit, i) {
                var on = i === active;
                hit.classList.toggle('is-active', on);
                hit.setAttribute('aria-selected', String(on));
            });
            if (active >= 0 && hits[active]) {
                input.setAttribute('aria-activedescendant', hits[active].id);
                if (hits[active].scrollIntoView) hits[active].scrollIntoView({ block: 'nearest' });
            } else {
                input.removeAttribute('aria-activedescendant');
            }
        }
        function reset() {
            active = -1;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }
        function sync() {
            active = -1;
            input.setAttribute('aria-expanded', String(!results.hidden));
            paint();
        }
        input.addEventListener('keydown', function (ev) {
            var hits = spec.hits();
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                if (!hits.length) return;
                active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
                paint();
                ev.preventDefault();
            } else if (ev.key === 'Enter') {
                var pick = active >= 0 ? hits[active] : hits[0];
                if (pick) { spec.onPick(pick); ev.preventDefault(); }
            } else if (ev.key === 'Escape') {
                if (!results.hidden) { spec.onClose(); reset(); ev.stopPropagation(); }
            }
        });
        input.parentNode.addEventListener('focusout', function (ev) {
            if (ev.relatedTarget && input.parentNode.contains(ev.relatedTarget)) return;
            spec.onClose();
            reset();
        });
        return { reset: reset, sync: sync };
    }

    /** Isolate one Louvain group, each named by its most central member. */
    function buildClusterSelect(clusters, onChange) {
        var wrap = el('label', 'select-label');
        wrap.appendChild(el('span', null, 'Group'));
        var sel = el('select');
        var all = el('option', null, 'All groups');
        all.value = '';
        sel.appendChild(all);
        clusters.forEach(function (c) {
            var name = c.anchor ? (c.anchor + ' (' + c.size + ')') : ('Group ' + (c.id + 1) + ' (' + c.size + ')');
            var o = el('option', null, ns.truncateLabel(name, 34));
            o.value = String(c.id);
            sel.appendChild(o);
        });
        sel.addEventListener('change', function () { onChange(sel.value === '' ? null : Number(sel.value)); });
        wrap.appendChild(sel);
        return { el: wrap, reset: function () { sel.value = ''; }, set: function (id) { sel.value = id == null ? '' : String(id); } };
    }

    /** PNG of the canvas, CSV of the visible node table. */
    function buildExportButtons(spec) {
        var png = ns.iconButton(ICON.save, 'Save this network as an image');
        png.addEventListener('click', function () {
            var url = spec.png();
            if (!url) return;
            var a = el('a');
            a.href = url;
            a.download = spec.name + '.png';
            a.click();
        });
        var csv = ns.iconButton(ICON.csv, 'Download the visible nodes (CSV)');
        csv.addEventListener('click', function () { ns.downloadCsv(spec.rows(), spec.name); });
        return [png, csv];
    }

    /** Every visible node as text, grouped — rebuilt on each open/filter. */
    function buildListPanel(spec) {
        var details = el('details', 'rv-list');
        details.appendChild(el('summary', null, spec.summary || 'See this network as a list'));
        function rebuild() {
            while (details.childNodes.length > 1) details.removeChild(details.lastChild);
            var groups = spec.groups();
            var wrap = el('div', 'rv-list-scroll');
            wrap.tabIndex = 0;
            if (!groups.length) wrap.appendChild(el('p', 'rv-list-meta', 'Nothing to show'));
            groups.forEach(function (group) {
                var head = el('h4');
                var sw = el('span', 'swatch');
                sw.style.background = group.color;
                head.appendChild(sw);
                head.appendChild(el('span', null, group.name + ' (' + group.rows.length + ')'));
                wrap.appendChild(head);
                var ul = el('ul');
                group.rows.forEach(function (row) {
                    var li = el('li');
                    li.appendChild(el('span', null, row.label));
                    if (row.meta) li.appendChild(el('span', 'rv-list-meta', ' — ' + row.meta));
                    ul.appendChild(li);
                });
                wrap.appendChild(ul);
            });
            details.appendChild(wrap);
        }
        details.addEventListener('toggle', function () { if (details.open) rebuild(); });
        return { el: details, refresh: function () { if (details.open) rebuild(); } };
    }

    ns.egUI = {
        attachKeyboard: attachKeyboard,
        wireSearchKeys: wireSearchKeys,
        buildClusterSelect: buildClusterSelect,
        buildExportButtons: buildExportButtons,
        buildListPanel: buildListPanel
    };
})();
