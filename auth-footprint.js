/* =====================================================================
 * Digital-footprint capture + session/duration tracking.
 * Depends on window.IDB (convex-client.js).
 *
 * On login we call the Convex `/log-event` HTTP action, which records the
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

  // Direct mutation call so it also works from an unload handler (keepalive).
  // Returns a promise that never rejects, so callers can sequence on it.
  function patchLog(logId, payload, keepalive) {
    var token = IDB.auth.getToken();
    if (!logId || !token) return Promise.resolve();
    try {
      return IDB.mutation(
        "audit:patchLog",
        {
          token: token,
          log_id: logId,
          last_seen_at: payload.last_seen_at,
          logout_at: payload.logout_at,
          duration_seconds: payload.duration_seconds,
        },
        { keepalive: !!keepalive }
      ).catch(function () {});
    } catch (e) {
      return Promise.resolve();
    }
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
    heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
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

  // Fallback when the /log-event HTTP action is unreachable: plain mutation
  // insert (no IP/geo, which only the HTTP action can capture).
  function clientInsertFallback(user, payload, sessionId) {
    var token = IDB.auth.getToken();
    if (!token) return Promise.resolve(null);
    return IDB.mutation("audit:clientInsert", {
      token: token,
      payload: payload,
    })
      .then(function (res) {
        if (!res || !res.ok) {
          console.warn(
            "[IDB] audit fallback insert failed:",
            res && res.error
          );
          return null;
        }
        beginTracking(res.id, user.id, sessionId);
        return res.id;
      })
      .catch(function (err) {
        console.warn("[IDB] audit fallback insert failed:", err.message);
        return null;
      });
  }

  /* ---- public API ----------------------------------------------------- */

  // Record a login (or session resume): server-side IP/geo via /log-event.
  function recordLogin(user, opts) {
    opts = opts || {};
    var sessionId = uuid();
    var payload = Object.assign(
      { event_type: opts.eventType || "login", session_id: sessionId },
      collectDevice()
    );
    var token = IDB.auth.getToken();
    if (!token) return Promise.resolve(null);
    return fetch(IDB.SITE_URL + "/log-event", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
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
  }
  IDB.recordLogin = recordLogin;

  // Keep an existing session's tracking alive, or start a "session_resume".
  function ensureTracking() {
    var session = IDB.auth.getSession();
    if (!session) {
      clearSession();
      return Promise.resolve(null);
    }
    var s = readSession();
    if (s && s.userId === session.user.id) {
      startHeartbeat();
      installUnloadHandler();
      return Promise.resolve(s.logId);
    }
    return recordLogin(session.user, { eventType: "session_resume" });
  }
  IDB.ensureTracking = ensureTracking;

  // Finalise the current session row, then sign out. The patch must settle
  // BEFORE signOut: signOut deletes the server-side session, which would
  // reject the patch's token. A short timeout guard keeps a hung patch from
  // blocking logout.
  function logout() {
    var s = readSession();
    var patched = Promise.resolve();
    if (s) {
      patched = patchLog(s.logId, {
        logout_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        duration_seconds: secsSince(s.loginAtMs),
      });
    }
    stopHeartbeat();
    clearSession();
    var timeout = new Promise(function (res) {
      setTimeout(res, 2000);
    });
    return Promise.race([patched, timeout]).then(function () {
      return IDB.auth.signOut();
    });
  }
  IDB.logout = logout;
})();
