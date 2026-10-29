# Negotiation sandbox

A small, operator-controlled sandbox for two-party, multi-issue negotiation. Scenario files are data. A deterministic referee enforces offers, acceptance and walking away. Structured claims an agent makes about its own private card are checked against that card. Every match produces a JSONL transcript that replays and recomputes without any model call, and a pairing table compares configurations on the same sampled instances.

> **Status: Dirty Mode construction - runtime unverified.** Source and tests are written. Nothing has been installed, type-checked, built, tested, started, migrated or deployed. The only executed check is a syntax parse of the `.ts` source files with `node --check` (Node 24.18.0); the declaration file `src/vite-env.d.ts` cannot be parsed that way and is left to `tsc`. `.tsx` files have only been inspected. See [docs/DEFERRED-VALIDATION.md](docs/DEFERRED-VALIDATION.md). No result numbers appear in this README because the sample generator has not run.

"Private" means absent from the counterpart agent's observation and model request. The browser operator configures and sees both cards, and full exports contain them. This is an owner-supplied simulation, not server-authoritative secret execution and not proof that an unedited provider produced a whole match.

## What is built

- **Scenarios.** Schema v1 (the two original files, kept byte-for-byte under their legacy ruleset) and schema v2 (`fixtures/scenarios/`): warehouse lease, design retainer, and a tiny no-ZOPA fixture. v2 adds role display labels, versioned limits and bounded typed card variation. Paste, validate (duplicate keys and unknown fields rejected) and download JSON.
- **Instances.** `instantiate(definition, seed)` builds the full immutable instance before play with sampler `nsb-instance-v1` (FNV-1a seeded xorshift32 field streams, rejection sampling). `instance_id` is the SHA-256 of the canonical concrete instance. v1 files are fixed instances.
- **Referee.** Strict whole-output JSON actions (`offer`/`accept`/`walk`, note, own-card claims), exact decimal grid legality, at most `2*maxRounds` legal turns with the canonical final-turn cap, terminal immutability, one error-informed repair for model and fixture seats, distinct failure statuses.
- **Agents.** Scripted `concession`, `firm` and `bluff` policies with per-role policy seed streams, a hand-authored synthetic fixture seat (`fixtures/agents/`, labelled synthetic, declared-cell only), and one OpenAI-compatible Live seat through `negotiate-turn`.
- **Measurement.** Exact enumeration of the legal grid (<= 20,000 packages): utilities, gains over the sampled reservation, IR, IR-qualified efficiency with null reasons, Pareto domination, empty ZOPA, missed deals, and structured-claim measures with their own denominators. No honesty score, no LLM judge, no confidence intervals.
- **Artifacts.** RunSpec v1 with `run_spec_sha256`, JSONL transcript v2 (header, attempts, footer), full verification on import/load/resume, does-not-reproduce errors for tampered caches, exact request digests and prompt inspection, `games.csv`/`turns.csv`.
- **UI.** Scenarios, Bench (Sandbox/Live mode, pairing matrix, sequential run with cancel), Results (denominators, paired differences, downloads, save), Replay (public/buyer/seller/operator lenses, claim evidence, prompt and digest, import/export), Account (email/password, recovery, saved runs).
- **Live seam.** `negotiate-turn` (user JWT, allowlisted models and host, size/time bounds, service-only atomic claim/finish ledger over the existing 40 attempts per UTC day) and a forward migration. See [BOLT-HANDOFF.md](BOLT-HANDOFF.md).

## Offline demo journey (no env, no login, no database, no provider)

1. Open the app. Sandbox is selected and a setup banner says what Live and saving need.
2. Scenarios: pick **Warehouse lease (v2, sampled cards)**. Inspect the public scenario, an instance seed, the operator cards and the ZOPA explanation.
3. Bench: the default is three ordered pairings (concession/concession, concession/firm, bluff/concession) over instance seeds 1 and 2 = six matches, zero paid calls. Run sequentially.
4. Results: agreement, walk and cap are separate; utilities, gains, claim k/n and failures each show their denominators. Open a replay and switch lenses.
5. Bench: run the synthetic fixture demonstration (warehouse-lease-v2, seed 1, buyer fixture vs concession seller): an illegal accept, validation feedback, one repair and a false structured claim, all refereed. Its outcome is whatever the engine computes.
6. Replay: export the JSONL, re-import it (it reproduces). Edit a cached footer metric and import again: the page shows "Does not reproduce" and the recomputed value.
7. Replay: "Show prompt" rebuilds a role request and its digest; the counterpart card is absent. Paste `fixtures/scenarios/design-retainer-v2.json` and repeat.
8. Later, only when separately authorized and configured: sign in and run one Live cell (one instance, maxRounds 6, at most 24 paid attempts for model vs model, 12 for one model seat). Missing configuration blocks Live explicitly; nothing is replaced by scripted play.

## Run it (after installation is authorized)

Node 22.6 or newer (built-in type stripping). Work in this folder.

```powershell
npm install          # first install creates the lockfile; use npm ci afterwards
npm run typecheck    # tsc --noEmit
npm run build        # vite build
npm test             # node --experimental-strip-types --test "tests/*.test.ts"
npm run dev          # vite
npm run sample-results   # writes sample-results/ (JSONL, CSV, summary.json); never calls a provider
```

None of these has been run. If the Node type-strip loader cannot run the tests, adopt Vitest explicitly and document it.

## Configuration names (no values here)

- Browser (public): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (see `.env.example`). Empty values give the setup banner and a fully working Sandbox.
- Server secrets for `negotiate-turn` (never `VITE_`): `LLM_API_KEY` (required for Live), `LLM_ALLOWED_MODELS` (required, comma-separated), `LLM_ALLOWED_HOSTS` (required, exact hosts, e.g. the host of `LLM_BASE_URL`), `LLM_BASE_URL` (optional, default `https://api.openai.com/v1`), `LLM_MODEL` (optional default, must be allowlisted), `APP_ORIGIN` (comma-separated allowed browser origins for CORS).
- Platform-injected: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## Layout

- `supabase/functions/_shared/` - the one pure engine (also imported by the Vite app through `src/engine.ts`).
- `supabase/functions/negotiate-turn/` - `handler.ts` (logic, injectable) and `index.ts` (Deno entry).
- `supabase/migrations/` - `20261023180000_init.sql` (baseline, unchanged) and `20261023190000_v2_artifacts_and_model_calls.sql` (forward).
- `src/` - React 18 + Vite UI, query-string router (the URL hash is left for auth recovery).
- `fixtures/` - v1 files, `scenarios/` (v2), `agents/` (synthetic fixture).
- `tests/` - `node:test` suites (written, not run). `scripts/sample-results.ts` - generator (written, not run).

## Prior art

Ideas only, implemented independently; no upstream code, prompts or datasets were copied: negotiation-harness (explicit run specs, common instances, feedback repair), NegotiationArena (fresh match history, replay perspectives), AgenticPay (bounded additive utilities).

## Licence

MIT, see [LICENSE](LICENSE).
