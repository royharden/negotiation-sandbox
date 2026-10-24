-- Forward migration: v2 run artifacts on public.runs, the public.model_calls ledger, and the
-- service-only claim/finish functions for negotiate-turn (PLAN 7.3, 7.4).
-- Dirty Mode construction: NOT applied. Inspect the target baseline before applying.
-- Never edits 20261023180000_init.sql; keeps scenarios/runs/llm_turn_usage, seed data and rows.
-- Creates no transcripts table, no app_config table and no second usage counter.

-- ---------------------------------------------------------------------------
-- 1. public.runs: nullable v2 artifact columns (legacy rows stay valid as they are)
-- ---------------------------------------------------------------------------

alter table public.runs
  add column artifact_version integer,
  add column artifact_jsonl text,
  add column run_spec_sha256 text,
  add column definition_sha256 text,
  add column instance_id text,
  add column execution_id text,
  add column cell_id text,
  add column replicate integer,
  add column content_sha256 text;

-- Legacy rows (artifact_version is null) need none of the new fields and carry no artifact.
-- v2 rows require the <= 1 MiB JSONL artifact and every identifier. Explicit "is not null"
-- guards keep a null comparison from silently passing the check.
alter table public.runs
  add constraint runs_artifact_shape_check check (
    (artifact_version is null and artifact_jsonl is null)
    or (
      artifact_version is not null
      and artifact_version = 2
      and artifact_jsonl is not null
      and octet_length(artifact_jsonl) <= 1048576
      and run_spec_sha256 is not null and run_spec_sha256 ~ '^[0-9a-f]{64}$'
      and definition_sha256 is not null and definition_sha256 ~ '^[0-9a-f]{64}$'
      and instance_id is not null and instance_id ~ '^[0-9a-f]{64}$'
      and content_sha256 is not null and content_sha256 ~ '^[0-9a-f]{64}$'
      and execution_id is not null and char_length(execution_id) between 1 and 128
      and cell_id is not null and cell_id ~ '^[A-Za-z0-9_.:-]{1,64}$'
      and replicate is not null and replicate >= 0
    )
  );

create unique index runs_owner_execution_idx
  on public.runs (owner_id, execution_id)
  where execution_id is not null;

-- Widen status through a version-aware check: legacy rows keep complete/format_failure only.
alter table public.runs drop constraint runs_status_check;
alter table public.runs
  add constraint runs_status_check check (
    status in ('complete', 'format_failure')
    or (
      coalesce(artifact_version, 0) = 2
      and status in ('provider_error', 'blocked', 'cancelled', 'incomplete')
    )
  );

-- Widen agent ids: legacy ids as before, or v2 agentKey identities (never a bare generic "model").
alter table public.runs drop constraint runs_agent_check;
alter table public.runs
  add constraint runs_agent_check check (
    (
      buyer_agent in ('concession', 'firm', 'bluff', 'model')
      and seller_agent in ('concession', 'firm', 'bluff', 'model')
    )
    or (
      coalesce(artifact_version, 0) = 2
      and buyer_agent ~ '^(scripted|fixture|model):[A-Za-z0-9._:@|/-]{1,200}$'
      and seller_agent ~ '^(scripted|fixture|model):[A-Za-z0-9._:@|/-]{1,200}$'
    )
  );

-- Owner insert: a referenced scenario must be public or owned by the inserting user.
-- (owner SELECT/DELETE policies are unchanged; there is still no client UPDATE.)
drop policy runs_insert on public.runs;
create policy runs_insert on public.runs
  for insert
  with check (
    owner_id = (select auth.uid())
    and (
      scenario_id is null
      or exists (
        select 1
        from public.scenarios s
        where s.id = runs.scenario_id
          and (s.visibility = 'public' or s.owner_id = (select auth.uid()))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 2. public.model_calls: one row per claimed model attempt (service-written only)
-- ---------------------------------------------------------------------------

create table public.model_calls (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  turn_key text not null,
  attempt_no smallint not null,
  repair_of uuid references public.model_calls (id),
  request_digest text not null,
  model_config jsonb not null,
  selected_model text not null,
  provider_model text,
  reserved_output_tokens integer not null,
  status text not null default 'pending',
  verdict text,
  error_category text,
  response_json jsonb,
  output_digest text,
  usage jsonb,
  latency_ms integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint model_calls_owner_operation_key unique (owner_id, operation_id),
  constraint model_calls_owner_turn_attempt_key unique (owner_id, turn_key, attempt_no),
  constraint model_calls_attempt_check check (attempt_no in (1, 2)),
  constraint model_calls_repair_check check (
    (attempt_no = 1 and repair_of is null)
    or (attempt_no = 2 and repair_of is not null)
  ),
  constraint model_calls_status_check check (status in ('pending', 'completed', 'invalid_action', 'error', 'uncertain')),
  constraint model_calls_verdict_check check (
    (status in ('pending', 'error', 'uncertain') and verdict is null)
    or (status = 'completed' and verdict is not null and verdict = 'legal')
    or (status = 'invalid_action' and verdict is not null and verdict = 'invalid')
  ),
  constraint model_calls_error_category_check check (
    error_category is null
    or error_category in ('authentication', 'model_not_found', 'rate_limited', 'context_too_long', 'timeout', 'malformed_response', 'server', 'generic_upstream')
  ),
  constraint model_calls_error_requires_category check (status <> 'error' or error_category is not null),
  constraint model_calls_finished_check check ((status = 'pending') = (finished_at is null)),
  constraint model_calls_turn_key_check check (turn_key ~ '^[0-9a-f]{64}$'),
  constraint model_calls_request_digest_check check (request_digest ~ '^[0-9a-f]{64}$'),
  constraint model_calls_output_digest_check check (output_digest is null or output_digest ~ '^[0-9a-f]{64}$'),
  constraint model_calls_model_config_object check (jsonb_typeof(model_config) = 'object'),
  constraint model_calls_selected_model_check check (selected_model ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  constraint model_calls_provider_model_check check (provider_model is null or char_length(provider_model) <= 64),
  constraint model_calls_reserved_output_check check (reserved_output_tokens between 1 and 500),
  constraint model_calls_response_size_check check (response_json is null or octet_length(response_json::text) <= 65536),
  constraint model_calls_latency_check check (latency_ms is null or latency_ms >= 0)
);

create index model_calls_owner_created_idx on public.model_calls (owner_id, created_at desc);
create index model_calls_repair_of_idx on public.model_calls (repair_of) where repair_of is not null;

alter table public.model_calls enable row level security;

-- Owners may read their own ledger rows. No client insert/update/delete policy exists.
create policy model_calls_select on public.model_calls
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.model_calls from public, anon, authenticated;
revoke insert, update, delete on public.model_calls from anon, authenticated;
grant select on public.model_calls to authenticated;
-- negotiate-turn's service client reads ledger rows (repair parents) and today's usage.
grant select on public.model_calls to service_role;
grant select on public.llm_turn_usage to service_role;

-- ---------------------------------------------------------------------------
-- 3. claim_model_attempt: one transaction, serialized per verified owner
-- ---------------------------------------------------------------------------

create or replace function public.claim_model_attempt(
  p_owner uuid,
  p_operation_id uuid,
  p_turn_key text,
  p_attempt_no integer,
  p_request_digest text,
  p_model_config jsonb,
  p_selected_model text,
  p_reserved_output integer,
  p_repair_of uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.model_calls%rowtype;
  v_parent public.model_calls%rowtype;
  v_count integer;
  v_id uuid;
begin
  if p_owner is null or p_operation_id is null or p_turn_key is null or p_request_digest is null
     or p_model_config is null or p_selected_model is null or p_reserved_output is null or p_attempt_no is null then
    return pg_catalog.jsonb_build_object('disposition', 'conflict', 'reason', 'missing_argument');
  end if;
  if p_attempt_no not in (1, 2)
     or (p_attempt_no = 1 and p_repair_of is not null)
     or (p_attempt_no = 2 and p_repair_of is null) then
    return pg_catalog.jsonb_build_object('disposition', 'conflict', 'reason', 'attempt_shape');
  end if;

  -- Serialize all claims for this owner inside this transaction (collisions only serialize more).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('model_calls:' || p_owner::text, 0));

  -- 1. Same operation id: exact match returns a typed disposition with no reserve; anything else conflicts.
  select * into v_existing
  from public.model_calls mc
  where mc.owner_id = p_owner and mc.operation_id = p_operation_id;
  if found then
    if v_existing.request_digest <> p_request_digest
       or v_existing.turn_key <> p_turn_key
       or v_existing.attempt_no <> p_attempt_no
       or v_existing.model_config <> p_model_config
       or v_existing.selected_model <> p_selected_model
       or v_existing.repair_of is distinct from p_repair_of then
      return pg_catalog.jsonb_build_object('disposition', 'conflict', 'reason', 'operation_mismatch');
    end if;
    if v_existing.status = 'pending' then
      return pg_catalog.jsonb_build_object('disposition', 'existing_pending', 'model_call_id', v_existing.id);
    end if;
    if v_existing.status = 'uncertain' then
      return pg_catalog.jsonb_build_object('disposition', 'existing_uncertain', 'model_call_id', v_existing.id,
        'status', v_existing.status, 'response', v_existing.response_json);
    end if;
    return pg_catalog.jsonb_build_object('disposition', 'existing_finished', 'model_call_id', v_existing.id,
      'status', v_existing.status, 'response', v_existing.response_json);
  end if;

  -- 2. A logical turn ordinal is claimed once, even under a fresh operation UUID.
  if exists (
    select 1 from public.model_calls mc
    where mc.owner_id = p_owner and mc.turn_key = p_turn_key and mc.attempt_no = p_attempt_no
  ) then
    return pg_catalog.jsonb_build_object('disposition', 'conflict', 'reason', 'turn_already_claimed');
  end if;

  -- A repair must reference the same owner's invalid first attempt of the same turn. No attempt 3.
  if p_attempt_no = 2 then
    select * into v_parent
    from public.model_calls mc
    where mc.id = p_repair_of and mc.owner_id = p_owner;
    if not found
       or v_parent.attempt_no <> 1
       or v_parent.turn_key <> p_turn_key
       or v_parent.status <> 'invalid_action' then
      return pg_catalog.jsonb_build_object('disposition', 'conflict', 'reason', 'repair_parent');
    end if;
  end if;

  -- 3. Reserve on the EXISTING counter under its existing <= 40 constraint (UTC day).
  insert into public.llm_turn_usage as u (owner_id, usage_day, turn_count)
  values (p_owner, (pg_catalog.timezone('utc', pg_catalog.now()))::date, 1)
  on conflict (owner_id, usage_day)
  do update set turn_count = u.turn_count + 1
  where u.turn_count < 40
  returning u.turn_count into v_count;

  if v_count is null then
    -- At cap: nothing was inserted or incremented; the handler returns 429 with no provider call.
    return pg_catalog.jsonb_build_object('disposition', 'quota_exhausted');
  end if;

  insert into public.model_calls (
    owner_id, operation_id, turn_key, attempt_no, repair_of, request_digest,
    model_config, selected_model, reserved_output_tokens, status
  )
  values (
    p_owner, p_operation_id, p_turn_key, p_attempt_no::smallint, p_repair_of, p_request_digest,
    p_model_config, p_selected_model, p_reserved_output, 'pending'
  )
  returning id into v_id;

  -- 4. Only the caller that receives acquired_new may invoke the provider.
  return pg_catalog.jsonb_build_object('disposition', 'acquired_new', 'model_call_id', v_id, 'turn_count', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. finish_model_attempt: pending -> completed | invalid_action | error | uncertain, once
-- ---------------------------------------------------------------------------

create or replace function public.finish_model_attempt(
  p_owner uuid,
  p_id uuid,
  p_status text,
  p_verdict text,
  p_error_category text,
  p_response jsonb,
  p_output_digest text,
  p_provider_model text,
  p_usage jsonb,
  p_latency_ms integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_owner is null or p_id is null or p_status is null
     or p_status not in ('completed', 'invalid_action', 'error', 'uncertain') then
    return false;
  end if;

  update public.model_calls mc
  set status = p_status,
      verdict = p_verdict,
      error_category = p_error_category,
      response_json = p_response,
      output_digest = p_output_digest,
      provider_model = p_provider_model,
      usage = p_usage,
      latency_ms = p_latency_ms,
      finished_at = pg_catalog.now()
  where mc.id = p_id
    and mc.owner_id = p_owner
    and mc.status = 'pending'
  returning mc.id into v_id;

  return v_id is not null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants: service-only claim/finish; retire client execution of the old reserve RPC
-- ---------------------------------------------------------------------------

revoke all on function public.claim_model_attempt(uuid, uuid, text, integer, text, jsonb, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_model_attempt(uuid, uuid, text, integer, text, jsonb, text, integer, uuid) to service_role;

revoke all on function public.finish_model_attempt(uuid, uuid, text, text, text, jsonb, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.finish_model_attempt(uuid, uuid, text, text, text, jsonb, text, text, jsonb, integer) to service_role;

-- The new live path claims through claim_model_attempt only; never count both. The function and
-- its history stay in place.
revoke execute on function public.reserve_llm_turn() from authenticated;
