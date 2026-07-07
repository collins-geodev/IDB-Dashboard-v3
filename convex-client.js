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
    // Change the signed-in user's own password (needs the current password).
    changePassword: function (currentPw, newPw) {
      var token = IDB.auth.getToken();
      if (!token) {
        return Promise.resolve({
          ok: false,
          error: "Your session has expired. Please sign in again.",
        });
      }
      return IDB.action("authNode:changePassword", {
        token: token,
        current_password: currentPw,
        new_password: newPw,
      });
    },
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

  // Self-contained "Change password" modal, usable from any page (no external
  // CSS needed). Opens a dialog, calls IDB.auth.changePassword, and closes on
  // success.
  IDB.showChangePassword = function () {
    if (document.getElementById("idb-cpw-overlay")) return; // already open
    if (!document.getElementById("idb-cpw-style")) {
      var st = document.createElement("style");
      st.id = "idb-cpw-style";
      st.textContent =
        "#idb-cpw-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100000;font-family:'Outfit',system-ui,-apple-system,sans-serif;padding:1rem}" +
        "#idb-cpw{width:100%;max-width:380px;background:#161b22;color:#e6edf3;border:1px solid #2b3340;border-radius:14px;padding:1.4rem;box-shadow:0 25px 60px -20px rgba(0,0,0,.7)}" +
        "#idb-cpw h3{margin:0 0 .3rem;font-size:1.1rem}" +
        "#idb-cpw p.sub{margin:0 0 1rem;font-size:.82rem;color:#8b949e}" +
        "#idb-cpw label{display:block;font-size:.78rem;color:#8b949e;margin:.7rem 0 .3rem}" +
        "#idb-cpw input{width:100%;box-sizing:border-box;padding:.6rem .8rem;background:#0d1117;border:1px solid #2b3340;border-radius:8px;color:#e6edf3;font-size:.9rem;outline:none}" +
        "#idb-cpw input:focus{border-color:#2f81f7;box-shadow:0 0 0 3px rgba(47,129,247,.25)}" +
        "#idb-cpw .cpw-msg{margin-top:.8rem;font-size:.82rem;display:none}" +
        "#idb-cpw .cpw-msg.show{display:block}" +
        "#idb-cpw .cpw-msg.err{color:#ff9b9b}#idb-cpw .cpw-msg.ok{color:#7ee787}" +
        "#idb-cpw .cpw-actions{display:flex;gap:.6rem;margin-top:1.1rem}" +
        "#idb-cpw button{flex:1;padding:.6rem;border-radius:8px;font-weight:600;font-size:.85rem;cursor:pointer;border:1px solid transparent}" +
        "#idb-cpw .cpw-cancel{background:#21262d;color:#e6edf3;border-color:#2b3340}" +
        "#idb-cpw .cpw-save{background:#2f81f7;color:#fff}" +
        "#idb-cpw button:disabled{opacity:.6;cursor:not-allowed}";
      document.head.appendChild(st);
    }
    var ov = document.createElement("div");
    ov.id = "idb-cpw-overlay";
    ov.innerHTML =
      '<div id="idb-cpw" role="dialog" aria-modal="true" aria-label="Change password">' +
      "<h3>Change password</h3>" +
      '<p class="sub">Update the password for your account.</p>' +
      '<label for="cpwCur">Current password</label>' +
      '<input id="cpwCur" type="password" autocomplete="current-password">' +
      '<label for="cpwNew">New password <span style="opacity:.7">(min 6 characters)</span></label>' +
      '<input id="cpwNew" type="password" autocomplete="new-password">' +
      '<label for="cpwConf">Confirm new password</label>' +
      '<input id="cpwConf" type="password" autocomplete="new-password">' +
      '<div class="cpw-msg" id="cpwMsg"></div>' +
      '<div class="cpw-actions">' +
      '<button type="button" class="cpw-cancel" id="cpwCancel">Cancel</button>' +
      '<button type="button" class="cpw-save" id="cpwSave">Update</button>' +
      "</div></div>";
    document.body.appendChild(ov);

    function close() {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
    function msg(t, kind) {
      var m = document.getElementById("cpwMsg");
      m.textContent = t;
      m.className = "cpw-msg show " + (kind || "");
    }
    document.getElementById("cpwCancel").addEventListener("click", close);
    ov.addEventListener("click", function (e) {
      if (e.target === ov) close();
    });
    document.getElementById("cpwSave").addEventListener("click", function () {
      var cur = document.getElementById("cpwCur").value;
      var nw = document.getElementById("cpwNew").value;
      var cf = document.getElementById("cpwConf").value;
      if (!cur) return msg("Enter your current password.", "err");
      if (nw.length < 6)
        return msg("New password must be at least 6 characters.", "err");
      if (nw !== cf) return msg("New passwords do not match.", "err");
      var save = document.getElementById("cpwSave");
      save.disabled = true;
      save.textContent = "Updating…";
      IDB.auth
        .changePassword(cur, nw)
        .then(function (res) {
          if (res && res.ok) {
            msg("Password updated. Use it the next time you sign in.", "ok");
            setTimeout(close, 1700);
          } else {
            msg((res && res.error) || "Could not change password.", "err");
            save.disabled = false;
            save.textContent = "Update";
          }
        })
        .catch(function (e) {
          msg(e.message || "Could not change password.", "err");
          save.disabled = false;
          save.textContent = "Update";
        });
    });
    setTimeout(function () {
      var f = document.getElementById("cpwCur");
      if (f) f.focus();
    }, 50);
  };
})();
