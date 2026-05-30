/* Login + viewer sign-up logic for the IDB dashboard. */
(function () {
  var sb = window.IDB && window.IDB.sb;
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

  function getRole(userId) {
    return sb
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single()
      .then(function (r) {
        return r.data ? r.data.role : "viewer";
      })
      .catch(function () {
        return "viewer";
      });
  }

  function redirectFor(role) {
    var next = safeNext();
    if (next) {
      location.href = next;
      return;
    }
    location.href = role === "admin" ? "admin.html" : "index.html";
  }

  /* ---- tab switching ---- */
  function setTab(which) {
    var si = which === "signin";
    $("tabSignin").classList.toggle("active", si);
    $("tabSignup").classList.toggle("active", !si);
    $("formSignin").style.display = si ? "" : "none";
    $("formSignup").style.display = si ? "none" : "";
    clearMsg();
  }
  $("tabSignin").addEventListener("click", function () {
    setTab("signin");
  });
  $("tabSignup").addEventListener("click", function () {
    setTab("signup");
  });

  /* ---- sign in ---- */
  $("formSignin").addEventListener("submit", function (e) {
    e.preventDefault();
    clearMsg();
    var btn = $("siBtn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    var email = $("siEmail").value.trim();
    var password = $("siPass").value;

    sb.auth
      .signInWithPassword({ email: email, password: password })
      .then(function (res) {
        if (res.error) {
          showMsg(res.error.message, "error");
          btn.disabled = false;
          btn.textContent = "Sign In";
          return;
        }
        var user = res.data.user;
        showMsg("Welcome back. Loading…", "ok");
        getRole(user.id).then(function (role) {
          // Capture the login footprint, then route by role.
          withTimeout(IDB.recordLogin(user), 5000).then(function () {
            redirectFor(role);
          });
        });
      })
      .catch(function (err) {
        showMsg(err.message || "Sign in failed", "error");
        btn.disabled = false;
        btn.textContent = "Sign In";
      });
  });

  /* ---- sign up (always as viewer) ---- */
  $("formSignup").addEventListener("submit", function (e) {
    e.preventDefault();
    clearMsg();
    var btn = $("suBtn");
    btn.disabled = true;
    btn.textContent = "Creating…";
    var email = $("suEmail").value.trim();
    var password = $("suPass").value;
    var fullName = $("suName").value.trim();

    sb.auth
      .signUp({
        email: email,
        password: password,
        options: { data: { full_name: fullName || email.split("@")[0] } },
      })
      .then(function (res) {
        if (res.error) {
          showMsg(res.error.message, "error");
          btn.disabled = false;
          btn.textContent = "Create Viewer Account";
          return;
        }
        // If confirmations are OFF, a session is returned -> log straight in.
        if (res.data.session && res.data.user) {
          showMsg("Account created. Signing you in…", "ok");
          withTimeout(IDB.recordLogin(res.data.user), 5000).then(function () {
            redirectFor("viewer");
          });
        } else {
          showMsg(
            "Account created! Please check your email to confirm your address, then sign in.",
            "ok"
          );
          btn.disabled = false;
          btn.textContent = "Create Viewer Account";
          setTab("signin");
          $("siEmail").value = email;
        }
      })
      .catch(function (err) {
        showMsg(err.message || "Sign up failed", "error");
        btn.disabled = false;
        btn.textContent = "Create Viewer Account";
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

  function showSession(session, role) {
    $("authBox").style.display = "none";
    $("sessionBox").style.display = "";
    $("sessionMsg").textContent =
      "You are signed in as " +
      session.user.email +
      " (" +
      role +
      ").";
    if (role === "admin") {
      var ga = $("goAdmin");
      ga.style.display = "";
      ga.href = "admin.html";
    }
  }

  // On load: if there is already a valid session, show the session panel.
  if (sb) {
    sb.auth.getSession().then(function (res) {
      var session = res.data ? res.data.session : null;
      if (session) {
        getRole(session.user.id).then(function (role) {
          showSession(session, role);
        });
      }
    });
  } else {
    showMsg("Could not initialise authentication. Please refresh.", "error");
  }
})();
