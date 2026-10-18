/**
 * The facet bar every page shares: year range, publication type, keyword,
 * author and topic (the semantic-map cluster). The state round-trips through
 * the URL, so a link or an iframe src can preset any facet:
 *
 *   ?year=2023-2025        one year (year=2024) or an inclusive range
 *   ?type=article,preprint ERef type codes (comma-separated) or labels
 *   ?keyword=Explainable AI (XAI)   a keyword label, any case or accents
 *   ?author=Kühl, Niklas   "Family, Given" or "Given Family"
 *   ?cluster=3             topic number as shown in the Topic list (1-based)
 *
 * Page-mode parameters (theme, embed, controls, header, colour) are kept
 * untouched when the facets rewrite the URL.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
    'use strict';

    var ns = window.RV;
    var el = ns.el;

    function resolveLabel(list, value, alternatives) {
        if (!value) return null;
        var q = ns.fold(value).trim();
        for (var i = 0; i < list.length; i++) {
            var forms = alternatives ? alternatives(list[i]) : [list[i].label];
            for (var j = 0; j < forms.length; j++) {
                if (ns.fold(forms[j]) === q) return i;
            }
        }
        return null;
    }
    function keywordForms(keyword) {
        // The label, the label without its "(ACRONYM)", the acronym, and
        // every spelling the build merged into it.
        var forms = [keyword.label].concat(keyword.variants || []);
        var m = /^(.*?)\s*\(([^()]+)\)$/.exec(keyword.label);
        if (m) forms.push(m[1], m[2]);
        return forms;
    }
    function authorForms(author) {
        var parts = author.label.split(', ');
        return parts.length === 2 ? [author.label, parts[1] + ' ' + parts[0]] : [author.label];
    }

    /**
     * @param {HTMLElement} host   where the bar is drawn
     * @param {Object} data        publications.json
     * @param {Object} options     { onChange(state), noun }
     */
    function create(host, data, options) {
        options = options || {};
        var pubs = data.publications;
        var years = pubs.map(function (p) { return p.year; }).filter(Boolean);
        var minYear = Math.min.apply(null, years);
        var maxYear = Math.max.apply(null, years);
        var hasClusters = !!(data.clusters && data.clusters.length);
        var listeners = [];
        if (options.onChange) listeners.push(options.onChange);

        var state = { from: minYear, to: maxYear, types: [], keyword: null, author: null, cluster: null };

        /* -- read the URL -- */
        var params = ns.params;
        var year = params.get('year') || params.get('years');
        if (year) {
            var m = /^(\d{4})(?:\s*[-–:]\s*(\d{4}))?$/.exec(year.trim());
            if (m) {
                state.from = Math.max(minYear, Math.min(Number(m[1]), maxYear));
                state.to = Math.max(state.from, Math.min(Number(m[2] || m[1]), maxYear));
            }
        }
        (params.get('type') || '').split(',').forEach(function (value) {
            value = value.trim();
            if (!value) return;
            var code = data.typeCodes.filter(function (c) {
                return c === value.toLowerCase() || ns.fold(data.types[c]) === ns.fold(value);
            })[0];
            if (code && state.types.indexOf(code) === -1) state.types.push(code);
        });
        state.keyword = resolveLabel(data.keywords, params.get('keyword'), keywordForms);
        state.author = resolveLabel(data.authors, params.get('author'), authorForms);
        var cluster = params.get('cluster') || params.get('topic');
        if (hasClusters && cluster) {
            var n = Number(cluster);
            if (Number.isInteger(n) && n >= 1 && n <= data.clusters.length) state.cluster = n - 1;
            else {
                var byLabel = resolveLabel(data.clusters, cluster);
                if (byLabel != null) state.cluster = data.clusters[byLabel].id;
            }
        }

        function matches(p) {
            if (p.year && (p.year < state.from || p.year > state.to)) return false;
            if (state.types.length && state.types.indexOf(p.type) === -1) return false;
            if (state.keyword != null && p.keywords.indexOf(state.keyword) === -1) return false;
            if (state.author != null && p.authors.indexOf(state.author) === -1) return false;
            if (state.cluster != null && p.cluster !== state.cluster) return false;
            return true;
        }
        function active() {
            return state.from !== minYear || state.to !== maxYear || state.types.length > 0
                || state.keyword != null || state.author != null || state.cluster != null;
        }
        function writeUrl() {
            var out = new URLSearchParams(window.location.search);
            ['year', 'years', 'type', 'keyword', 'author', 'cluster', 'topic'].forEach(function (k) { out.delete(k); });
            if (state.from !== minYear || state.to !== maxYear) {
                out.set('year', state.from === state.to ? String(state.from) : state.from + '-' + state.to);
            }
            if (state.types.length) out.set('type', state.types.join(','));
            if (state.keyword != null) out.set('keyword', data.keywords[state.keyword].label);
            if (state.author != null) out.set('author', data.authors[state.author].label);
            if (state.cluster != null) out.set('cluster', String(state.cluster + 1));
            var qs = out.toString();
            try {
                window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
            } catch (e) { /* sandboxed frame */ }
        }

        /* -- draw the bar -- */
        var bar = el('form', 'facets');
        bar.setAttribute('role', 'search');
        bar.setAttribute('aria-label', 'Filter the publications');
        bar.addEventListener('submit', function (ev) { ev.preventDefault(); });

        function field(label, control) {
            var wrap = el('label', 'facet');
            wrap.appendChild(el('span', null, label));
            wrap.appendChild(control);
            return wrap;
        }
        function yearSelect(value, label) {
            var s = el('select');
            s.setAttribute('aria-label', label);
            for (var y = minYear; y <= maxYear; y++) {
                var o = el('option', null, String(y));
                o.value = String(y);
                s.appendChild(o);
            }
            s.value = String(value);
            return s;
        }

        var yearsWrap = el('div', 'facet');
        yearsWrap.appendChild(el('span', null, 'Years'));
        var yearRow = el('div', 'facet-years');
        var fromSel = yearSelect(state.from, 'From year');
        var toSel = yearSelect(state.to, 'To year');
        yearRow.appendChild(fromSel);
        yearRow.appendChild(el('span', null, '–'));
        yearRow.appendChild(toSel);
        yearsWrap.appendChild(yearRow);
        bar.appendChild(yearsWrap);

        var typeSel = el('select');
        function fillTypes() {
            ns.setChildren(typeSel);
            var all = el('option', null, 'All types');
            all.value = '';
            typeSel.appendChild(all);
            if (state.types.length > 1) {
                var multi = el('option', null, state.types.length + ' types');
                multi.value = '*';
                typeSel.appendChild(multi);
            }
            data.typeCodes.forEach(function (code) {
                var count = pubs.filter(function (p) { return p.type === code; }).length;
                var o = el('option', null, data.types[code] + ' (' + count + ')');
                o.value = code;
                typeSel.appendChild(o);
            });
            typeSel.value = state.types.length > 1 ? '*' : (state.types[0] || '');
        }
        fillTypes();
        bar.appendChild(field('Type', typeSel));

        var listSeq = ns._facetSeq = (ns._facetSeq || 0) + 1;
        function datalistInput(id, items, value, placeholder) {
            var input = el('input');
            input.type = 'search';
            input.placeholder = placeholder;
            input.autocomplete = 'off';
            input.setAttribute('list', id);
            var list = el('datalist');
            list.id = id;
            items.forEach(function (item) {
                var o = el('option');
                o.value = item.label;
                o.label = item.count + (item.count === 1 ? ' publication' : ' publications');
                list.appendChild(o);
            });
            input.value = value == null ? '' : items[value].label;
            bar.appendChild(list);
            return input;
        }
        var keywordInput = datalistInput('facet-kw-' + listSeq, data.keywords, state.keyword, 'Any keyword');
        bar.appendChild(field('Keyword', keywordInput));
        var authorInput = datalistInput('facet-au-' + listSeq, data.authors, state.author, 'Any author');
        bar.appendChild(field('Author', authorInput));

        var clusterSel = null;
        if (hasClusters) {
            clusterSel = el('select');
            var any = el('option', null, 'All topics');
            any.value = '';
            clusterSel.appendChild(any);
            data.clusters.forEach(function (c) {
                var o = el('option', null, (c.id + 1) + '. ' + ns.truncateLabel(c.label, 48) + ' (' + c.size + ')');
                o.value = String(c.id);
                clusterSel.appendChild(o);
            });
            clusterSel.value = state.cluster == null ? '' : String(state.cluster);
            var topicField = field('Topic', clusterSel);
            topicField.title = 'Groups of similar publications on the semantic map, named after their most distinctive keywords';
            bar.appendChild(topicField);
        }

        var actions = el('div', 'facet-actions');
        var count = el('span', 'facet-count');
        count.setAttribute('aria-live', 'polite');
        var reset = el('button', 'btn', 'Reset');
        reset.type = 'button';
        var embed = el('button', 'btn', 'Copy embed code');
        embed.type = 'button';
        embed.title = 'Copy an iframe snippet for this view, with the current filters';
        actions.appendChild(count);
        actions.appendChild(reset);
        actions.appendChild(embed);
        var fullscreen = ns.fullscreenButton();
        if (fullscreen) actions.appendChild(fullscreen);
        bar.appendChild(actions);
        host.appendChild(bar);

        function sync() {
            fromSel.value = String(state.from);
            toSel.value = String(state.to);
            fillTypes();
            keywordInput.value = state.keyword == null ? '' : data.keywords[state.keyword].label;
            authorInput.value = state.author == null ? '' : data.authors[state.author].label;
            if (clusterSel) clusterSel.value = state.cluster == null ? '' : String(state.cluster);
        }
        function changed() {
            writeUrl();
            var n = pubs.filter(matches).length;
            count.textContent = n === pubs.length
                ? ns.plural(n, '', 'publication', 'publications', true)
                : n + ' of ' + ns.plural(pubs.length, '', 'publication', 'publications', true);
            reset.disabled = !active();
            listeners.forEach(function (fn) { fn(api); });
        }

        fromSel.addEventListener('change', function () {
            state.from = Number(fromSel.value);
            if (state.to < state.from) state.to = state.from;
            sync();
            changed();
        });
        toSel.addEventListener('change', function () {
            state.to = Number(toSel.value);
            if (state.from > state.to) state.from = state.to;
            sync();
            changed();
        });
        typeSel.addEventListener('change', function () {
            if (typeSel.value === '*') return;
            state.types = typeSel.value ? [typeSel.value] : [];
            sync();
            changed();
        });
        function wireLookup(input, list, key, alternatives) {
            function commit() {
                var value = input.value.trim();
                var index = value ? resolveLabel(list, value, alternatives) : null;
                input.setAttribute('aria-invalid', value && index == null ? 'true' : 'false');
                input.style.borderColor = value && index == null ? ns.COLORS[7] : '';
                if (value && index == null) return;
                if (state[key] === index) return;
                state[key] = index;
                changed();
            }
            input.addEventListener('change', commit);
            // Picking a datalist entry fires `input` with the full value.
            input.addEventListener('input', function () {
                if (resolveLabel(list, input.value, alternatives) != null || input.value === '') commit();
            });
        }
        wireLookup(keywordInput, data.keywords, 'keyword', keywordForms);
        wireLookup(authorInput, data.authors, 'author', authorForms);
        if (clusterSel) {
            clusterSel.addEventListener('change', function () {
                state.cluster = clusterSel.value === '' ? null : Number(clusterSel.value);
                changed();
            });
        }
        reset.addEventListener('click', function () {
            state.from = minYear;
            state.to = maxYear;
            state.types = [];
            state.keyword = state.author = state.cluster = null;
            sync();
            changed();
        });
        embed.addEventListener('click', function () {
            var url = new URL(window.location.href);
            url.searchParams.delete('embed');
            var snippet = ns.embedSnippet(url.href, document.title, options.embedHeight || 900);
            ns.copyToClipboard(snippet).then(function () {
                embed.textContent = 'Copied';
                setTimeout(function () { embed.textContent = 'Copy embed code'; }, 2000);
            });
        });

        var api = {
            state: state,
            matches: matches,
            active: active,
            /** Publications matching every facet. */
            filtered: function () { return pubs.filter(matches); },
            /** Set facets programmatically, e.g. from a chart click. */
            set: function (patch) {
                Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
                if (state.from > state.to) state.to = state.from;
                sync();
                changed();
            },
            onChange: function (fn) { listeners.push(fn); }
        };
        // First count, without notifying: pages render after create().
        var initial = listeners;
        listeners = [];
        changed();
        listeners = initial;
        return api;
    }

    ns.facets = { create: create };
})();
