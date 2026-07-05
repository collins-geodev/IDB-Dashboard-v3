/* =====================================================================
 * Page gate: require a signed-in user to view this page.
 * Loaded as the FIRST script in <head> so it runs before any content
 * paints. Performs a fast, synchronous check against the Convex session
 * persisted in localStorage under "idb-auth".
 * If there is no (unexpired) session, redirect to the login page,
 * remembering where the user wanted to go.
 *
 * A full async re-validation runs in dashboard-auth.js against the
 * Convex backend; this synchronous pass just prevents a flash of the
 * protected page for anonymous visitors.
 * ===================================================================== */
(function () {
  var STORAGE_KEY = "idb-auth"; // must match convex-client.js
  var LOGIN_PAGE = "login.html";

  // Hide the document until we've confirmed a session (avoids content flash).
  // A <style> is used so it applies before <body> parses; removed on pass.
  try {
    var style = document.createElement("style");
    style.id = "idb-auth-gate-style";
    style.textContent = "html{visibility:hidden!important}";
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}

  function reveal() {
    var s = document.getElementById("idb-auth-gate-style");
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }

  function hasValidSession() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return false; // storage blocked -> treat as not authed
    }
    if (!raw) return false;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.token) return false;
      // expires_at is an ISO timestamp set by the Convex backend.
      if (data.expires_at) {
        if (new Date(data.expires_at).getTime() <= Date.now()) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function redirectToLogin() {
    var here =
      location.pathname.split("/").pop() ||
      "index.html";
    var next = encodeURIComponent(here);
    // Use replace() so the protected page isn't left in history.
    location.replace(LOGIN_PAGE + "?next=" + next);
  }

  if (hasValidSession()) {
    reveal();
  } else {
    redirectToLogin();
  }
})();
