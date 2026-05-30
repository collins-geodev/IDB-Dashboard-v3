/* =====================================================================
 * Shared Supabase client for the IDB Assets Dashboard.
 * Loaded after the supabase-js UMD bundle (window.supabase).
 * Exposes:  window.IDB.sb        -> the Supabase client
 *           window.IDB.URL       -> project URL
 *           window.IDB.ANON_KEY  -> public anon key
 * ===================================================================== */
(function () {
  var SUPABASE_URL = "https://mvfguayhttcdeibomjru.supabase.co";
  // Public anon key (safe to expose in the browser; RLS protects the data).
  var SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12Zmd1YXlodHRjZGVpYm9tanJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NTYzMzUsImV4cCI6MjA5MzEzMjMzNX0.yxOp3N12z4XO6AfzZhSQZcvljlPsGo0RUroxnhZ4O-M";

  if (!window.supabase || !window.supabase.createClient) {
    console.error("[IDB] supabase-js not loaded before supabase-client.js");
    return;
  }

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "idb-auth",
    },
  });

  window.IDB = window.IDB || {};
  window.IDB.sb = sb;
  window.IDB.URL = SUPABASE_URL;
  window.IDB.ANON_KEY = SUPABASE_ANON_KEY;
})();
