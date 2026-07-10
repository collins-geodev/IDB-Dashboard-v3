# IDB Assets Tracking Dashboard – V3

A read-only, browser-based monitoring dashboard for tracking the field tagging of LT poles, distribution transformers (DTs), and connected buildings across **20 prioritized SHOMOLU 11kV feeders**. V3 is a focused replica of the V2 dashboard scoped to a curated feeder list — same UI/UX, same KPIs, narrower data set.

**Live deployment:** https://idb-assets-dashboard-v3.vercel.app *(updated after first Vercel deploy)*
**Source repo:** https://github.com/Collins76/IDB-Assets-Tracking-Dashboard-V3

---

## Deployment architecture (consolidated — one repo drives both dashboards)

Both the **v3** (20-feeder) and **v2** (37-feeder) dashboards deploy from **this single repo**. Two Vercel projects are connected to it, and each `git push` to `main` deploys both.

The only per-dashboard differences live in [`dashboard-config.js`](dashboard-config.js), which resolves the variant from the **hostname** at runtime (no build step):

| Domain | variant | Convex backend | feeder scope |
|--------|---------|----------------|--------------|
| `idb-assets-dashboard-v2*.vercel.app` | `v2` | `fabulous-pigeon-544` | all feeders |
| everything else (incl. `…-v3…`) | `v3` | `flexible-ostrich-263` | 20-feeder allowlist |

`dashboard-config.js` sets `window.IDB_CONFIG`; `convex-client.js` reads the Convex URL from it, and `script.js` reads the feeder allowlist from it (applied only when non-null). To pin a **custom domain** to a variant, add it to the `DOMAIN_VARIANTS` map in `dashboard-config.js`. The Convex *backend* functions in `convex/` are deployed per-project separately (`npx convex deploy`).

---

## What changed vs. V2

V3 is functionally identical to V2 with one targeted addition: a feeder allowlist applied at data-load time. Every analytic, KPI, chart, table, and filter dropdown automatically reflects only the 20 feeders below — no UI changes, no logic forks.

### The 20 SHOMOLU feeders included in V3

| #  | BU      | Feeder                          |
|----|---------|---------------------------------|
| 1  | SHOMOLU | 11-IgbobiINJ-T2-Market          |
| 2  | SHOMOLU | 11-OworoINJ-T3-Gbagada          |
| 3  | SHOMOLU | 11-OguduINJ-T1-Ogudu            |
| 4  | SHOMOLU | 11-IlupejuINJ-T3-Palmgrove      |
| 5  | SHOMOLU | 11-OguduINJ-T2-Alapere          |
| 6  | SHOMOLU | 11-MarylandINJ-T1-Okupe         |
| 7  | SHOMOLU | 11-OguduINJ-T3-Soluyi           |
| 8  | SHOMOLU | 11-MagodoINJ-T2-CMD             |
| 9  | SHOMOLU | 11-OguduINJ-T1-Express          |
| 10 | SHOMOLU | 11-IgbobiINJ-T3-Ikorodu         |
| 11 | SHOMOLU | 11-New OworoINJ-T1-Odunsi       |
| 12 | SHOMOLU | 11-IgbobiINJ-T3-Railway         |
| 13 | SHOMOLU | 11-IgbobiINJ-T2-Adurosakin      |
| 14 | SHOMOLU | 11-OguduINJ-T3-Kola Adeshina    |
| 15 | SHOMOLU | 11-IsheriINJ-T1-Isheri          |
| 16 | SHOMOLU | 11-WasimiINJ-T1-Araromi         |
| 17 | SHOMOLU | 11-MarylandINJ-T1-Ketu          |
| 18 | SHOMOLU | 11-MarylandINJ-T3-Sylvia        |
| 19 | SHOMOLU | 11-OguduINJ-T2-Oriola           |
| 20 | SHOMOLU | 11-OguduINJ-T1-CAC              |

The filter is applied once on load against both the field-data file (`Feeder` column) and the BOQ file (`FEEDER NAME` column). Names are matched case-insensitively with whitespace normalized so minor formatting variants in source data still match.

---

## Features

- **Executive Summary** – Top-level rollup: poles tagged, DTs covered, buildings connected, % completion vs. BOQ.
- **KPI cards** – Total poles (incl./excl. new), good condition, bad/replace, new poles to install, feeders, DTs, buildings.
- **Project completion analytics** – Per-feeder and per-DT progress bars, tagged-vs-target deltas, BOQ comparison.
- **Interactive map** – Lagos boundary, Undertaking polygons, Shomolu HT feeder polylines, Injection Substation markers, TCN station markers, geo-tagged pole points colored by Undertaking.
- **Multi-select filtering** – BU, Undertaking, User, Feeder, DT, Upriser, Material, Date — every filter is multi-select and stacks contextually.
- **Vendor inference & issue simulation** – Vendor derived from User; issue type assigned where missing for downstream charts.
- **Duplicate SLRN detection** – Highlights repeated `Lt PoleSLRN` and `Associated Buildings SLRN` values with dismissible warnings.
- **AI Q&A panel** – Natural-language queries over the filtered dataset (counts, top entities, feeder/DT lookups).
- **Field-data ↔ BOQ toggle** – Switch the dashboard between live field captures and the planned BOQ targets.
- **Sidebar nav + mobile drawer** – Collapsible sidebar with hamburger toggle for small screens.

---

## Tech stack

| Layer            | Tooling                                                                |
|------------------|------------------------------------------------------------------------|
| UI               | Static HTML + CSS + vanilla JavaScript (no build step)                 |
| Charts           | [Plotly.js](https://plotly.com/javascript/) (CDN)                      |
| Map              | [Leaflet](https://leafletjs.com/) + GeoJSON overlays                   |
| Data storage     | Supabase Storage (public bucket `dashboard-assets`)                    |
| Hosting          | Vercel (static deployment, no build command)                           |
| Source control   | GitHub (this repo)                                                     |

---

## Repository layout

```
.
├── index.html                                  # All UI markup
├── script.js                                   # Dashboard logic (filtering, charts, map, AI Q&A)
├── style.css                                   # Main theme + KPI + table + chart styles
├── ai-styles.css                               # Q&A panel styles
├── insights.css                                # Insight-card styles
├── sidebar.css                                 # Sidebar + mobile drawer
├── switch_styles.css                           # Field/BOQ toggle styles
├── converted_data_latest.json                  # Field tagging data (fallback copy)
├── BOQ-IDB.json                                # BOQ targets per feeder/DT (fallback copy)
├── data/
│   ├── lagos_boundary.geojson
│   ├── ut_boundaries.geojson
│   ├── shomolu_ht_feeders.geojson
│   ├── iss_substations.geojson
│   └── tcn_stations.geojson
├── images/
│   ├── favicon.jpg
│   └── ie-logo.png
├── vercel.json                                 # Cache-Control headers (static + JSON)
├── LT Pole Data Cleaned Captured Shomolu BU-2026.xlsx   # Source workbook reference
└── README.md
```

---

## Data flow

```
                    ┌──────────────────────────┐
                    │  Supabase Storage (V3)   │  primary
                    │  dashboard-assets bucket │
                    └────────────┬─────────────┘
                                 │ (CDN, 5-min browser cache)
                                 ▼
            ┌────────────────────────────────────────────┐
            │  fetchWithFallback()  in script.js          │
            │   1. Supabase URL                           │
            │   2. ./converted_data_latest.json (local)   │
            │   3. GitHub raw on main                     │
            └────────────────────┬───────────────────────┘
                                 │
                                 ▼
            ┌────────────────────────────────────────────┐
            │  V3 feeder allowlist (20 feeders)          │
            │  applied to both fieldData and boq         │
            └────────────────────┬───────────────────────┘
                                 │
                                 ▼
                ┌───────────────────────────────┐
                │  globalData / filteredData /  │
                │  boqData → all KPIs, charts,  │
                │  filters, map, AI panel       │
                └───────────────────────────────┘
```

The fallback chain ensures the dashboard renders even if Supabase Storage is unreachable — the JSON files committed to this repo serve as a static backup, with GitHub raw URLs as a final safety net.

---

## Updating the data

V3 reads `converted_data_latest.json` (field captures) and `BOQ-IDB.json` (planned targets) from Supabase Storage on every page load. **You do not need to redeploy the site to refresh data.**

1. Open the Supabase dashboard for project **IDB-Dashboard-V3**.
2. Go to **Storage → dashboard-assets**.
3. Replace `converted_data_latest.json` and/or `BOQ-IDB.json` with the new file (same name).
4. Hard-refresh the dashboard (Ctrl+F5). The Supabase response is cached in the browser for 5 minutes; the in-app fetch appends a cache-busting timestamp on every load, so a refresh is enough.

For local fallback parity, you can also commit the new JSON files to this repo and push to `main` — Vercel will redeploy and the static fallback will match.

---

## Adding or removing a feeder from the V3 scope

The allowlist is hard-coded in [script.js](./script.js) so it is reviewable in pull requests. Search for `ALLOWED_FEEDERS_V3` and edit the array. Names are matched case-insensitively with whitespace normalized.

```js
const ALLOWED_FEEDERS_V3 = [
    "11-IgbobiINJ-T2-Market",
    // ...
];
```

After editing, commit and push — Vercel auto-deploys on push to `main`.

---

## Running locally

This is a fully static site — no install or build step. Any HTTP server will do:

```bash
# Python 3
python -m http.server 8000

# Node (npx)
npx serve .
```

Open `http://localhost:8000` and the dashboard will fetch its data exactly as it does in production.

---

## Deployment

The site is deployed to Vercel as a static project (no framework, no build command). The `vercel.json` config sets long cache headers for CSS/JS and a short 5-minute cache for `.json` so data refreshes propagate quickly. Vercel is connected to this repo's `main` branch — every push to `main` triggers a redeploy.

---

## Credits

- **Data Science / Build:** Collins Anyanwu
- **Field tagging team:** SHOMOLU BU
- **Org:** PoloSoft Technologies Nigeria Pvt. Limited

---

## License

Internal use. All rights reserved.
