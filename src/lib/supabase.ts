import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";

export const supabaseConfigError = url && anonKey
  ? null
  : "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to save runs and call a model. Scripted games still run in this browser.";

export const supabase: SupabaseClient | null = url && anonKey
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
