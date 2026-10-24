import { useEffect, useState } from "react";
import { pairingLabel } from "../format.ts";
import { deleteRun, loadRuns, type SavedRun } from "../lib/repository.ts";
import type { SessionState } from "../lib/session.ts";
import { supabase, supabaseConfigError } from "../lib/supabase.ts";
import { navigate } from "../route.ts";
import type { SessionBatch } from "../savedBatch.ts";
import { savedToBatch } from "../savedBatch.ts";

export function Account(props: {
  session: SessionState;
  onReplay: (batch: SessionBatch) => void;
  onNotice: (message: string | null) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [error, setError] = useState<string | null>(props.session.error);

  useEffect(() => {
    if (props.session.status !== "ready") {
      setRuns([]);
      return;
    }
    let cancel = false;
    loadRuns().then((result) => {
      if (cancel) return;
      setRuns(result.rows);
      if (result.error) setError(result.error);
    });
    return () => { cancel = true; };
  }, [props.session.status, props.session.userId]);

  async function signIn() {
    if (!supabase) return;
    setBusy(true);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    setError(authError?.message ?? null);
  }

  async function signUp() {
    if (!supabase) return;
    setBusy(true);
    const { error: authError } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    setError(authError?.message ?? null);
    if (!authError) props.onNotice("Account created. If confirmation is required, confirm the email and then sign in.");
  }

  async function signOut() {
    if (!supabase) return;
    const { error: authError } = await supabase.auth.signOut();
    setError(authError?.message ?? null);
  }

  async function sendReset() {
    if (!supabase) return;
    setBusy(true);
    const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setBusy(false);
    setError(authError?.message ?? null);
    if (!authError) props.onNotice("Reset email requested. Open it on this site, then set a new password while signed in.");
  }

  async function changePassword() {
    if (!supabase) return;
    setBusy(true);
    const { error: authError } = await supabase.auth.updateUser({ password: nextPassword });
    setBusy(false);
    setError(authError?.message ?? null);
    if (!authError) {
      setNextPassword("");
      props.onNotice("Password updated.");
    }
  }

  return (
    <section className="panel">
      <h2>Account</h2>
      {supabaseConfigError ? <p>{supabaseConfigError}</p> : null}
      {props.session.status === "loading" ? <p>Checking the session…</p> : null}
      {props.session.status === "ready" ? (
        <>
          <p>Signed in as {props.session.email ?? "an account without an email address"}.</p>
          <label htmlFor="next-password">New password</label>
          <input id="next-password" type="password" autoComplete="new-password" minLength={6} value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} />
          <div className="actions">
            <button type="button" disabled={busy || nextPassword.length < 6} onClick={() => void changePassword()}>Update password</button>
            <button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button>
          </div>
        </>
      ) : null}
      {props.session.status === "signed-out" ? (
        <>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} />
          <div className="actions">
            <button type="button" disabled={busy || !supabase} onClick={() => void signIn()}>Sign in</button>
            <button type="button" className="secondary" disabled={busy || !supabase} onClick={() => void signUp()}>Create account</button>
            <button type="button" className="secondary" disabled={busy || !supabase || !email} onClick={() => void sendReset()}>Email a reset link</button>
          </div>
        </>
      ) : null}
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {props.session.status === "ready" ? (
        <>
          <h3>Saved runs</h3>
          {runs.length === 0 ? <p>No saved runs yet.</p> : (
            <ul>
              {runs.map((run) => (
                <li key={run.id}>
                  {run.scenarioSlug}, seed {run.seed}, {pairingLabel(run.buyerAgent, run.sellerAgent)}, {run.status}
                  <div className="actions">
                    <button type="button" onClick={() => {
                      const batch = savedToBatch(run);
                      if (!batch.ok) {
                        setError(batch.error);
                        return;
                      }
                      props.onReplay(batch.batch);
                      navigate("replay", { row: "0" });
                    }}>Replay</button>
                    <button type="button" className="secondary" onClick={() => void deleteRun(run.id).then((message) => {
                      if (message) setError(message);
                      else setRuns((current) => current.filter((item) => item.id !== run.id));
                    })}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
