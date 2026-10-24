# Deferred validation

Built under Dirty Mode (static-only construction, 2026-10-23). This is the handoff list of what has **not** been proven. Nothing here has passed; missing output is not a pass. Record each later command and its real result next to its row.

What did run: `node --check` (Node 24.18.0, built-in type stripping) on every `.ts` file under `supabase/functions/`, `src/` (`.ts` only), `tests/` and `scripts/`. That is a syntax parse, not a type check. `.tsx` files were only inspected. Independent static reviews of each package are logged in the outer `STATUS.md`.

| Component | Pending assumption or skipped check | Later activation step |
|---|---|---|
| Dependencies/runtime | No install, no lockfile, no `tsc`, no Vite build. Declared versions are unverified together. | `npm install` once (creates the lockfile, commit it), then `npm ci`, `npm run typecheck`, `npm run build`. |
| Tests | `tests/*.test.ts` are written with hand-derived expectations and never executed. Node's type-strip loader running them is unverified. | `npm test`. If the loader cannot run them, adopt Vitest explicitly and document it. Fix real failures in source; never weaken an oracle without recording why. |
| Engine/replay | Sampler, enumeration, referee cap rule, metrics and transcript verification exist in source only. | Units above, plus: export -> import reproduces; tampered footer/action/config is rejected; legacy v1 oracles still hold. |
| Sampler known answers | Stream encoding is pinned by a structural test; no fixed seed -> value table is recorded yet. | At first authorized run, record one instance's sampled card values per bundled fixture as a known-answer test (a later change then needs a new generator version). |
| Browser | Routing, rendering, responsiveness (up to 180 matches), cancellation, keyboard use and auth recovery are unverified. | `npm run dev`; walk README's offline journey including negative imports, signed-out Live, missing-key Live and a failed save. Check a 180-match sweep before advertising it. |
| Sample results | `scripts/sample-results.ts` never ran; no result numbers exist. | `npm run sample-results`; cite its `run_spec_sha256`, engine version and file hashes for any number used in docs. |
| Function/Deno | `negotiate-turn` never ran in Deno; shared `../_shared/` bundling, `npm:@supabase/supabase-js@2.49.1`, CORS and JWT behaviour unverified. | Deno-context checks; authorized deployed round trips for config, auth failure, terminal history and limits. Move the canonical engine only if bundling fails. |
| Migration baseline | Both migrations unapplied; target history unknown. | Read the target's migration history/schema first; apply only pending files in order. |
| RLS/grants | Owner isolation, model_calls owner-only reads, service-only claim/finish and the scenario reference check are unverified. SQL text tests are smoke checks only. | Anonymous + two real user clients; forged owner and foreign scenario_id; authenticated execution of claim/finish/reserve_llm_turn must fail. |
| Quota/dedup | Atomic claim, at-most-one `acquired_new`, cap behaviour and pending/uncertain handling are not demonstrated. | Concurrent same/different operation ids near the cap, same turn ordinal under a new id, altered digest, repair ownership, a crash between dispatch and finish. |
| Provider | Model ids, JSON compliance, context limits, usage fields, error shapes and costs are unknown. | Check current official docs, then an explicitly authorized tiny pilot (one cell, one instance). |
| Request linkage | Browser request rebuild vs server digest never compared. | One live attempt and one repair with matching request/output digests. |
| Auth/deployment | Signup policy, confirmation, Site URL and redirect allowlist undecided. | Owner chooses (recommended invite-only); test sign-in, sign-out and recovery on the deployed origin. |
| Statistics | Descriptive tables only; two seeds do not support inference. | Later research must resample independent instances and disclose missing paired cells. |
| Git/import | Local repository only, no remote, no push. | Owner decides on a remote and a GitHub import under the current authorization. |
