import { useEffect, useState } from "react";
import { supabase } from "./supabase.ts";

export type SessionState = {
  status: "unconfigured" | "loading" | "signed-out" | "ready";
  email: string | null;
  userId: string | null;
  error: string | null;
  /** True after Supabase reports a PASSWORD_RECOVERY sign-in from the reset link. */
  recovery?: boolean;
};

const signedOut: SessionState = { status: "signed-out", email: null, userId: null, error: null };

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(
    supabase ? { status: "loading", email: null, userId: null, error: null } : { status: "unconfigured", email: null, userId: null, error: null },
  );

  useEffect(() => {
    if (!supabase) return undefined;
    let cancel = false;
    // A recovery link puts type=recovery in the URL hash; remember it before the client consumes the hash.
    let recoveryLink = window.location.hash.includes("type=recovery");
    supabase.auth.getSession().then(({ data, error }) => {
      if (cancel) return;
      if (error) {
        setState({ ...signedOut, error: error.message });
        return;
      }
      const user = data.session?.user;
      setState(user
        ? { status: "ready", email: user.email ?? null, userId: user.id, error: null, recovery: recoveryLink }
        : signedOut);
    }).catch((error: unknown) => {
      if (cancel) return;
      setState({ ...signedOut, error: error instanceof Error ? error.message : "Could not read the session." });
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "USER_UPDATED") recoveryLink = false;
      const user = session?.user;
      setState(user
        ? { status: "ready", email: user.email ?? null, userId: user.id, error: null, recovery: event === "PASSWORD_RECOVERY" || (recoveryLink && event !== "USER_UPDATED") }
        : signedOut);
    });
    return () => {
      cancel = true;
      data.subscription.unsubscribe();
    };
  }, []);

  return state;
}
