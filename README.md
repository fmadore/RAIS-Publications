# RAIS publications

Static, embeddable visualisations of the RAIS publications recorded in
[ERef Bayreuth](https://eref.uni-bayreuth.de/) (division 310022). A Python
pipeline turns the ERef EP3 XML export into JSON, and four standalone pages
draw it:

| Page | What it shows |
|---|---|
| `semantic-map.html` | Publications placed by what their title, keywords and abstract say (EmbeddingGemma 2 + UMAP), coloured by type or topic (k-means), with each publication's nearest neighbours |
| `keyword-network.html` | Author keywords linked when they appear on the same publication, with Louvain groups |
| `coauthor-network.html` | Authors linked by joint publications, coloured by University of Bayreuth affiliation or group |
| `dashboard.html` | Publications per year by type, types, topics, top keywords and authors, and the filtered list |

Every page has the same facet bar (years, type, keyword, author, topic), which
can be preset from the URL. Each page works on its own in an iframe, and the
iframe resizes to fit its content. There is no server and no database, and the
pages make no third-party requests: ECharts, MapLibre and the label font are
hosted with the site.

The AMIRA versions of the semantic map and the entity network live in the
DREVisualizations Omeka S module and read Omeka. This repository ports those
renderers to a site that reads static JSON instead.

## Embedding

Copy the snippet from the overview page (`index.html` → *Embed a
visualisation*), or click *Copy embed code* on any page to capture its current
filters. A snippet is the iframe plus a short script that resizes it:

```html
<iframe src="https://PAGES-URL/semantic-map.html?year=2024-2026&theme=light"
        title="Semantic map · RAIS publications" loading="lazy"
        style="width:100%;border:0;height:900px"></iframe>
<script>(function(){if(window.__raisEmbedResize)return;window.__raisEmbedResize=1;window.addEventListener('message',function(e){if(!e.data||e.data.type!=='rais-embed-height')return;var f=document.getElementsByTagName('iframe');for(var i=0;i<f.length;i++){if(f[i].contentWindow===e.source){f[i].style.height=e.data.height+'px';}}});})();</script>
```

```html
<iframe src="https://PAGES-URL/keyword-network.html?keyword=Explainable%20AI%20(XAI)&header=0"
        title="Keyword network · RAIS publications" loading="lazy"
        style="width:100%;border:0;height:960px"></iframe>
```

```html
<iframe src="https://PAGES-URL/coauthor-network.html?author=K%C3%BChl%2C%20Niklas&color=group"
        title="Co-author network · RAIS publications" loading="lazy"
        style="width:100%;border:0;height:960px"></iframe>
```

```html
<iframe src="https://PAGES-URL/dashboard.html?type=article,book_section"
        title="Publications dashboard · RAIS publications" loading="lazy"
        style="width:100%;border:0;height:1500px"></iframe>
```

Paste the `<script>` once per host page, even when it holds several iframes.
Without it, an iframe keeps the fixed height given in its `style`.

### URL parameters

| Parameter | Effect |
|---|---|
| `year=2024` or `year=2023-2025` | Year or inclusive range |
| `type=article,preprint` | ERef type codes (`article`, `book_section`, `conference_item`, `working_paper`, `preprint`, `online`, `report`, `thesis`) or their labels |
| `keyword=…` | A keyword label, or any spelling merged into it (`xai`, `explainable ai`, …) |
| `author=…` | `Family, Given` or `Given Family`; case and accents are ignored |
| `cluster=3` | Topic number as listed in the Topic filter (1-based); `topic=` also works |
| `color=type` / `color=cluster` | Semantic map colouring |
| `color=type` / `color=group` | Network colouring |
| `select=…` | Networks: open with this keyword or author selected |
| `theme=light` / `theme=dark` | Force a theme (default: follow the visitor's system setting) |
| `header=0` | Hide the page title and introduction |
| `controls=0` | Hide the facet bar and toolbars (a fixed view) |
| `embed=1` | Embedded layout outside an iframe (set automatically inside one) |

## Running locally

Python 3.12 or later (CI uses 3.13).

```bash
python -m venv .venv
```

```bash
.venv/Scripts/python -m pip install -r requirements-model.txt -r requirements-dev.txt
```

```bash
.venv/Scripts/python -m rais build
```

```bash
.venv/Scripts/python -m http.server 8000 --directory dist
```

Then open <http://localhost:8000/>. (On Linux/macOS the venv path is
`.venv/bin/python`.)

`build` fetches the feed into `build/raw/`, embeds the publications (the model
downloads from Hugging Face on first use; about 1.5 GB) and writes `dist/`.
The first run embeds all 196 publications in a few minutes on a CPU. Later runs
reuse `build/cache/embeddings.json` and only embed new or edited records.

- `--offline` reuses the last downloaded feed.
- `--input FILE.xml` reads a local export.
- `--skip-embeddings` builds without the model stack (`requirements.txt`
  only): no semantic map and no topic filter.
- `--out DIR` writes elsewhere (CI writes `public/`).

Checks: `pytest`, `ruff check .`, `ruff format --check .`.

## Pipeline

1. **Fetch** (`rais/ep3.py`): the EP3 export for division 310022. Parsing
   follows MongoDB2OmekaS `clients/publications/ep3.py`: abstracts from
   `abstract_original`/`abstract_translated` with their language, keywords
   split on `,` and `;`, and creators with their GND id and the ERef `ubt` flag.
2. **Normalise** (`rais/normalise.py`).
   - Keywords are compared case-, accent- and hyphen-insensitively, a
     trailing `(ACRONYM)` is ignored, and a plural joins its singular when
     both occur. [`config/keyword_aliases.json`](config/keyword_aliases.json)
     merges the remaining variants (XAI, LLMs, AI, GenAI, HCI…) and drops
     genre words (essay, workshop…). Edit it and rebuild; each label's
     merged spellings are listed in `dist/data/report.json`.
   - Authors are grouped by GND id, then by name. An initial-only given name
     joins the one person of that surname it can abbreviate.
   - A record that an ERef `succeeds` field marks as superseded is dropped.
3. **Embed** (`rais/embeddings.py`): the same model contract as
   DREVisualizations (`docs/SEMANTIC_EMBEDDINGS.md`).
   - Model: `google/embeddinggemma-2` at revision `914f7f89…`, CPU float32,
     task prefix `task: sentence similarity | query: `, unit-L2 vectors.
   - Card: `Title`, `Type`, `Keywords`, `Abstract`, within 900 words.
     Records whose own text is under 100 characters are low-signal: they
     are drawn faint and never recommended.
   - Then UMAP (15 neighbours, min_dist 0.1, cosine, seed 42), k-means
     topics (√(n/2), capped at 8 so each topic has its own colour), and the
     top-8 cosine neighbours.
   - Topic names are generated from each group's most distinctive keywords
     (class-based TF-IDF), topped up with title words.
4. **Networks** (`rais/networks.py`): keyword co-occurrence and co-authorship.
   - Each connected component is laid out with ForceAtlas2, and the
     components are packed in rings around the largest one. Positions are
     projected to pseudo lng/lat for MapLibre, as in the AMIRA Entity
     Network.
   - Louvain groups (seed 42); groups under 4 members stay grey.
   - Every node and edge lists its publications, so the facets recount
     sizes and weights in the browser without moving the layout.
5. **Site** (`rais/__main__.py`): copies `web/` and writes `dist/data/*.json`
   and `dist/data/report.json`, which has counts, merges, topic names and
   file sizes.

## Deployment (GitLab Pages)

[`.gitlab-ci.yml`](.gitlab-ci.yml) has two jobs:

- **`test`** runs on every push and merge request: ruff and pytest, without
  the model.
- **`pages`** runs on the default branch, on a manual *Run pipeline*, and on
  a pipeline schedule. It installs the model stack, builds into `public/`
  and publishes it. Set up the schedule under *Build → Pipeline schedules*;
  weekly is enough for ERef.

The `pages` job caches the Hugging Face model, the pip wheels and the vector
cache, keyed on the model revision. A scheduled run therefore downloads
nothing large and embeds only what changed. The model is open, so no token
is needed.

## Updating the vendored libraries

`python scripts/vendor_libs.py` downloads the pinned ECharts and MapLibre
releases from npm and checks each tarball against the registry's sha512
integrity before extracting it. To upgrade, bump the versions in the script,
re-run it, and update the hashes in `THIRD_PARTY_NOTICES`.

## Licence

GPL-3.0-or-later, as the DREVisualizations code it adapts. See
[`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES) for the ported files, the
vendored libraries and the model.
