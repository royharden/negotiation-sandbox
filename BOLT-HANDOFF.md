# Bolt infrastructure handoff: Negotiation sandbox

No secrets in this file. It is the app's single provisioning inventory. Everything below is source that exists in this repository; nothing has been applied, deployed or verified.

## Target and readiness

- Repository / branch / prepared revision: local-only git repository of this folder (no remote yet), branch `master`. Record the imported revision at import time.
- App root: repository root (this folder). The outer wrapper folder is not part of the app.
- Database: **Bolt Database** (Supabase-compatible SQL, auth and edge functions).
- Target: fresh empty database for a new app. No separate remote Supabase project exists.
- Existing baseline / applied migrations: **Unknown / none applied.** Both migration files are unapplied as far as this source knows; files are not proof.
- Hosting: Bolt hosting.
- Publication: prepare only.
- Bolt action: **Inspect and prepare only.**
- Status: **Dirty Mode construction - runtime unverified.** Implementation written; no install, typecheck, build, test, app start, migration or deploy has run. Infrastructure pending.
- Owner prerequisites: GitHub access for import; an OpenAI-compatible provider account and key for Live (optional); the owner's choice of signup policy (recommended: owner/invite-only).

## Build and connection

| Item | Exact command or configuration name |
|---|---|
| Runtime / package manager | Node >= 22 (`package.json` engines), npm. **No lockfile yet**: the first authorized `npm install` creates it; commit it, then use `npm ci`. |
| Frozen install / dev | `npm ci` (after the lockfile exists) / `npm run dev` |
| Build / output | `npm run build` -> `dist/` (Vite default) |
| Type/lint/tests | `npm run typecheck` (`tsc --noEmit`), `npm test` (`node --experimental-strip-types --test "tests/*.test.ts"`). Latest outcomes: **none run**. Only `node --check` syntax parses of `.ts` files have run. |
| Client file / public env names | `src/lib/supabase.ts`; `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| Missing config behavior | Null client + setup banner; Sandbox (scripted and synthetic seats) runs fully in the browser; saving and Live show explicit setup errors. |

## Database

| Order | Exact migration file | Resources / dependencies | Applied status |
|---|---|---|---|
| 1 | `supabase/migrations/20261023180000_init.sql` | `pgcrypto`; `set_updated_at()` trigger fn; `scenarios` (public catalog + private owner rows, unique slug indexes, trigger); `runs` (owner rows); `llm_turn_usage` (owner/day counter, `turn_count <= 40`); `reserve_llm_turn()`; RLS policies; grants | pending (never applied) |
| 2 | `supabase/migrations/20261023190000_v2_artifacts_and_model_calls.sql` | Depends on 1. `runs`: nullable `artifact_version`, `artifact_jsonl`, `run_spec_sha256`, `definition_sha256`, `instance_id`, `execution_id`, `cell_id`, `replicate`, `content_sha256` with conditional checks (legacy rows unchanged; v2 rows need the <= 1 MiB artifact and digests); unique `(owner_id, execution_id)`; widened status/agent checks for v2 rows only; `runs_insert` now also requires `scenario_id` to be public or owned. New `model_calls` ledger (owner SELECT only, no client writes). `claim_model_attempt(...)` and `finish_model_attempt(...)`: SECURITY DEFINER, `search_path ''`, advisory lock per owner, reuse the existing 40/day counter, execute granted to `service_role` only. Revokes `reserve_llm_turn()` from `authenticated` (function kept). | pending (never applied) |

- Access model: `scenarios` public catalog readable by anon; private scenarios owner-only CRUD. `runs` owner SELECT/INSERT/DELETE, no client UPDATE (saved executions are immutable). `model_calls` owner SELECT only; all writes go through the service-only functions. `llm_turn_usage` has no client access.
- Ownership checks: `owner_id = auth.uid()` on rows; `runs.scenario_id` must reference a public or same-owner scenario. In `negotiate-turn` the verified owner comes only from `auth.getUser(token)`, never the body; the service client never decides identity.
- Extensions/RPC permissions/Realtime: `pgcrypto` (gen_random_uuid). RPCs: `claim_model_attempt` / `finish_model_attempt` -> `service_role` only. Realtime: not required.
- Seeds: `supabase/seed.sql` is an optional synthetic public catalog of the two v1 files (needs a role that bypasses RLS). The v2 built-ins live in source fixtures; a v2 catalog seed is not written.
- Retry rule: inspect migration tracking first, apply only pending files in order, preserve existing data; never drop/recreate tables or edit `20261023180000_init.sql`. Report drift instead of repairing the ledger automatically.
- Known unverified SQL points: `execute function` trigger syntax and `seed.sql`'s `on conflict (slug) where owner_id is null` against the target Postgres; claim/finish atomicity under concurrency.

## Functions

| Name / source | Caller + auth | Input / output | Resources + secret names | Deploy config |
|---|---|---|---|---|
| `negotiate-turn`; `supabase/functions/negotiate-turn/index.ts` (entry) + `handler.ts` (logic) + `../_shared/*.ts` (engine) | Browser with a signed-in user JWT. Gateway `verify_jwt = true` plus handler `auth.getUser(token)`. | Contract `supabase/functions/_shared/liveContract.ts`: `{op:"config"}` -> safe preflight; `{op:"turn", runSpec, executionId, cellId, instanceSeed, replicate, role, legalHistory, attemptNo, operationId, repairOf}` -> `TurnResponse` or `ErrorResponse` | `model_calls`, `llm_turn_usage` via service-only RPCs; secrets `LLM_API_KEY`, `LLM_ALLOWED_MODELS`, `LLM_ALLOWED_HOSTS`, `LLM_BASE_URL`, `LLM_MODEL`, `APP_ORIGIN`; platform `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | `supabase/config.toml`: `[functions.negotiate-turn] verify_jwt = true`. **Unverified:** whether Bolt's function bundler includes the relative `../_shared/` imports. If it cannot, move the canonical engine and update both consumers; never fork a second engine. |

- CORS/preflight: POST and OPTIONS; `Access-Control-Allow-Origin` only for origins listed in `APP_ORIGIN` (none when unset). Headers `authorization, content-type, apikey, x-client-info`.
- Identity/ownership and abuse controls: JWT + getUser; full validation (run spec, cell is a model seat with an allowlisted model, seed/replicate in spec, legal-history replay, terminal/turn checks) before any claim; 100 KiB body read cap; 24,000-byte rendered request cap; 500 output tokens; 20 s timeout; 64 KiB response read; redirects refused; exact host allowlist (not complete SSRF proof).
- Paid API limits: existing 40 attempts per user per UTC day, including invalid outputs, provider errors and repairs; one atomic claim per attempt; only `acquired_new` dispatches; duplicates return cached/pending/uncertain without dispatch; at most one repair per legal turn bound to an owned invalid first attempt; no automatic retry or refund. Bounds are not a dollar budget.
- Webhooks: not required.
- Platform credentials: the three `SUPABASE_*` names are expected to be injected; verify they are available. Never copy values from another project.

## Server secrets to enter through settings

| Name | Consumer | Required / optional | Owner source |
|---|---|---|---|
| `LLM_API_KEY` | negotiate-turn | required for Live | provider account |
| `LLM_ALLOWED_MODELS` | negotiate-turn | required for Live (comma-separated model ids; empty disables Live) | owner decision after checking current provider docs |
| `LLM_ALLOWED_HOSTS` | negotiate-turn | required for Live (exact host of the base URL, e.g. `api.openai.com`) | owner decision |
| `LLM_BASE_URL` | negotiate-turn | optional (default `https://api.openai.com/v1`) | provider |
| `LLM_MODEL` | negotiate-turn | optional default; must be in the allowlist | owner |
| `APP_ORIGIN` | negotiate-turn | required for browser calls (deployed origin(s)) | Bolt hosting URL |

Missing-secret behavior: `503 missing_secret` / `live_disabled` before any quota claim; no fabricated or scripted response. Only public configuration goes in frontend env.

## Auth, storage, and external steps

- Auth providers/confirmation: email/password. Confirmation behaviour is an owner setting. Recommended default: owner/invite-only signup until Roy decides otherwise.
- Site URL and callback/recovery routes: the app root; recovery links return to `window.location.origin` and the Account page shows "set a new password" on the `PASSWORD_RECOVERY` event. Add the deployed origin to the redirect allowlist.
- Buckets: not required. Realtime: not required. Scheduled/long jobs: not required (matrices run sequentially in the browser; closing the tab stops them).
- Outside services: an OpenAI-compatible provider for Live only, with a separately authorized tiny pilot after checking current model ids, context, pricing and error formats.
- Real integrations: Bolt Database auth/tables, `negotiate-turn`. Explicit demos/stubs: scripted policies and the hand-authored synthetic fixture (labelled in the UI and artifacts).

## Acceptance checks and receipts

All pending. Use synthetic data and authorized accounts.

| Check | Expected result | Outcome / receipt |
|---|---|---|
| Import/install/build | branch loads; first install creates the lockfile; `npm ci`, `npm run typecheck`, `npm run build`, `npm test` pass | pending |
| Schema | both migrations applied in order; tables, policies, functions, grants exist | pending |
| Function round trip | `{op:"config"}` and one model attempt return contract responses; server request digest equals the browser rebuild | pending |
| Auth/isolation | anon and user B cannot read/insert user A runs or model_calls; authenticated users cannot execute claim/finish or reserve_llm_turn; forged foreign `scenario_id` refused | pending |
| Missing secret | `503 missing_secret` before any claim, no value disclosure | pending |
| Quota/dedup | concurrent claims near the cap: at most one `acquired_new` per operation/turn ordinal, no double charge, 429 at 40 | pending |
| Uploads / webhooks / jobs | not required | n/a |
| Publish | not requested | n/a |

## One prompt after GitHub import

### Inspect and prepare only

> Read BOLT-HANDOFF.md and inspect the imported source at the intended branch/revision. Compare
> proposed resources with implemented files, reconcile unknown migration baselines through
> read-only history/schema inspection when access is available, and report concrete deployment
> gaps and owner/external blockers. Preserve the app design and existing database/data. Prepare
> a reviewable setup plan with actual file/resource names and pending checks. Do not create or
> change cloud resources, apply migrations, deploy functions, enter secrets, enable schedules,
> or publish. Do not describe proposed resources or unexecuted checks as complete.
