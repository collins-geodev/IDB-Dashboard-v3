/* =====================================================================
 * Digital-footprint capture + session/duration tracking.
 * Depends on window.IDB.sb (supabase-client.js).
 *
 * On login we call the `log-event` Edge Function, which records the
 * authoritative client IP (from request headers) + a server-side geo
 * lookup, merged with the device fingerprint collected here. While the
 * session is active a heartbeat keeps duration_seconds fresh; on logout
 * / tab close we finalise logout_at + duration_seconds.
 * ===================================================================== */
(function () {
  var IDB = (window.IDB = window.IDB || {});
  var SESSION_KEY = "idb-audit-session";
  var HEARTBEAT_MS = 60 * 1000;
  var heartbeatTimer = null;
  var cachedAccessToken = null;

  /* ---- helpers -------------------------------------------------------- */

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function parseUserAgent(ua) {
    ua = ua || "";
    var browser = "Unknown",
      os = "Unknown",
      device = "Desktop";

    if (/edg/i.test(ua)) browser = "Edge";
    else if (/opr|opera/i.test(ua)) browser = "Opera";
    else if (/chrome|crios/i.test(ua)) browser = "Chrome";
    else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
    else if (/safari/i.test(ua)) browser = "Safari";

    if (/windows nt/i.test(ua)) os = "Windows";
    else if (/android/i.test(ua)) os = "Android";
    else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";
    else if (/mac os x/i.test(ua)) os = "macOS";
    else if (/cros/i.test(ua)) os = "ChromeOS";
    else if (/linux/i.test(ua)) os = "Linux";

    if (/mobile|iphone|ipod/i.test(ua)) device = "Mobile";
    else if (/ipad|tablet/i.test(ua)) device = "Tablet";

    return { browser: browser, os: os, device_type: device };
  }
  IDB.parseUserAgent = parseUserAgent;

  // Device fingerprint (synchronous; IP/geo are added server-side).
  function collectDevice() {
    var ua = navigator.userAgent;
    var parsed = parseUserAgent(ua);
    return {
      user_agent: ua,
      browser: parsed.browser,
      os: parsed.os,
      device_type: parsed.device_type,
      screen_resolution: window.screen ? screen.width + "x" + screen.height : null,
      language: navigator.language || null,
      timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || null,
      referrer: document.referrer || null,
      page: location.pathname,
      extra: {
        viewport: window.innerWidth + "x" + window.innerHeight,
        platform: navigator.platform || null,
        languages: navigator.languages || null,
        cores: navigator.hardwareConcurrency || null,
        memory: navigator.deviceMemory || null,
        touch: navigator.maxTouchPoints || 0,
        connection:
          navigator.connection && navigator.connection.effectiveType
            ? navigator.connection.effectiveType
            : null,
      },
    };
  }
  IDB.collectDevice = collectDevice;

  /* ---- session state -------------------------------------------------- */

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function writeSession(obj) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(obj));
    } catch (e) {}
  }
  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  function refreshToken() {
    return IDB.sb.auth.getSession().then(function (res) {
      var tok =
        res && res.data && res.data.session ? res.data.session.access_token : null;
      if (tok) cachedAccessToken = tok;
      return cachedAccessToken;
    });
  }

  // Direct REST PATCH so it also works from an unload handler (keepalive).
  function patchLog(logId, payload, keepalive) {
    if (!logId || !cachedAccessToken) return;
    try {
      fetch(IDB.URL + "/rest/v1/audit_logs?id=eq." + logId, {
        method: "PATCH",
        keepalive: !!keepalive,
        headers: {
          apikey: IDB.ANON_KEY,
          Authorization: "Bearer " + cachedAccessToken,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {}
  }

  function secsSince(ms) {
    return Math.max(0, Math.round((Date.now() - ms) / 1000));
  }

  function beat() {
    var s = readSession();
    if (!s) return;
    patchLog(s.logId, {
      last_seen_at: new Date().toISOString(),
      duration_seconds: secsSince(s.loginAtMs),
    });
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      refreshToken().then(beat);
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function installUnloadHandler() {
    if (IDB._unloadInstalled) return;
    IDB._unloadInstalled = true;
    var flush = function () {
      var s = readSession();
      if (!s) return;
      patchLog(
        s.logId,
        {
          last_seen_at: new Date().toISOString(),
          duration_seconds: secsSince(s.loginAtMs),
        },
        true
      );
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flush();
    });
  }

  function beginTracking(logId, userId, sessionId) {
    writeSession({
      logId: logId,
      userId: userId,
      sessionId: sessionId,
      loginAtMs: Date.now(),
    });
    startHeartbeat();
    installUnloadHandler();
  }

  // Fallback when the edge function is unreachable: client insert (no IP).
  function clientInsertFallback(user, payload, sessionId) {
    var row = Object.assign(
      {
        user_id: user.id,
        email: user.email,
        login_at: new Date().toISOString(),
        session_id: sessionId,
      },
      payload
    );
    return IDB.sb
      .from("audit_logs")
      .insert(row)
      .select("id")
      .single()
      .then(function (res) {
        if (res.error) {
          console.warn("[IDB] audit fallback insert failed:", res.error.message);
          return null;
        }
        beginTracking(res.data.id, user.id, sessionId);
        return res.data.id;
      });
  }

  /* ---- public API ----------------------------------------------------- */

  // Record a login (or session resume): server-side IP/geo via log-event.
  function recordLogin(user, opts) {
    opts = opts || {};
    var sessionId = uuid();
    var payload = Object.assign(
      { event_type: opts.eventType || "login", session_id: sessionId },
      collectDevice()
    );
    return refreshToken().then(function (token) {
      return fetch(IDB.URL + "/functions/v1/log-event", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          apikey: IDB.ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (res) {
          if (res && res.id) {
            beginTracking(res.id, user.id, sessionId);
            return res.id;
          }
          throw new Error((res && res.error) || "log-event failed");
        })
        .catch(function (err) {
          console.warn("[IDB] server log failed, using fallback:", err.message);
          return clientInsertFallback(user, payload, sessionId);
        });
    });
  }
  IDB.recordLogin = recordLogin;

  // Keep an existing session's tracking alive, or start a "session_resume".
  function ensureTracking() {
    return IDB.sb.auth.getSession().then(function (res) {
      var session = res && res.data ? res.data.session : null;
      if (!session) {
        clearSession();
        return null;
      }
      cachedAccessToken = session.access_token;
      var s = readSession();
      if (s && s.userId === session.user.id) {
        startHeartbeat();
        installUnloadHandler();
        return s.logId;
      }
      return recordLogin(session.user, { eventType: "session_resume" });
    });
  }
  IDB.ensureTracking = ensureTracking;

  // Finalise the current session row, then sign out.
  function logout() {
    var s = readSession();
    return refreshToken()
      .then(function () {
        if (s) {
          patchLog(s.logId, {
            logout_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            duration_seconds: secsSince(s.loginAtMs),
          });
        }
      })
      .then(function () {
        stopHeartbeat();
        clearSession();
        return IDB.sb.auth.signOut();
      });
  }
  IDB.logout = logout;
})();
