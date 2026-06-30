// admin-users: privileged user management for the IDB dashboard.
// Verifies the caller is an authenticated admin (via their JWT + profiles.role),
// then performs service-role actions: list users, change role, activate/
// deactivate, delete user.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// A long ban duration acts as an indefinite deactivation; 'none' lifts it.
const BAN_FOREVER = '876000h'; // ~100 years

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Missing authorization token' }, 401);

    // Identify the caller from their JWT.
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);
    const callerId = userData.user.id;

    // Service-role client (bypasses RLS) for privileged work.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authorize: caller must be an admin.
    const { data: callerProfile, error: profErr } = await admin
      .from('profiles').select('role').eq('id', callerId).single();
    if (profErr || !callerProfile || callerProfile.role !== 'admin') {
      return json({ error: 'Forbidden: administrator access required' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action as string;

    if (action === 'list_users') {
      const { data, error } = await admin
        .from('profiles')
        .select('id, email, full_name, role, is_active, created_at, updated_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return json({ users: data ?? [] });
    }

    if (action === 'set_role') {
      const userId = body?.user_id as string;
      const role = body?.role as string;
      if (!userId || !['viewer', 'admin'].includes(role)) return json({ error: 'Invalid parameters' }, 400);
      const { data, error } = await admin.from('profiles').update({ role }).eq('id', userId).select('id');
      if (error) throw error;
      if (!data || data.length === 0) return json({ error: 'User not found' }, 404);
      // Mirror role into auth app_metadata (handy for JWT-based checks).
      await admin.auth.admin.updateUserById(userId, { app_metadata: { role } }).catch(() => {});
      return json({ ok: true, user_id: userId, role });
    }

    if (action === 'set_active') {
      const userId = body?.user_id as string;
      // Accept `active` (current client) or `is_active` (older cached client),
      // and coerce string/number forms so a stale frontend bundle still works.
      let active: unknown = body?.active;
      if (active === undefined || active === null) active = body?.is_active;
      if (typeof active === 'string') active = active === 'true' || active === '1';
      else if (typeof active === 'number') active = active !== 0;
      if (!userId || typeof active !== 'boolean') return json({ error: 'Invalid parameters' }, 400);
      if (userId === callerId) return json({ error: 'You cannot deactivate your own account' }, 400);

      // 1) Flag in the profile (used by the UI + client-side checks).
      const { data, error } = await admin
        .from('profiles').update({ is_active: active }).eq('id', userId).select('id');
      if (error) throw error;
      if (!data || data.length === 0) return json({ error: 'User not found' }, 404);

      // 2) Enforce at the auth level: a deactivated user is banned (cannot
      //    sign in and existing sessions stop refreshing). Reactivating unbans.
      const { error: banErr } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: active ? 'none' : BAN_FOREVER,
      });
      if (banErr) {
        // Roll back the profile flag so UI and auth stay consistent.
        await admin.from('profiles').update({ is_active: !active }).eq('id', userId);
        throw banErr;
      }
      return json({ ok: true, user_id: userId, is_active: active });
    }

    if (action === 'delete_user') {
      const userId = body?.user_id as string;
      if (!userId) return json({ error: 'Invalid parameters' }, 400);
      if (userId === callerId) return json({ error: 'You cannot delete your own account' }, 400);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error; // FK cascade removes the profile row too
      return json({ ok: true, deleted: userId });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
