/* Admin console: user management + audit trail (Convex-backed).
 * Privileged reads and mutations all go through admin:* Convex functions,
 * which verify the caller's session token resolves to an active admin. */
(function () {
  var IDB = window.IDB;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var me = null; // current admin user (from auth:me)
  var allUsers = [];
  var allAudit = [];
  var lastLoginByUser = {};

  /* ---------- utilities ---------- */
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function fmtDuration(secs) {
    if (secs === null || secs === undefined) return "—";
    secs = Number(secs);
    if (!isFinite(secs) || secs < 0) return "—";
    if (secs < 60) return secs + "s";
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    if (m < 60) return m + "m " + s + "s";
    var h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show " + (kind || "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.className = "toast " + (kind || "");
    }, 3800);
  }

  // Call a privileged admin mutation with the caller's session token.
  // Returns { status, body } like the old edge-function helper did.
  function callFn(path, payload) {
    var token = IDB.auth.getToken();
    if (!token) {
      return Promise.resolve({ status: 401, body: { error: "No session" } });
    }
    return IDB.mutation(path, Object.assign({ token: token }, payload || {}))
      .then(function (body) {
        return { status: body && body.ok ? 200 : 400, body: body || {} };
      })
      .catch(function (err) {
        return { status: 500, body: { error: err.message } };
      });
  }

  /* ---------- access guard ---------- */
  function denied(message) {
    $("gateMsg").innerHTML = esc(message);
    $("gateActions").style.display = "";
  }

  function guard() {
    if (!IDB || !IDB.auth) {
      denied("Authentication failed to initialise. Please refresh.");
      return;
    }
    IDB.auth.me().then(function (res) {
      if (!res || !res.user) {
        location.href = "login.html?next=admin.html";
        return;
      }
      me = res.user;
      if (me.role !== "admin") {
        denied("Access denied. This area is restricted to administrators.");
        return;
      }
      // Keep tracking this admin's session for the audit trail.
      IDB.ensureTracking();
      startApp(me);
    });
  }

  function startApp(profile) {
    $("gate").style.display = "none";
    $("app").style.display = "";
    $("who").textContent =
      "Signed in as " + (profile.email || "") + " · Administrator";
    loadAll();
  }

  /* ---------- data ---------- */
  function loadAll() {
    $("usersBody").innerHTML =
      '<tr><td colspan="6" class="empty"><span class="spin"></span></td></tr>';
    $("auditBody").innerHTML =
      '<tr><td colspan="7" class="empty"><span class="spin"></span></td></tr>';

    var token = IDB.auth.getToken();
    Promise.all([
      IDB.query("admin:listUsers", { token: token }).catch(function (e) {
        return { ok: false, error: e.message };
      }),
      IDB.query("admin:listAudit", { token: token }).catch(function (e) {
        return { ok: false, error: e.message };
      }),
    ]).then(function (results) {
      var uRes = results[0],
        aRes = results[1];
      var usersOk = !!(uRes && uRes.ok);
      var auditOk = !!(aRes && aRes.ok);
      if (!usersOk) {
        $("usersBody").innerHTML =
          '<tr><td colspan="6" class="empty">Failed to load users: ' +
          esc((uRes && uRes.error) || "unknown error") +
          "</td></tr>";
      }
      if (!auditOk) {
        $("auditBody").innerHTML =
          '<tr><td colspan="7" class="empty">Failed to load audit: ' +
          esc((aRes && aRes.error) || "unknown error") +
          "</td></tr>";
      }
      allUsers = usersOk ? uRes.users : [];
      allAudit = auditOk ? aRes.logs : [];

      // last login per user
      lastLoginByUser = {};
      allAudit.forEach(function (a) {
        if (!a.user_id) return;
        if (!lastLoginByUser[a.user_id]) lastLoginByUser[a.user_id] = a.login_at;
      });

      // Only render over the tables when their load succeeded, so a failure
      // message isn't masked by "No users found." / "No audit records yet.".
      if (usersOk && auditOk) renderStats();
      if (usersOk) renderUsers();
      if (auditOk) renderAudit();
    });
  }

  function renderStats() {
    var admins = allUsers.filter(function (u) {
      return u.role === "admin";
    }).length;
    var inactive = allUsers.filter(function (u) {
      return u.is_active === false;
    }).length;
    var since = Date.now() - 24 * 3600 * 1000;
    var logins24 = allAudit.filter(function (a) {
      return new Date(a.login_at).getTime() >= since;
    }).length;
    $("statUsers").textContent = allUsers.length;
    $("statAdmins").textContent = admins;
    $("statViewers").textContent = allUsers.length - admins;
    $("statLogins").textContent = logins24;
    if ($("statInactive")) $("statInactive").textContent = inactive;
  }

  /* ---------- users table ---------- */
  function renderUsers() {
    var q = ($("userSearch").value || "").toLowerCase().trim();
    var rows = allUsers.filter(function (u) {
      if (!q) return true;
      return (
        (u.email || "").toLowerCase().indexOf(q) >= 0 ||
        (u.full_name || "").toLowerCase().indexOf(q) >= 0 ||
        (u.role || "").toLowerCase().indexOf(q) >= 0
      );
    });

    if (!rows.length) {
      $("usersBody").innerHTML =
        '<tr><td colspan="6" class="empty">No users found.</td></tr>';
      return;
    }

    var html = rows
      .map(function (u) {
        var isSelf = u.id === me.id;
        var active = u.is_active !== false; // default true when undefined
        var roleBadge =
          '<span class="badge ' +
          (u.role === "admin" ? "admin" : "viewer") +
          '">' +
          esc(u.role) +
          "</span>";
        var statusBadge =
          '<span class="badge ' +
          (active ? "status-active" : "status-inactive") +
          '"><span class="status-dot"></span>' +
          (active ? "Active" : "Inactive") +
          "</span>";

        // Per-user action buttons.
        var actions;
        if (isSelf) {
          actions = '<span class="muted">— you —</span>';
        } else {
          var roleBtn =
            u.role === "admin"
              ? '<button class="btn btn-ghost btn-sm" data-act="demote" data-id="' +
                esc(u.id) +
                '">Make Viewer</button>'
              : '<button class="btn btn-ghost btn-sm" data-act="promote" data-id="' +
                esc(u.id) +
                '">Make Admin</button>';

          var activeBtn = active
            ? '<button class="btn btn-warn btn-sm" data-act="deactivate" data-id="' +
              esc(u.id) +
              '" data-email="' +
              esc(u.email) +
              '">Deactivate</button>'
            : '<button class="btn btn-success btn-sm" data-act="activate" data-id="' +
              esc(u.id) +
              '" data-email="' +
              esc(u.email) +
              '">Activate</button>';

          var deleteBtn =
            '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' +
            esc(u.id) +
            '" data-email="' +
            esc(u.email) +
            '">Delete</button>';

          actions = roleBtn + activeBtn + deleteBtn;
        }

        var name = u.full_name ? "<div>" + esc(u.full_name) + "</div>" : "";
        return (
          '<tr class="' +
          (active ? "" : "row-inactive") +
          '">' +
          "<td>" +
          name +
          '<div class="muted">' +
          esc(u.email) +
          "</div></td>" +
          "<td>" +
          roleBadge +
          "</td>" +
          "<td>" +
          statusBadge +
          "</td>" +
          "<td>" +
          fmtDate(u.created_at) +
          "</td>" +
          "<td>" +
          fmtDate(lastLoginByUser[u.id]) +
          "</td>" +
          '<td><div class="row-actions">' +
          actions +
          "</div></td>" +
          "</tr>"
        );
      })
      .join("");
    $("usersBody").innerHTML = html;
  }

  function handleUserAction(act, id, email, btn) {
    if (act === "promote" || act === "demote") {
      var role = act === "promote" ? "admin" : "viewer";
      btn.disabled = true;
      callFn("admin:setRole", { user_id: id, role: role }).then(function (r) {
        if (r.status === 200 && r.body.ok) {
          toast("Role updated to " + role + ".", "ok");
          loadAll();
        } else {
          btn.disabled = false;
          toast((r.body && r.body.error) || "Failed to update role.", "err");
        }
      });
    } else if (act === "activate" || act === "deactivate") {
      var makeActive = act === "activate";
      if (
        !makeActive &&
        !confirm(
          "Deactivate " +
            (email || "this user") +
            "?\n\nThey will be signed out and blocked from logging in until reactivated."
        )
      )
        return;
      btn.disabled = true;
      callFn("admin:setActive", { user_id: id, active: makeActive }).then(
        function (r) {
          if (r.status === 200 && r.body.ok) {
            toast(
              makeActive ? "Account activated." : "Account deactivated.",
              "ok"
            );
            loadAll();
          } else {
            btn.disabled = false;
            toast(
              (r.body && r.body.error) ||
                "Failed to update account status.",
              "err"
            );
          }
        }
      );
    } else if (act === "delete") {
      if (
        !confirm(
          "Permanently delete " +
            (email || "this user") +
            "?\n\nThis removes their account and access. This cannot be undone."
        )
      )
        return;
      btn.disabled = true;
      callFn("admin:deleteUser", { user_id: id }).then(function (r) {
        if (r.status === 200 && r.body.ok) {
          toast("User deleted.", "ok");
          loadAll();
        } else {
          btn.disabled = false;
          toast((r.body && r.body.error) || "Failed to delete user.", "err");
        }
      });
    }
  }

  /* ---------- create user (admin invite) ---------- */
  function handleCreateUser(e) {
    e.preventDefault();
    var btn = $("cuBtn");
    var email = ($("cuEmail").value || "").trim();
    var password = $("cuPass").value || "";
    var fullName = ($("cuName").value || "").trim();
    var role = $("cuRole").value === "admin" ? "admin" : "viewer";

    if (!email) {
      toast("Email is required.", "err");
      return;
    }
    if (password.length < 6) {
      toast("Password must be at least 6 characters.", "err");
      return;
    }

    var token = IDB.auth.getToken();
    if (!token) {
      toast("Your session has expired. Please sign in again.", "err");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Creating…";
    IDB.action("authNode:adminCreateUser", {
      token: token,
      email: email,
      password: password,
      full_name: fullName || undefined,
      role: role,
    })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = "Create Account";
        if (res && res.ok) {
          toast(
            (role === "admin" ? "Admin" : "Viewer") +
              " account created for " +
              email +
              ".",
            "ok"
          );
          $("createUserForm").reset();
          loadAll();
        } else {
          toast((res && res.error) || "Failed to create user.", "err");
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Create Account";
        toast(err.message || "Failed to create user.", "err");
      });
  }

  /* ---------- audit table ---------- */
  function renderAudit() {
    var q = ($("auditSearch").value || "").toLowerCase().trim();
    var rows = allAudit.filter(function (a) {
      if (!q) return true;
      var hay = [
        a.email,
        a.ip_address,
        a.city,
        a.country,
        a.browser,
        a.os,
        a.event_type,
      ]
        .join(" ")
        .toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    if (!rows.length) {
      $("auditBody").innerHTML =
        '<tr><td colspan="7" class="empty">No audit records yet.</td></tr>';
      return;
    }

    var html = rows
      .slice(0, 300)
      .map(function (a) {
        var loc = [a.city, a.region, a.country]
          .filter(Boolean)
          .join(", ");
        var dev = [a.browser, a.os].filter(Boolean).join(" · ");
        if (a.device_type) dev += (dev ? " · " : "") + a.device_type;
        var evtClass =
          a.event_type === "session_resume" ? "evt resume" : "evt";
        return (
          "<tr>" +
          "<td>" +
          fmtDate(a.login_at) +
          "</td>" +
          "<td>" +
          esc(a.email || "—") +
          "</td>" +
          '<td><span class="badge ' +
          evtClass +
          '">' +
          esc(a.event_type) +
          "</span></td>" +
          "<td>" +
          esc(a.ip_address || "—") +
          "</td>" +
          "<td>" +
          (esc(loc) || '<span class="muted">—</span>') +
          "</td>" +
          "<td>" +
          (esc(dev) || '<span class="muted">—</span>') +
          "</td>" +
          "<td>" +
          fmtDuration(a.duration_seconds) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    $("auditBody").innerHTML = html;
  }

  /* ---------- wiring ---------- */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    handleUserAction(
      btn.getAttribute("data-act"),
      btn.getAttribute("data-id"),
      btn.getAttribute("data-email"),
      btn
    );
  });

  $("createUserForm").addEventListener("submit", handleCreateUser);
  $("userSearch").addEventListener("input", renderUsers);
  $("auditSearch").addEventListener("input", renderAudit);
  $("refreshUsers").addEventListener("click", loadAll);
  $("refreshAudit").addEventListener("click", loadAll);
  $("logoutBtn").addEventListener("click", function () {
    var b = $("logoutBtn");
    b.disabled = true;
    b.textContent = "…";
    IDB.logout().then(function () {
      location.href = "login.html";
    });
  });

  guard();
})();
