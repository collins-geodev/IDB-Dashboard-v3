/* =====================================================================
 * realignment-2026.js  —  IKEDC UT & BU Boundary Realignment 2026.
 *
 * From 2026 Ikeja Electric runs 5 Business Units (ABULE EGBA has been
 * collapsed into its neighbours) and 38 Undertakings (was 6 BUs / 54 UTs).
 * Source: IKEDC_UT_BU_Realignment_2026 GIS pack (GIS Team, Technical
 * Services) — IE_UT_Boundary_2026, IE_BU_Boundary_2026 and the
 * IE_Old_to_New_UT_Lookup table.
 *
 * The field data is still captured against the legacy UT/BU names, so every
 * record is re-attributed at load time:
 *   1. Point-in-polygon of the pole's GPS against the 2026 UT boundaries
 *      (data/ut_boundaries.geojson) — the authoritative assignment.
 *   2. A GPS hit is only accepted when it is a destination the official
 *      old→new lookup allows for the record's legacy UT; otherwise (GPS
 *      stray, no coordinates, boundaries not loaded) the legacy UT's
 *      majority destination is used.
 * The original values are kept on the record as "Undertaking (pre-2026)" and
 * "Business Unit (pre-2026)".
 *
 * Exposes: window.IDB_REALIGNMENT = { setBoundaries, realignRecords, BU_LIST, ... }
 * MUST load BEFORE script.js.
 * ===================================================================== */
(function () {
  "use strict";

  var LEGACY_UT_FIELD = "Undertaking (pre-2026)";
  var LEGACY_BU_FIELD = "Business Unit (pre-2026)";

  // 2026 Undertaking -> Business Unit (38 UTs, 5 BUs).
  var UT_BU_2026 = {
    "ABULE ODU": "AKOWONJO", "ABULE TAYLOR": "AKOWONJO", "ADIYAN": "AKOWONJO", "AYOBO": "AKOWONJO",
    "DOPEMU": "AKOWONJO", "EGBEDA": "AKOWONJO", "GOWON": "AKOWONJO", "IJAIYE": "AKOWONJO",
    "IPAJA": "AKOWONJO", "LAMBE": "AKOWONJO",
    "AKUTE": "IKEJA", "FAGBA": "IKEJA", "IFAKO": "IKEJA", "IJU": "IKEJA", "MAGODO": "IKEJA",
    "OGBA": "IKEJA", "OJODU": "IKEJA", "OLOWORA": "IKEJA", "OREGUN": "IKEJA", "PTC": "IKEJA",
    "EPE": "IKORODU", "IGBOGBO": "IKORODU", "IJEDE": "IKORODU", "LASUNWON": "IKORODU",
    "ODOGUNYAN": "IKORODU", "OWUTU": "IKORODU",
    "AGO": "OSHODI", "IGANDO": "OSHODI", "IJEGUN": "OSHODI", "IKOTUN": "OSHODI",
    "ISOLO": "OSHODI", "OSHODI": "OSHODI",
    "IGBOBI": "SHOMOLU", "IKOSI": "SHOMOLU", "ILUPEJU": "SHOMOLU", "KETU": "SHOMOLU",
    "OGUDU": "SHOMOLU", "OWORO": "SHOMOLU"
  };

  // Legacy (pre-2026) UT -> the 2026 UTs it was split into, largest share first
  // (IE_Old_to_New_UT_Lookup). The first entry is the majority destination.
  var LEGACY_UT_DESTINATIONS = {
    "ABORU": ["ABULE TAYLOR", "IPAJA"],
    "ABULE ODU": ["ABULE ODU", "IKOTUN"],
    "ABULE TAYLOR": ["ABULE TAYLOR", "IJAIYE", "IPAJA"],
    "ADIYAN": ["ADIYAN", "LAMBE"],
    "AGO": ["AGO"],
    "AIT": ["IJAIYE", "IPAJA"],
    "AJAO": ["OSHODI", "ISOLO"],
    "AKUTE": ["AKUTE", "LAMBE", "OLOWORA"],
    "AMUWO": ["AGO"],
    "ANIFOWOSHE": ["OGBA", "OREGUN"],
    "AYANGBUREN": ["LASUNWON", "IGBOGBO", "OWUTU"],
    "AYOBO": ["AYOBO"],
    "BARIGA": ["IGBOBI"],
    "DOPEMU": ["DOPEMU", "EGBEDA"],
    "EGBEDA": ["EGBEDA", "ABULE ODU", "DOPEMU", "ABULE TAYLOR", "PTC", "GOWON"],
    "EPE": ["EPE"],
    "FAGBA": ["FAGBA"],
    "GOWON": ["GOWON", "ABULE ODU", "EGBEDA", "IPAJA", "ABULE TAYLOR"],
    "IDIMU": ["IKOTUN", "ABULE ODU", "IGANDO", "ISOLO"],
    "IFAKO": ["IFAKO", "OGBA", "IJU"],
    "IGANDO": ["IGANDO"],
    "IGBOBI": ["IGBOBI", "ILUPEJU"],
    "IGBOGBO": ["IGBOGBO"],
    "IJAIYE": ["IJAIYE", "FAGBA"],
    "IJEDE": ["IJEDE"],
    "IJEGUN": ["IJEGUN", "ISOLO", "IKOTUN"],
    "IJU": ["IJU", "ADIYAN"],
    "IKOSI": ["IKOSI", "MAGODO"],
    "IKOTUN": ["IKOTUN", "IJEGUN"],
    "ILUPEJU": ["ILUPEJU", "OWORO"],
    "IPAJA": ["IPAJA", "AYOBO"],
    "ISOLO": ["ISOLO", "OSHODI", "AGO"],
    "KETU": ["KETU", "IKOSI", "OGUDU"],
    "LAMBE": ["LAMBE", "AKUTE"],
    "LASUNWON": ["LASUNWON"],
    "MAGODO": ["MAGODO", "OLOWORA"],
    "MENDE": ["OGUDU", "OWORO"],
    "OBA AKRAN": ["OGBA", "OJODU"],
    "ODOGUNYAN": ["ODOGUNYAN", "LASUNWON"],
    "OGBA": ["OGBA", "IFAKO"],
    "OGUDU": ["OGUDU", "KETU"],
    "OJODU": ["OLOWORA", "OJODU"],
    "OKE IRA": ["IFAKO", "OJODU"],
    "OKE ODO": ["ABULE TAYLOR", "DOPEMU"],
    "OKEAFA": ["ISOLO", "IKOTUN"],
    "OKOTA": ["AGO", "ISOLO"],
    "OLATEJU": ["ILUPEJU"],
    "OLOWORA": ["OLOWORA"],
    "OREGUN": ["OREGUN", "PTC"],
    "ORILE AGEGE": ["DOPEMU", "ABULE TAYLOR", "IJU", "FAGBA"],
    "OSHODI": ["OSHODI", "PTC"],
    "OWORO": ["OWORO", "IGBOBI"],
    "OWUTU": ["OWUTU"],
    "PTC": ["PTC", "OSHODI", "OREGUN", "OGBA"]
  };

  var BU_LIST = ["AKOWONJO", "IKEJA", "IKORODU", "OSHODI", "SHOMOLU"];

  // Prepared 2026 UT polygons: [{ ut, bu, bbox:[minX,minY,maxX,maxY], polys:[[outer, ...holes]] }]
  var utPolys = null;

  function norm(v) { return String(v == null ? "" : v).trim().replace(/\s+/g, " ").toUpperCase(); }

  function setBoundaries(geojson) {
    var feats = geojson && Array.isArray(geojson.features) ? geojson.features : [];
    var out = [];
    feats.forEach(function (f) {
      var p = f.properties || {}, g = f.geometry;
      if (!g) return;
      var polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
      if (!polys) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      polys.forEach(function (poly) {
        poly[0].forEach(function (c) {
          if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
          if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
        });
      });
      var ut = norm(p.UT || p.Name);
      out.push({ ut: ut, bu: norm(p.BU) || UT_BU_2026[ut] || "", bbox: [minX, minY, maxX, maxY], polys: polys });
    });
    utPolys = out.length ? out : null;
    return !!utPolys;
  }

  function inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // 2026 UT polygon containing (lon, lat), or null.
  function locate(lon, lat) {
    if (!utPolys) return null;
    for (var k = 0; k < utPolys.length; k++) {
      var u = utPolys[k], b = u.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      for (var p = 0; p < u.polys.length; p++) {
        var poly = u.polys[p];
        if (!inRing(lon, lat, poly[0])) continue;
        var inHole = false;
        for (var h = 1; h < poly.length && !inHole; h++) inHole = inRing(lon, lat, poly[h]);
        if (!inHole) return u;
      }
    }
    return null;
  }

  // Resolve the 2026 UT/BU for one record. method: gps | lookup | gps-unmapped | unchanged
  function resolve(legacyUt, lat, lon) {
    var dests = LEGACY_UT_DESTINATIONS[legacyUt];
    var hit = (isFinite(lat) && isFinite(lon)) ? locate(lon, lat) : null;
    if (hit && (!dests || hit.ut === legacyUt || dests.indexOf(hit.ut) !== -1)) {
      return { ut: hit.ut, bu: hit.bu, method: dests ? "gps" : "gps-unmapped" };
    }
    if (dests) return { ut: dests[0], bu: UT_BU_2026[dests[0]], method: "lookup" };
    if (UT_BU_2026[legacyUt]) return { ut: legacyUt, bu: UT_BU_2026[legacyUt], method: "unchanged" };
    return null;
  }

  // Re-attribute records in place to the 2026 UT/BU. Idempotent: a record that
  // was already realigned keeps its legacy fields and is re-resolved from them.
  // Returns a summary { total, changedUt, changedBu, byMethod, byBu }.
  function realignRecords(records) {
    var s = { total: 0, changedUt: 0, changedBu: 0, byMethod: {}, byBu: {} };
    if (!Array.isArray(records)) return s;
    records.forEach(function (r) {
      if (!r || typeof r !== "object") return;
      if (!(LEGACY_UT_FIELD in r)) {
        r[LEGACY_UT_FIELD] = r["Undertaking"] == null ? "" : r["Undertaking"];
        r[LEGACY_BU_FIELD] = r["Bussines Unit"] == null ? "" : r["Bussines Unit"];
      }
      var legacyUt = norm(r[LEGACY_UT_FIELD]);
      var res = resolve(legacyUt, parseFloat(r.Latitude), parseFloat(r.Longitude));
      s.total++;
      if (!res) { s.byMethod.unresolved = (s.byMethod.unresolved || 0) + 1; return; }
      if (res.ut !== legacyUt) s.changedUt++;
      if (res.bu !== norm(r[LEGACY_BU_FIELD])) s.changedBu++;
      r["Undertaking"] = res.ut;
      r["Bussines Unit"] = res.bu;
      s.byMethod[res.method] = (s.byMethod[res.method] || 0) + 1;
      s.byBu[res.bu] = (s.byBu[res.bu] || 0) + 1;
    });
    return s;
  }

  window.IDB_REALIGNMENT = {
    LEGACY_UT_FIELD: LEGACY_UT_FIELD,
    LEGACY_BU_FIELD: LEGACY_BU_FIELD,
    UT_BU_2026: UT_BU_2026,
    LEGACY_UT_DESTINATIONS: LEGACY_UT_DESTINATIONS,
    BU_LIST: BU_LIST,
    setBoundaries: setBoundaries,
    hasBoundaries: function () { return !!utPolys; },
    locate: locate,
    realignRecords: realignRecords
  };
})();
