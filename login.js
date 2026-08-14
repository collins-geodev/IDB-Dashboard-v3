/* Sign-in logic for the IDB dashboard (Convex-backed).
 * Invite-only: there is no public sign-up here — accounts are created by an
 * admin in the Admin Console (authNode:adminCreateUser). */
(function () {
  var IDB = window.IDB;
  var $ = function (id) {
    return document.getElementById(id);
  };

  function qparam(name) {
    return new URLSearchParams(location.search).get(name);
  }
  // Only allow same-site relative redirect targets.
  function safeNext() {
    var n = qparam("next");
    if (n && /^[a-z0-9_\-]+\.html$/i.test(n)) return n;
    return null;
  }

  function showMsg(text, type) {
    var m = $("msg");
    m.textContent = text;
    m.className = "msg show " + (type || "info");
  }
  function clearMsg() {
    $("msg").className = "msg";
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (res) {
        setTimeout(res, ms);
      }),
    ]);
  }

  function redirectFor(role) {
    var next = safeNext();
    if (next) {
      location.href = next;
      return;
    }
    location.href = role === "admin" ? "admin.html" : "index.html";
  }

  /* ---- sign in ---- */
  $("formSignin").addEventListener("submit", function (e) {
    e.preventDefault();
    clearMsg();
    var btn = $("siBtn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    var email = $("siEmail").value.trim();
    var password = $("siPass").value;

    IDB.auth
      .signIn(email, password)
      .then(function (res) {
        if (!res || !res.ok) {
          showMsg(
            (res && res.error) || "Sign in failed. Please try again.",
            "error"
          );
          btn.disabled = false;
          btn.textContent = "Sign In";
          return;
        }
        var user = res.user;
        showMsg("Welcome back. Loading…", "ok");
        // Capture the login footprint, then route by role.
        withTimeout(IDB.recordLogin(user), 5000).then(function () {
          redirectFor(user.role);
        });
      })
      .catch(function (err) {
        showMsg(err.message || "Sign in failed", "error");
        btn.disabled = false;
        btn.textContent = "Sign In";
      });
  });

  /* ---- already-signed-in state ---- */
  $("sessionLogout").addEventListener("click", function () {
    var b = $("sessionLogout");
    b.disabled = true;
    b.textContent = "Logging out…";
    IDB.logout().then(function () {
      location.reload();
    });
  });

  function showSession(user) {
    $("authBox").style.display = "none";
    $("sessionBox").style.display = "";
    $("sessionMsg").textContent =
      "You are signed in as " + user.email + " (" + user.role + ").";
    if (user.role === "admin") {
      var ga = $("goAdmin");
      ga.style.display = "";
      ga.href = "admin.html";
    }
  }

  /* ---- theme toggle (dark ↔ light) ---- */
  // The theme is already applied in login.html's <head> (no flash); here we
  // sync the button UI, handle clicks and persist to the shared 'idb-theme'
  // key so the choice carries across the login, dashboard and admin pages.
  function applyTheme(mode) {
    var theme = mode === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    var btn = $("themeToggle");
    if (btn) {
      var icon = btn.querySelector(".theme-toggle-icon");
      var label = btn.querySelector(".theme-toggle-label");
      if (icon) icon.textContent = theme === "light" ? "☀️" : "🌙";
      if (label) label.textContent = theme === "light" ? "Light" : "Dark";
      btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }
  }
  (function initThemeToggle() {
    var saved = "dark";
    try {
      saved = localStorage.getItem("idb-theme") === "light" ? "light" : "dark";
    } catch (e) {}
    applyTheme(saved); // sync the button UI with the already-applied theme
    var btn = $("themeToggle");
    if (btn) {
      btn.addEventListener("click", function () {
        var next =
          document.documentElement.getAttribute("data-theme") === "light"
            ? "dark"
            : "light";
        applyTheme(next);
        try {
          localStorage.setItem("idb-theme", next);
        } catch (e) {}
      });
    }
  })();

  // On load: if there is already a valid session, show the session panel.
  if (IDB && IDB.auth) {
    IDB.auth.me().then(function (res) {
      if (res && res.user) showSession(res.user);
    });
  } else {
    showMsg("Could not initialise authentication. Please refresh.", "error");
  }
})();
