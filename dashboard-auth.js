/* Lightweight auth glue for the main dashboard:
 *  - renders a Sign In / Logout control in the sidebar
 *  - continues the audit session (heartbeat) while the user browses
 * Non-blocking: the dashboard works fine whether or not anyone is signed in. */
(function () {
  var IDB = window.IDB;
  function $(id) {
    return document.getElementById(id);
  }

  // Escape user-supplied strings before injecting as HTML.
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Up-to-two-letter initials from a name (preferred) or email local-part.
  function initials(name, email) {
    var src = (name && name.trim()) || (email ? email.split("@")[0] : "");
    var parts = src.split(/[^A-Za-z0-9]+/).filter(Boolean);
    var ini;
    if (parts.length >= 2) ini = parts[0].charAt(0) + parts[1].charAt(0);
    else if (parts.length === 1) ini = parts[0].slice(0, 2);
    else ini = "U";
    return ini.toUpperCase();
  }

  // A friendly display name: the profile name, or a prettified email local-part.
  function displayName(name, email) {
    if (name && name.trim()) return name.trim();
    if (email) {
      return email
        .split("@")[0]
        .replace(/[._-]+/g, " ")
        .replace(/\b\w/g, function (c) {
          return c.toUpperCase();
        });
    }
    return "Account";
  }

  var LOGOUT_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
  var LOGIN_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>';

  function renderLoggedOut() {
    var box = $("auth-status");
    if (!box) return;
    box.innerHTML =
      '<a class="sa-login" href="login.html">' +
      LOGIN_ICON +
      "<span>Sign In</span></a>";
  }

  function renderLoggedIn(session, profile) {
    var box = $("auth-status");
    if (!box) return;
    var role = (profile && profile.role) || "viewer";
    var email = session.user.email || "";
    var fullName = (profile && profile.full_name) || "";
    var name = displayName(fullName, email);
    var ini = initials(fullName, email);
    var isAdmin = role === "admin";

    box.innerHTML =
      '<div class="sa-card">' +
      '<div class="sa-head">' +
      '<div class="sa-avatar">' +
      esc(ini) +
      "</div>" +
      '<div class="sa-meta">' +
      '<div class="sa-name" title="' +
      esc(name) +
      '">' +
      esc(name) +
      "</div>" +
      '<div class="sa-email" title="' +
      esc(email) +
      '">' +
      esc(email) +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="sa-role-badge ' +
      (isAdmin ? "sa-role-admin" : "sa-role-viewer") +
      '"><span class="sa-dot"></span>' +
      (isAdmin ? "Administrator" : "Viewer") +
      "</div>" +
      '<button class="sa-logout" id="saLogout" type="button">' +
      LOGOUT_ICON +
      "<span>Sign out</span></button>" +
      "</div>";

    var btn = $("saLogout");
    if (btn)
      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.querySelector("span").textContent = "Signing out…";
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
        .select("role, full_name")
        .eq("id", session.user.id)
        .single()
        .then(function (r) {
          renderLoggedIn(session, r.data || { role: "viewer" });
        })
        .catch(function () {
          renderLoggedIn(session, { role: "viewer" });
        });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
