import { useRef, useState } from "react";
import {
  agentKey,
  buildRunSpec,
  fixtureCompatible,
  fixtureConfig,
  instantiate,
  liveExecutionDefinition,
  modelConfig,
  planMatches,
  runMatrix,
  SCRIPTED_POLICIES,
  scriptedConfig,
  worstCaseModelCalls,
} from "../engine.ts";
import type { AgentConfig, CellSpec, ConfigResponse, Instance, PromptVariant, Role, RunSpec, ScenarioDefinition, ScriptedId, SyntheticFixture } from "../engine.ts";
import type { Mode } from "../App.tsx";
import { fetchLiveConfig, liveSeat } from "../lib/modelTurn.ts";
import type { SessionState } from "../lib/session.ts";
import { navigate } from "../route.ts";
import { newId, seatsFor, yieldToBrowser } from "../runState.ts";
import type { RunRecord, RunSource } from "../runState.ts";
import { parseSeeds } from "../seeds.ts";

const DEFAULT_PAIRINGS = ["concession|concession", "concession|firm", "bluff|concession"];
const ALL_PAIRINGS = SCRIPTED_POLICIES.flatMap((buyer) => SCRIPTED_POLICIES.map((seller) => `${buyer}|${seller}`));

export function Bench(props: {
  definition: ScenarioDefinition | null;
  fixtures: SyntheticFixture[];
  mode: Mode;
  onMode: (mode: Mode) => void;
  session: SessionState;
  onRun: (run: RunRecord) => void;
  onNotice: (message: string | null) => void;
}) {
  const [seeds, setSeeds] = useState("1, 2");
  const [replicates, setReplicates] = useState(1);
  const [checked, setChecked] = useState<string[]>(DEFAULT_PAIRINGS);
  const [running, setRunning] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const definition = props.definition;

  if (!definition) return <p>Choose a scenario first.</p>;
  const roleLabel = (role: Role) => definition.parties[role].label ?? role;

  function sandboxCells(): CellSpec[] {
    return checked.map((key) => {
      const [buyer, seller] = key.split("|") as [ScriptedId, ScriptedId];
      return { cellId: `${buyer}-${seller}`, roles: { buyer: scriptedConfig(buyer), seller: scriptedConfig(seller) } };
    });
  }

  const parsedSeeds = parseSeeds(seeds);
  const preview = parsedSeeds.ok && checked.length > 0 ? parsedSeeds.seeds.length * replicates * checked.length : null;

  async function execute(spec: RunSpec, source: RunSource, fixtures: SyntheticFixture[], live: boolean) {
    const instances = new Map<number, Instance>();
    for (const seed of spec.instanceSeeds) {
      const built = instantiate(spec.definition, seed);
      if (!built.ok) {
        setError(`Instance seed ${seed}: ${built.error}`);
        return;
      }
      instances.set(seed, built.instance);
    }
    cancelRef.current = false;
    const base: RunRecord = {
      runId: newId(),
      label: spec.label,
      source,
      spec,
      planned: planMatches(spec),
      executions: [],
      instances,
      fixtures,
      state: "running",
      startedAt: new Date().toISOString(),
    };
    let latest = base;
    setRunning(base);
    props.onRun(base);
    setError(null);
    props.onNotice(null);
    try {
      const result = await runMatrix({
        spec,
        newExecutionId: newId,
        isCancelled: () => cancelRef.current,
        yieldBetween: yieldToBrowser,
        seatsFor: (cell, planned) => seatsFor(cell, fixtures, live ? () => liveSeat(spec, planned) : null),
        onProgress: (progress) => {
          const next = { ...base, executions: [...progress.done] };
          latest = next;
          setRunning(next);
          props.onRun(next);
        },
      });
      const done: RunRecord = { ...base, executions: [...result.executions], state: result.cancelled ? "cancelled" : "done" };
      setRunning(null);
      props.onRun(done);
      props.onNotice(`${result.executions.length} of ${result.planned.length} planned matches ran${result.cancelled ? " before cancellation" : ""}. Results and replays are in this tab only until saved or exported.`);
      navigate("results", { run: done.runId });
    } catch (problem) {
      setRunning(null);
      // Keep the finished matches and mark the run stopped so it can still be saved or exported.
      props.onRun({ ...latest, state: "cancelled" });
      setError(problem instanceof Error ? problem.message : "The run stopped.");
    }
  }

  function runSandbox() {
    if (!parsedSeeds.ok) {
      setError(parsedSeeds.error);
      return;
    }
    if (checked.length === 0) {
      setError("Choose at least one ordered pairing.");
      return;
    }
    const built = buildRunSpec({ label: `${definition!.id} sandbox`, definition: definition!, instanceSeeds: parsedSeeds.seeds, replicates, cells: sandboxCells() });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    void execute(built.spec, "sandbox", props.fixtures, false);
  }

  const toggle = (key: string) => setChecked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  return (
    <section>
      <div className="actions" role="group" aria-label="Mode">
        <button type="button" className={props.mode === "sandbox" ? "" : "secondary"} aria-pressed={props.mode === "sandbox"} onClick={() => props.onMode("sandbox")}>Sandbox</button>
        <button type="button" className={props.mode === "live" ? "" : "secondary"} aria-pressed={props.mode === "live"} onClick={() => props.onMode("live")}>Live</button>
      </div>

      {running ? (
        <div className="panel" style={{ marginTop: "1rem" }}>
          <h2>Running {running.label}</h2>
          <p>{running.executions.length} of {running.planned.length} planned matches finished. Matches run one at a time in this tab; closing it stops the run.</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => { cancelRef.current = true; }}>Cancel after this match</button>
          </div>
          <StatusTable run={running} />
        </div>
      ) : null}

      {props.mode === "sandbox" ? (
        <>
          <div className="panel" style={{ marginTop: "1rem" }}>
            <h2>Pairing matrix: {definition.title}</h2>
            <p>Ordered pairings: {roleLabel("buyer")} policy first, {roleLabel("seller")} policy second. Every cell sees the same concrete instance for a given seed.</p>
            <fieldset className="pairings">
              <legend>Scripted pairings (up to 3 x 3)</legend>
              {ALL_PAIRINGS.map((key) => (
                <label key={key}>
                  <input type="checkbox" checked={checked.includes(key)} onChange={() => toggle(key)} /> {key.replace("|", " / ")}
                </label>
              ))}
            </fieldset>
            <label htmlFor="seeds">Instance seeds</label>
            <input id="seeds" type="text" value={seeds} onChange={(event) => setSeeds(event.target.value)} />
            <label htmlFor="replicates">Replicates</label>
            <select id="replicates" value={String(replicates)} onChange={(event) => setReplicates(Number(event.target.value))}>
              {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <p>
              Preview: {preview === null ? "fix the seeds or pairings" : `${preview} planned matches (${parsedSeeds.ok ? parsedSeeds.seeds.length : 0} seeds x ${replicates} replicate x ${checked.length} pairings)`}, 0 paid calls.
              {preview !== null && preview > 6 ? " Larger sweeps (up to 180) are allowed but their browser responsiveness is not yet verified." : ""}
            </p>
            {error ? <p className="notice" role="alert">{error}</p> : null}
            <div className="actions">
              <button type="button" disabled={running !== null || preview === null} onClick={runSandbox}>Run sequentially</button>
              <button type="button" className="secondary" onClick={() => { setSeeds("1, 2"); setReplicates(1); setChecked(DEFAULT_PAIRINGS); }}>Reset to the six-match default</button>
            </div>
          </div>
          <FixturePanel definition={definition} fixtures={props.fixtures} disabled={running !== null} onRun={(spec, fixture) => void execute(spec, "fixture", [fixture], false)} onError={setError} />
        </>
      ) : (
        <LivePanel definition={definition} session={props.session} disabled={running !== null} onRun={(spec) => void execute(spec, "live", [], true)} onError={setError} error={error} />
      )}
    </section>
  );
}

function StatusTable(props: { run: RunRecord }) {
  const byPlan = new Map(props.run.executions.map((execution) => [execution.planIndex, execution] as const));
  const nextIndex = props.run.planned.find((match) => !byPlan.has(match.planIndex))?.planIndex;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Cell</th><th>Seed</th><th>Replicate</th><th>Status</th><th>Outcome</th></tr></thead>
        <tbody>
          {props.run.planned.map((match) => {
            const execution = byPlan.get(match.planIndex);
            const status = execution?.status ?? (props.run.state === "running" && match.planIndex === nextIndex ? "running" : "not_started");
            return (
              <tr key={match.planIndex}>
                <td>{match.planIndex}</td>
                <td>{match.cellId}</td>
                <td>{match.instanceSeed}</td>
                <td>{match.replicate}</td>
                <td className={status === "complete" ? "good" : status === "not_started" || status === "running" ? "" : "bad"}>{status}</td>
                <td>{execution?.metrics.outcome ?? execution?.failureReason ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FixturePanel(props: {
  definition: ScenarioDefinition;
  fixtures: SyntheticFixture[];
  disabled: boolean;
  onRun: (spec: RunSpec, fixture: SyntheticFixture) => void;
  onError: (message: string) => void;
}) {
  const options = props.fixtures.flatMap((fixture) =>
    fixture.compatible.instanceSeeds
      .filter((seed) => fixtureCompatible(fixture, props.definition, seed, fixture.compatible.role, fixture.compatible.opponent))
      .map((seed) => ({ fixture, seed })));
  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2>Synthetic fixture demonstration</h2>
      <p>
        Hand-authored synthetic data, not recorded LLM output. Each authored attempt passes through the same parser and referee:
        an illegal accept, the validation feedback, one repair and a false structured claim. The outcome is whatever the engine computes.
      </p>
      {options.length === 0 ? <p>No fixture is declared for this scenario. Select warehouse-lease-v2 to run the bundled demonstration.</p> : (
        <div className="actions">
          {options.map(({ fixture, seed }) => (
            <button
              key={`${fixture.id}-${seed}`}
              type="button"
              disabled={props.disabled}
              onClick={() => {
                const seat = fixtureConfig(fixture);
                const roles = (fixture.compatible.role === "buyer"
                  ? { buyer: seat, seller: fixture.compatible.opponent }
                  : { buyer: fixture.compatible.opponent, seller: seat }) as Record<Role, AgentConfig>;
                const built = buildRunSpec({ label: `${fixture.id} demo`, definition: props.definition, instanceSeeds: [seed], cells: [{ cellId: "synthetic-demo", roles }] });
                if (!built.ok) props.onError(built.error);
                else props.onRun(built.spec, fixture);
              }}
            >
              Run {fixture.id} (seed {seed}, {fixture.compatible.role} vs {agentKey(fixture.compatible.opponent)})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LivePanel(props: {
  definition: ScenarioDefinition;
  session: SessionState;
  disabled: boolean;
  error: string | null;
  onRun: (spec: RunSpec) => void;
  onError: (message: string) => void;
}) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState<PromptVariant>("neutral");
  const [seat, setSeat] = useState<"buyer" | "seller" | "both">("buyer");
  const [opponent, setOpponent] = useState<ScriptedId>("concession");
  const [seedText, setSeedText] = useState("1");

  async function check() {
    setChecking(true);
    const result = await fetchLiveConfig();
    setChecking(false);
    if (!result.ok) {
      setConfig(null);
      setConfigError(result.error);
      return;
    }
    setConfigError(null);
    setConfig(result.config);
    if (!model) setModel(result.config.defaultModel ?? result.config.allowedModels[0] ?? "");
  }

  const seed = /^\d{1,10}$/.test(seedText.trim()) ? Number(seedText.trim()) : null;
  const modelSeat = model ? modelConfig(model, variant) : null;
  const built = modelSeat && seed !== null
    ? buildRunSpec({
        label: `${props.definition.id} live`,
        definition: liveExecutionDefinition(props.definition, 6),
        instanceSeeds: [seed],
        cells: [{
          cellId: "live",
          roles: {
            buyer: seat === "seller" ? scriptedConfig(opponent) : modelSeat,
            seller: seat === "buyer" ? scriptedConfig(opponent) : modelSeat,
          },
        }],
      })
    : null;
  const worstCase = built?.ok ? worstCaseModelCalls(built.spec) : null;
  const remaining = config?.remainingToday ?? null;
  const tooLarge = worstCase !== null && remaining !== null && worstCase > remaining;
  const ready = props.session.status === "ready" && config?.liveEnabled === true && built?.ok === true && !tooLarge;

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2>Live: one cell, one instance, maxRounds 6</h2>
      <p>
        Live needs a configured backend, a signed-in owner and server secrets. A missing setting blocks the cell explicitly; the sandbox never substitutes a scripted move.
        Remote output is not deterministic, even at temperature 0.
      </p>
      {props.session.status !== "ready" ? <p className="notice">Sign in on the Account page before running a Live cell.</p> : null}
      <div className="actions">
        <button type="button" className="secondary" disabled={checking} onClick={() => void check()}>Check Live setup and allowance</button>
      </div>
      {configError ? <p className="notice" role="alert">{configError}</p> : null}
      {config ? (
        <p>
          {config.liveEnabled ? "Live is enabled." : `Live is disabled: ${config.disabledReason ?? "no reason given"}.`}{" "}
          Allowance {config.remainingToday ?? "unknown"} of {config.dailyLimit} attempts left today (UTC). Up to {config.limits.maxOutputTokens} output tokens per attempt.
        </p>
      ) : null}
      <label htmlFor="live-model">Model (server allowlist)</label>
      <select id="live-model" value={model} onChange={(event) => setModel(event.target.value)}>
        <option value="">Choose after checking setup</option>
        {(config?.allowedModels ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <label htmlFor="live-variant">Prompt variant</label>
      <select id="live-variant" value={variant} onChange={(event) => setVariant(event.target.value as PromptVariant)}>
        <option value="neutral">neutral (default)</option>
        <option value="honesty-warned">honesty-warned</option>
      </select>
      <label htmlFor="live-seat">Model seat</label>
      <select id="live-seat" value={seat} onChange={(event) => setSeat(event.target.value as "buyer" | "seller" | "both")}>
        <option value="buyer">{props.definition.parties.buyer.label ?? "buyer"} (buyer)</option>
        <option value="seller">{props.definition.parties.seller.label ?? "seller"} (seller)</option>
        <option value="both">both seats (model vs model)</option>
      </select>
      {seat !== "both" ? (
        <>
          <label htmlFor="live-opponent">Scripted opponent</label>
          <select id="live-opponent" value={opponent} onChange={(event) => setOpponent(event.target.value as ScriptedId)}>
            {SCRIPTED_POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}
          </select>
        </>
      ) : null}
      <label htmlFor="live-seed">Instance seed</label>
      <input id="live-seed" type="text" inputMode="numeric" value={seedText} onChange={(event) => setSeedText(event.target.value)} />
      <p>
        Preflight: {worstCase === null ? "choose a model and a seed" : `at most ${worstCase} paid attempts (each model seat takes 6 legal turns, each with at most one repair)`}.
        {tooLarge ? ` That exceeds the ${remaining} attempts left today, so the run is refused.` : ""} Preflight is not a reservation or a dollar budget; the server's atomic claims decide.
      </p>
      {built && !built.ok ? <p className="notice" role="alert">{built.error}</p> : null}
      {props.error ? <p className="notice" role="alert">{props.error}</p> : null}
      <div className="actions">
        <button type="button" disabled={!ready || props.disabled} onClick={() => {
          if (built?.ok) props.onRun(built.spec);
          else props.onError("The Live run spec is not valid.");
        }}>Run the Live cell</button>
      </div>
    </div>
  );
}
