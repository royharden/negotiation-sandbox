import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";

export const supabaseConfigError = url && anonKey
  ? null
  : "Setup: Sandbox works now with no configuration. Saving runs and Live model seats need VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (Bolt Database), a signed-in owner, and server secrets on negotiate-turn.";

export const supabase: SupabaseClient | null = url && anonKey
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
