/* Lightweight auth glue for the main dashboard:
 *  - renders a Sign In / Logout control in the sidebar
 *  - continues the audit session (heartbeat) while the user browses
 * Non-blocking: the dashboard works fine whether or not anyone is signed in. */
(function () {
  var IDB = window.IDB;
  function $(id) {
    return document.getElementById(id);
  }

  function renderLoggedOut() {
    var box = $("auth-status");
    if (!box) return;
    box.innerHTML =
      '<a class="sa-login" href="login.html">🔐 Sign In</a>';
  }

  function renderLoggedIn(session, role) {
    var box = $("auth-status");
    if (!box) return;
    var email = session.user.email || "Account";
    box.innerHTML =
      '<div class="sa-user" title="' +
      email +
      '">👤 <span>' +
      email +
      "</span></div>" +
      '<div class="sa-role">' +
      (role === "admin" ? "Administrator" : "Viewer") +
      "</div>" +
      '<button class="sa-logout" id="saLogout" type="button">Logout</button>';
    var btn = $("saLogout");
    if (btn)
      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.textContent = "…";
        IDB.logout().then(function () {
          location.reload();
        });
      });
  }

  // Authoritative redirect to login (used when no valid session exists).
  // auth-gate.js already did a fast synchronous check before paint; this is
  // the definitive check once supabase-js has loaded and (if needed) tried
  // to refresh the token. Catches revoked/expired sessions the sync pass let through.
  function gotoLogin() {
    var here = location.pathname.split("/").pop() || "index.html";
    location.replace("login.html?next=" + encodeURIComponent(here));
  }

  function init() {
    if (!IDB || !IDB.sb) {
      // supabase-js failed to load; fall back to the sync gate's verdict.
      renderLoggedOut();
      return;
    }
    IDB.sb.auth.getSession().then(function (res) {
      var session = res.data ? res.data.session : null;
      if (!session) {
        // No valid session (e.g. revoked/expired) -> enforce the gate.
        gotoLogin();
        return;
      }
      // Continue capturing this session in the audit trail.
      IDB.ensureTracking();
      IDB.sb
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .single()
        .then(function (r) {
          renderLoggedIn(session, r.data ? r.data.role : "viewer");
        })
        .catch(function () {
          renderLoggedIn(session, "viewer");
        });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
