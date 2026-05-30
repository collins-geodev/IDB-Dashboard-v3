/* Admin console: user management + audit trail.
 * Privileged mutations go through the `admin-users` Edge Function
 * (service role, admin-verified). Reads use RLS-protected queries. */
(function () {
  var sb = window.IDB && window.IDB.sb;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var me = null; // current admin user
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

  // Call the admin-users Edge Function with the caller's JWT.
  function callFn(action, payload) {
    return sb.auth.getSession().then(function (r) {
      var token = r.data && r.data.session ? r.data.session.access_token : null;
      return fetch(IDB.URL + "/functions/v1/admin-users", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          apikey: IDB.ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      }).then(function (resp) {
        return resp
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { status: resp.status, body: body };
          });
      });
    });
  }

  /* ---------- access guard ---------- */
  function denied(message) {
    $("gateMsg").innerHTML = esc(message);
    $("gateActions").style.display = "";
  }

  function guard() {
    if (!sb) {
      denied("Authentication failed to initialise. Please refresh.");
      return;
    }
    sb.auth.getSession().then(function (res) {
      var session = res.data ? res.data.session : null;
      if (!session) {
        location.href = "login.html?next=admin.html";
        return;
      }
      me = session.user;
      sb.from("profiles")
        .select("role, full_name, email")
        .eq("id", me.id)
        .single()
        .then(function (r) {
          if (r.error || !r.data || r.data.role !== "admin") {
            denied(
              "Access denied. This area is restricted to administrators."
            );
            return;
          }
          // Keep tracking this admin's session for the audit trail.
          IDB.ensureTracking();
          startApp(r.data);
        });
    });
  }

  function startApp(profile) {
    $("gate").style.display = "none";
    $("app").style.display = "";
    $("who").textContent =
      "Signed in as " + (profile.email || me.email) + " · Administrator";
    loadAll();
  }

  /* ---------- data ---------- */
  function loadAll() {
    $("usersBody").innerHTML =
      '<tr><td colspan="5" class="empty"><span class="spin"></span></td></tr>';
    $("auditBody").innerHTML =
      '<tr><td colspan="7" class="empty"><span class="spin"></span></td></tr>';

    Promise.all([
      sb
        .from("profiles")
        .select("id, email, full_name, role, created_at")
        .order("created_at", { ascending: false }),
      sb
        .from("audit_logs")
        .select("*")
        .order("login_at", { ascending: false })
        .limit(500),
    ]).then(function (results) {
      var uRes = results[0],
        aRes = results[1];
      if (uRes.error) {
        $("usersBody").innerHTML =
          '<tr><td colspan="5" class="empty">Failed to load users: ' +
          esc(uRes.error.message) +
          "</td></tr>";
      }
      if (aRes.error) {
        $("auditBody").innerHTML =
          '<tr><td colspan="7" class="empty">Failed to load audit: ' +
          esc(aRes.error.message) +
          "</td></tr>";
      }
      allUsers = uRes.data || [];
      allAudit = aRes.data || [];

      // last login per user
      lastLoginByUser = {};
      allAudit.forEach(function (a) {
        if (!a.user_id) return;
        if (!lastLoginByUser[a.user_id]) lastLoginByUser[a.user_id] = a.login_at;
      });

      renderStats();
      renderUsers();
      renderAudit();
    });
  }

  function renderStats() {
    var admins = allUsers.filter(function (u) {
      return u.role === "admin";
    }).length;
    var since = Date.now() - 24 * 3600 * 1000;
    var logins24 = allAudit.filter(function (a) {
      return new Date(a.login_at).getTime() >= since;
    }).length;
    $("statUsers").textContent = allUsers.length;
    $("statAdmins").textContent = admins;
    $("statViewers").textContent = allUsers.length - admins;
    $("statLogins").textContent = logins24;
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
        '<tr><td colspan="5" class="empty">No users found.</td></tr>';
      return;
    }

    var html = rows
      .map(function (u) {
        var isSelf = u.id === me.id;
        var roleBadge =
          '<span class="badge ' +
          (u.role === "admin" ? "admin" : "viewer") +
          '">' +
          esc(u.role) +
          "</span>";

        var actions = "";
        if (isSelf) {
          actions = '<span class="muted">— you —</span>';
        } else if (u.role === "admin") {
          actions =
            '<button class="btn btn-ghost btn-sm" data-act="demote" data-id="' +
            esc(u.id) +
            '">Make Viewer</button>' +
            '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' +
            esc(u.id) +
            '" data-email="' +
            esc(u.email) +
            '">Delete</button>';
        } else {
          actions =
            '<button class="btn btn-ghost btn-sm" data-act="promote" data-id="' +
            esc(u.id) +
            '">Make Admin</button>' +
            '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' +
            esc(u.id) +
            '" data-email="' +
            esc(u.email) +
            '">Delete</button>';
        }

        var name = u.full_name
          ? '<div>' + esc(u.full_name) + "</div>"
          : "";
        return (
          "<tr>" +
          "<td>" +
          name +
          '<div class="muted">' +
          esc(u.email) +
          "</div></td>" +
          "<td>" +
          roleBadge +
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
      callFn("set_role", { user_id: id, role: role }).then(function (r) {
        if (r.status === 200 && r.body.ok) {
          toast("Role updated to " + role + ".", "ok");
          loadAll();
        } else {
          btn.disabled = false;
          toast((r.body && r.body.error) || "Failed to update role.", "err");
        }
      });
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
      callFn("delete_user", { user_id: id }).then(function (r) {
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
