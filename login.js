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

    // Create a PRE-CONFIRMED viewer account via the signup-viewer Edge
    // Function (service role). No confirmation email is sent, so the user
    // can use the account immediately — no waiting on email delivery.
    var resetBtn = function () {
      btn.disabled = false;
      btn.textContent = "Create Viewer Account";
    };

    fetch(IDB.URL + "/functions/v1/signup-viewer", {
      method: "POST",
      headers: { apikey: IDB.ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email,
        password: password,
        full_name: fullName,
      }),
    })
      .then(function (r) {
        return r.json().then(function (b) {
          return { status: r.status, body: b };
        });
      })
      .then(function (res) {
        if (res.status !== 200 || !res.body || !res.body.ok) {
          showMsg(
            (res.body && res.body.error) || "Sign up failed. Please try again.",
            "error"
          );
          resetBtn();
          return;
        }
        // Account is ready immediately -> sign in and go to the dashboard.
        showMsg("Account created. Signing you in…", "ok");
        sb.auth
          .signInWithPassword({ email: email, password: password })
          .then(function (si) {
            if (si.error || !si.data.user) {
              // Created, but auto sign-in failed -> let them sign in manually.
              showMsg("Account created! You can now sign in.", "ok");
              resetBtn();
              setTab("signin");
              $("siEmail").value = email;
              return;
            }
            withTimeout(IDB.recordLogin(si.data.user), 5000).then(function () {
              redirectFor("viewer");
            });
          });
      })
      .catch(function (err) {
        showMsg(err.message || "Sign up failed", "error");
        resetBtn();
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
