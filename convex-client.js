/* =====================================================================
 * Shared Convex client for the IDB Assets Dashboard (replaces the old
 * supabase-client.js). Plain fetch against the Convex HTTP API — no SDK
 * or bundler needed for this static site.
 * Exposes:  window.IDB.URL       -> Convex deployment URL (.convex.cloud)
 *           window.IDB.SITE_URL  -> Convex HTTP actions URL (.convex.site)
 *           window.IDB.query / .mutation / .action
 *           window.IDB.auth      -> session + sign-in/up/out helpers
 * Session is stored in localStorage under "idb-auth" as
 *   { token, expires_at, user: {id, email, full_name, role, is_active} }
 * ===================================================================== */
(function () {
  var CONVEX_URL = "https://flexible-ostrich-263.convex.cloud";
  var CONVEX_SITE_URL = "https://flexible-ostrich-263.convex.site";
  var STORAGE_KEY = "idb-auth"; // must match auth-gate.js

  function readAuth() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function writeAuth(a) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
    } catch (e) {}
  }
  function clearAuth() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  // Call a public Convex function over the HTTP API.
  function callConvex(kind, path, args, opts) {
    opts = opts || {};
    return fetch(CONVEX_URL + "/api/" + kind, {
      method: "POST",
      keepalive: !!opts.keepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path, args: args || {}, format: "json" }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (res) {
        if (res && res.status === "success") return res.value;
        throw new Error(
          (res && (res.errorMessage || res.error)) || "Convex call failed"
        );
      });
  }

  var IDB = (window.IDB = window.IDB || {});
  IDB.URL = CONVEX_URL;
  IDB.SITE_URL = CONVEX_SITE_URL;
  IDB.query = function (path, args) {
    return callConvex("query", path, args);
  };
  IDB.mutation = function (path, args, opts) {
    return callConvex("mutation", path, args, opts);
  };
  IDB.action = function (path, args) {
    return callConvex("action", path, args);
  };

  IDB.auth = {
    // Raw local auth blob (may be stale — validate with me()).
    getSession: function () {
      var a = readAuth();
      if (!a || !a.token || !a.user) return null;
      if (a.expires_at && new Date(a.expires_at).getTime() <= Date.now()) {
        return null;
      }
      return a;
    },
    getToken: function () {
      var a = IDB.auth.getSession();
      return a ? a.token : null;
    },
    // Definitive server-side check. Resolves {user, expires_at} or null
    // (and clears local state when the server rejects the session).
    me: function () {
      var a = readAuth();
      if (!a || !a.token) return Promise.resolve(null);
      return IDB.query("auth:me", { token: a.token })
        .then(function (res) {
          if (!res) {
            clearAuth();
            return null;
          }
          a.user = res.user;
          a.expires_at = res.expires_at;
          writeAuth(a);
          return res;
        })
        .catch(function () {
          // Network hiccup: fall back to the local session rather than
          // logging the user out.
          var local = IDB.auth.getSession();
          return local
            ? { user: local.user, expires_at: local.expires_at, offline: true }
            : null;
        });
    },
    signIn: function (email, password) {
      return IDB.action("authNode:signIn", {
        email: email,
        password: password,
      }).then(function (res) {
        if (res && res.ok) {
          writeAuth({
            token: res.token,
            expires_at: res.expires_at,
            user: res.user,
          });
        }
        return res;
      });
    },
    // NOTE: there is no public self-service signUp. The dashboard is
    // admin-invite-only; new accounts are created by an admin via the Admin
    // Console (authNode:adminCreateUser).
    signOut: function () {
      var a = readAuth();
      clearAuth();
      if (a && a.token) {
        return IDB.mutation("auth:signOut", { token: a.token }).catch(
          function () {}
        );
      }
      return Promise.resolve();
    },
  };
})();
