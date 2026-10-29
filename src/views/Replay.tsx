import { useEffect, useMemo, useState } from "react";
import { buildRoleRequest, canonicalJson, claimIsTrue, claimTruth, replay, templateDigests, verifyTranscript } from "../engine.ts";
import type { Action, AgentConfig, Claim, PublicTurn, Role, Scenario, VerificationReport } from "../engine.ts";
import { formatPoints } from "../format.ts";
import { navigate } from "../route.ts";
import { downloadText, executionAt, newId, verifiedExecution } from "../runState.ts";
import type { ImportedTranscript, RunRecord } from "../runState.ts";

type Lens = "public" | "buyer" | "seller" | "operator";

export function Replay(props: {
  run: RunRecord | null;
  planIndex: number;
  imported: ImportedTranscript | null;
  imports: ImportedTranscript[];
  onImport: (item: ImportedTranscript) => void;
  onNotice: (message: string | null) => void;
}) {
  const source = useMemo(() => {
    if (props.imported) return { key: props.imported.id, name: props.imported.name, text: props.imported.text, report: props.imported.report, error: null };
    if (!props.run) return null;
    const execution = executionAt(props.run, props.planIndex);
    if (!execution) return { key: "", name: "", text: "", report: null, error: `Planned match ${props.planIndex} has not run.` };
    const built = verifiedExecution(props.run, execution);
    if ("error" in built) return { key: "", name: "", text: "", report: null, error: built.error };
    return { key: execution.executionId, name: `${execution.cellId}-seed${execution.instanceSeed}-r${execution.replicate}-${execution.executionId}.jsonl`, text: built.text, report: built.report, error: null };
  }, [props.imported, props.run, props.planIndex]);

  return (
    <section>
      {source?.error ? <p className="notice" role="alert">{source.error}</p> : null}
      {source?.report ? <ReplayDocument key={source.key} name={source.name} text={source.text} report={source.report} /> : <p>Choose a game from the results table, or import a transcript below.</p>}
      <ImportPanel imports={props.imports} onImport={props.onImport} onNotice={props.onNotice} />
    </section>
  );
}

function ReplayDocument(props: { name: string; text: string; report: VerificationReport }) {
  const { report } = props;
  const header = report.document.header;
  const scenario = header.instance.scenario;
  const attempts = report.document.attempts;
  const [lens, setLens] = useState<Lens>("operator");
  const [step, setStep] = useState(0);
  const [showPrompt, setShowPrompt] = useState(false);
  const label = (role: Role) => scenario.parties[role].label ?? role;
  const legalTurns: PublicTurn[] = attempts.filter((item) => item.verdict === "legal" && item.parsed).map((item) => ({ role: item.role, action: item.parsed as Action }));

  const visible = attempts.filter((item) => lens === "operator" || item.verdict === "legal" || (lens !== "public" && item.role === lens));
  useEffect(() => { setStep(0); setShowPrompt(false); }, [lens]);
  const current = visible[Math.min(step, Math.max(0, visible.length - 1))];
  const metrics = report.recomputed.metrics;
  const canSeeCard = (role: Role) => lens === "operator" || lens === role;
  const templatesMatch = canonicalJson(header.templateDigests) === canonicalJson(templateDigests());

  return (
    <>
      <h2>{header.definition.title}: {header.cellId}, seed {header.instanceSeed}, replicate {header.replicate}</h2>
      {report.verified ? (
        <p className="good">Reproduces: every attempt, transition and metric was recomputed from the artifact with the provider disabled.</p>
      ) : (
        <div className="notice" role="alert">
          <strong>{report.consistent ? "Incomplete export" : "Does not reproduce"}.</strong> Recomputed values are shown; cached values are never trusted.
          <ul>{report.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        </div>
      )}
      <p>
        {header.agentClass === "synthetic" ? "Synthetic fixture: hand-authored data, not recorded LLM output. " : ""}
        {header.agentClass === "live" ? "Live: remote output is not deterministic; a matching server ledger supports request/output linkage, not whole-transcript authenticity. " : ""}
        Status <strong>{report.recomputed.status}</strong>
        {metrics.outcome ? `, outcome ${metrics.outcome}` : ""}{report.recomputed.failureReason ? ` (${report.recomputed.failureReason})` : ""}.
        {" "}Buyer <span className="tag">{header.roles.buyer.kind === "scripted" ? header.roles.buyer.policy : header.roles.buyer.kind}</span>,
        seller <span className="tag">{header.roles.seller.kind === "scripted" ? header.roles.seller.policy : header.roles.seller.kind}</span>.
      </p>

      <div className="actions" role="group" aria-label="Lens">
        {(["public", "buyer", "seller", "operator"] as const).map((item) => (
          <button key={item} type="button" className={lens === item ? "" : "secondary"} aria-pressed={lens === item} onClick={() => setLens(item)}>
            {item === "public" ? "Public" : item === "operator" ? "Operator" : `${label(item)} (${item})`}
          </button>
        ))}
      </div>
      <p className="hint">
        {lens === "public" ? "Public lens: legal actions only, as both parties saw them." : lens === "operator"
          ? "Operator lens: every attempt, both private cards and claim truth. This is a display projection, not a redacted export."
          : `${label(lens)} lens: what this role observed (its own card, legal history, its own invalid attempts and feedback).`}
      </p>

      {visible.length === 0 ? <p>No attempts are visible in this lens.</p> : current ? (
        <div className="panel">
          <p>Step {Math.min(step, visible.length - 1) + 1} of {visible.length}: legal turn {current.legalTurn + 1}{lens === "operator" || lens === current.role ? `, attempt ${current.attemptNo}` : ""}, {label(current.role)} ({current.role})</p>
          <dl className="turn">
            {lens !== "public" ? (<><dt>Verdict</dt><dd className={current.verdict === "legal" ? "good" : "bad"}>{current.verdict}{current.error ? `: ${current.error}` : ""}{current.rawTruncated ? " (output truncated at 8 KiB)" : ""}</dd></>) : null}
            <dt>Action</dt><dd>{current.parsed?.type ?? "unparsed"}</dd>
            <dt>Terms</dt><dd>{current.parsed?.terms ? Object.entries(current.parsed.terms).map(([key, value]) => `${key} ${value}`).join(", ") : "-"}</dd>
            <dt>Note</dt><dd>{current.parsed?.note || "-"}</dd>
            <dt>Claims</dt>
            <dd>
              {current.parsed?.claims?.length ? (
                <ul>
                  {current.parsed.claims.map((claim, index) => (
                    <li key={index}>{describeClaim(claim)}{canSeeCard(current.role) ? <ClaimTruth scenario={scenario} role={current.role} claim={claim} /> : null}</li>
                  ))}
                </ul>
              ) : "-"}
            </dd>
            {lens !== "public" && current.verdict === "invalid" ? (<><dt>Raw output</dt><dd><pre>{current.raw}</pre></dd></>) : null}
            {current.live && lens === "operator" ? (<><dt>Live call</dt><dd><span className="tag">{current.live.modelCallId ?? "no id"}</span> request {current.live.requestDigest?.slice(0, 16) ?? "unknown"}, model {current.live.providerModel ?? "unreported"}, {current.live.latencyMs ?? "?"} ms</dd></>) : null}
          </dl>
          <div className="actions">
            <button type="button" disabled={step === 0} onClick={() => { setStep((value) => value - 1); setShowPrompt(false); }}>Previous</button>
            <button type="button" disabled={step >= visible.length - 1} onClick={() => { setStep((value) => value + 1); setShowPrompt(false); }}>Next</button>
            {canSeeCard(current.role) ? <button type="button" className="secondary" onClick={() => setShowPrompt((value) => !value)}>{showPrompt ? "Hide prompt" : "Show prompt"}</button> : null}
          </div>
          {showPrompt && canSeeCard(current.role) ? (
            <PromptInspector scenario={scenario} legalTurns={legalTurns} attempt={current} attempts={attempts} config={header.roles[current.role]} templatesMatch={templatesMatch} />
          ) : null}
        </div>
      ) : null}

      {lens === "operator" ? (
        <details className="panel" open>
          <summary>Operator analysis (never sent to an agent)</summary>
          <p>
            {metrics.packageCount} legal packages; ZOPA {metrics.zopaEmpty ? "empty" : `non-empty, max joint gain ${formatPoints(metrics.maxJointGain)}`}.
            Buyer utility {formatPoints(metrics.roles.buyer.utility)} (gain {formatPoints(metrics.roles.buyer.gain)}), seller utility {formatPoints(metrics.roles.seller.utility)} (gain {formatPoints(metrics.roles.seller.gain)}).
            Efficiency {metrics.efficiency === null ? `N/A (${metrics.efficiencyNullReason ?? "-"})` : `${formatPoints(metrics.efficiency * 100)}%`}; Pareto-dominated {String(metrics.paretoDominated ?? "N/A")}.
            {metrics.legacyBaselineWarning ? " Legacy v1 baseline: the shared no-deal payoff differs from the reservation thresholds." : ""}
          </p>
          {(["buyer", "seller"] as const).map((role) => (
            <div key={role}>
              <h4>{label(role)} ({role}) private card</h4>
              <pre>{JSON.stringify(scenario.parties[role].private, null, 2)}</pre>
            </div>
          ))}
        </details>
      ) : lens !== "public" ? (
        <details className="panel">
          <summary>{label(lens)} private card</summary>
          <pre>{JSON.stringify(scenario.parties[lens].private, null, 2)}</pre>
        </details>
      ) : null}

      <div className="actions">
        <button type="button" onClick={() => downloadText(props.name || "transcript.jsonl", props.text, "application/x-ndjson")}>Export JSONL</button>
      </div>
      <p className="hint">The full export contains BOTH private cards and any malformed outputs. A file supplied by its owner demonstrates internal consistency only.</p>
    </>
  );
}

function describeClaim(claim: Claim): string {
  if (claim.about === "reservation") return `reservation ${claim.relation ?? "eq"} ${claim.stated}`;
  if (claim.about === "number-score") return `${claim.issueId} score at ${claim.endpoint} = ${claim.stated}`;
  return `${claim.issueId} option ${claim.option} scores ${claim.stated}`;
}

function ClaimTruth(props: { scenario: Scenario; role: Role; claim: Claim }) {
  const truth = claimIsTrue(props.scenario, props.role, props.claim);
  const actual = claimTruth(props.scenario, props.role, props.claim);
  if (truth === null) return <span className="bad"> - cannot be checked</span>;
  return <span className={truth ? "good" : "bad"}> - {truth ? "true" : "false"} (card value {formatPoints(actual)})</span>;
}

function PromptInspector(props: {
  scenario: Scenario;
  legalTurns: PublicTurn[];
  attempt: VerificationReport["document"]["attempts"][number];
  attempts: VerificationReport["document"]["attempts"];
  config: AgentConfig;
  templatesMatch: boolean;
}) {
  const { attempt } = props;
  const prefix = replay(props.scenario, props.legalTurns.slice(0, attempt.legalTurn));
  if (!prefix.ok) return <p className="notice">The legal prefix does not replay: {prefix.error}</p>;
  if (!props.templatesMatch) return <p className="notice">This transcript was recorded with a prompt template this build does not have. The historical prompt is unavailable and is not reconstructed.</p>;
  const illustrative = props.config.kind !== "model";
  const params = props.config.kind === "model"
    ? { model: props.config.model, promptVariant: props.config.promptVariant, temperature: props.config.temperature, maxOutputTokens: props.config.maxOutputTokens }
    : { model: "inspection-only", promptVariant: "neutral" as const, temperature: 0, maxOutputTokens: 500 };
  const first = attempt.attemptNo === 2
    ? props.attempts.find((item) => item.role === attempt.role && item.legalTurn === attempt.legalTurn && item.attemptNo === 1)
    : undefined;
  const built = buildRoleRequest({
    scenario: props.scenario,
    state: prefix.state,
    role: attempt.role,
    params,
    repair: first && first.verdict === "invalid" ? { priorOutput: first.raw, validationError: first.error ?? "" } : null,
  });
  if (!built.ok) return <p className="notice">{built.error}</p>;
  const recorded = attempt.live?.requestDigest ?? null;
  return (
    <div>
      {illustrative ? <p className="hint">Scripted and fixture seats send no request. This is what a neutral model seat would have received at this point.</p> : null}
      <p>
        Request digest <span className="tag">{built.built.requestDigest.slice(0, 16)}</span>, template <span className="tag">{built.built.templateDigest.slice(0, 16)}</span>, {built.built.bytes} bytes.
        {recorded ? (recorded === built.built.requestDigest ? " Matches the server-recorded digest." : " Differs from the server-recorded digest.") : ""}
      </p>
      {built.built.request.messages.map((message, index) => (
        <div key={index}>
          <h4>{message.role}</h4>
          <pre>{message.content}</pre>
        </div>
      ))}
    </div>
  );
}

function ImportPanel(props: { imports: ImportedTranscript[]; onImport: (item: ImportedTranscript) => void; onNotice: (message: string | null) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load(name: string, content: string) {
    const verified = verifyTranscript(content);
    if (!verified.ok) {
      setError(verified.error);
      return;
    }
    setError(null);
    const item: ImportedTranscript = { id: newId(), name, text: content, report: verified.report };
    props.onImport(item);
    props.onNotice(verified.report.verified ? `Imported ${name}: it reproduces.` : `Imported ${name}: it does not fully reproduce (${verified.report.problems.length} problems).`);
    navigate("replay", { import: item.id });
  }

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2>Import a transcript</h2>
      <p>Paste one JSONL transcript (at most 1 MiB) or choose a file. It is verified and recomputed with the provider disabled; nothing in it is executed.</p>
      <label htmlFor="transcript-file">Transcript file</label>
      <input id="transcript-file" type="file" accept=".jsonl,application/x-ndjson,text/plain" onChange={(event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > 1024 * 1024) {
          setError("That file is larger than 1 MiB.");
          return;
        }
        void file.text().then((content) => load(file.name, content));
      }} />
      <label htmlFor="transcript-text">Transcript JSONL</label>
      <textarea id="transcript-text" value={text} spellCheck={false} onChange={(event) => setText(event.target.value)} />
      {error ? <p className="notice" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" disabled={text.trim() === ""} onClick={() => load("pasted.jsonl", text)}>Verify and open</button>
      </div>
      {props.imports.length ? (
        <ul>
          {props.imports.map((item) => (
            <li key={item.id}>
              <a href={`/?page=replay&import=${item.id}`} onClick={(event) => { event.preventDefault(); navigate("replay", { import: item.id }); }}>{item.name}</a>
              {" "}{item.report.verified ? <span className="good">reproduces</span> : <span className="bad">does not reproduce</span>}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
