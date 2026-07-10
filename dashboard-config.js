/* =====================================================================
 * dashboard-config.js  —  single source of per-dashboard configuration.
 *
 * Both Vercel projects (idb-assets-dashboard-v3 and -v2) deploy this SAME
 * file from the shared repo. The variant is resolved at runtime from the
 * hostname, so no build step or environment variables are needed.
 *
 *   v3  -> 20-feeder SHOMOLU scope, Convex "flexible-ostrich-263"
 *   v2  -> full 37-feeder "IDB 2.0" view, Convex "fabulous-pigeon-544"
 *
 * Exposes: window.IDB_CONFIG = { variant, convexUrl, convexSiteUrl, allowedFeeders }
 *   - allowedFeeders: an array -> load-time feeder allowlist is applied;
 *                     null      -> no filter (show every feeder in the data).
 *
 * MUST load BEFORE convex-client.js and script.js.
 * ===================================================================== */
(function () {
  "use strict";

  // v3's approved feeder allowlist (moved verbatim from the old
  // ALLOWED_FEEDERS_V3 const in script.js). Matched case-insensitively,
  // whitespace-trimmed, against Feeder (field data) and FEEDER NAME (BOQ).
  var V3_ALLOWED_FEEDERS = [
    "11-IgbobiINJ-T2-Market", "11-OworoINJ-T3-Gbagada", "11-OguduINJ-T1-Ogudu",
    "11-IlupejuINJ-T3-Palmgrove", "11-OguduINJ-T2-Alapere", "11-MarylandINJ-T1-Okupe",
    "11-OguduINJ-T3-Soluyi", "11-MagodoINJ-T2-CMD", "11-OguduINJ-T1-Express",
    "11-IgbobiINJ-T3-Ikorodu", "11-New OworoINJ-T1-Odunsi", "11-IgbobiINJ-T3-Railway",
    "11-IgbobiINJ-T2-Adurosakin", "11-OguduINJ-T3-Kola Adeshina", "11-IsheriINJ-T1-Isheri",
    "11-WasimiINJ-T1-Araromi", "11-MarylandINJ-T1-Ketu", "11-MarylandINJ-T3-Sylvia",
    "11-OguduINJ-T2-Oriola", "11-OguduINJ-T1-CAC"
  ];

  var CONFIGS = {
    v3: {
      variant: "v3",
      convexUrl: "https://flexible-ostrich-263.convex.cloud",
      convexSiteUrl: "https://flexible-ostrich-263.convex.site",
      allowedFeeders: V3_ALLOWED_FEEDERS
    },
    v2: {
      variant: "v2",
      convexUrl: "https://fabulous-pigeon-544.convex.cloud",
      convexSiteUrl: "https://fabulous-pigeon-544.convex.site",
      allowedFeeders: null
    }
  };

  // Pin a custom domain to a variant here if one is ever added
  // (its hostname won't contain "dashboard-v2"/"-v3"). e.g.:
  //   "idb.ikejaelectric.com": "v3",
  var DOMAIN_VARIANTS = {};

  var host = (typeof location !== "undefined" && location.hostname || "").toLowerCase();

  // Prod + preview + git aliases for the v2 project all contain "dashboard-v2"
  // (e.g. idb-assets-dashboard-v2.vercel.app, idb-assets-dashboard-v2-<hash>.vercel.app).
  // Everything else — including v3's domains, localhost, and unmapped hosts —
  // defaults to v3.
  var variant =
    DOMAIN_VARIANTS[host] ||
    (host.indexOf("dashboard-v2") !== -1 ? "v2" : "v3");

  window.IDB_CONFIG = CONFIGS[variant] || CONFIGS.v3;

  try {
    console.log(
      "[IDB] variant=" + window.IDB_CONFIG.variant +
      " convex=" + window.IDB_CONFIG.convexUrl +
      " feederScope=" + (window.IDB_CONFIG.allowedFeeders ? window.IDB_CONFIG.allowedFeeders.length + " feeders" : "all")
    );
  } catch (e) {}
})();
