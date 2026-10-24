import { useState } from "react";
import { gamesCsv, pairedDifferences, runSpecDigest, summarizeCells, turnsCsv } from "../engine.ts";
import type { CellSummary, Fraction, MatchMetrics, Stats } from "../engine.ts";
import { formatPoints } from "../format.ts";
import { saveExecution } from "../lib/repository.ts";
import type { SessionState } from "../lib/session.ts";
import { navigate } from "../route.ts";
import { downloadText, rowsOf, transcriptText } from "../runState.ts";
import type { RunRecord } from "../runState.ts";

const METRICS: Record<string, { label: string; read: (metrics: MatchMetrics) => number | null }> = {
  welfare: { label: "Welfare (sum of utilities)", read: (metrics) => metrics.welfare },
  jointGain: { label: "Joint gain over baselines", read: (metrics) => metrics.jointGain },
  buyerGain: { label: "Buyer gain", read: (metrics) => metrics.roles.buyer.gain },
  sellerGain: { label: "Seller gain", read: (metrics) => metrics.roles.seller.gain },
  efficiency: { label: "IR-qualified efficiency", read: (metrics) => metrics.efficiency },
  buyerFalse: { label: "Buyer false structured claims", read: (metrics) => metrics.roles.buyer.claimsFalse },
  sellerFalse: { label: "Seller false structured claims", read: (metrics) => metrics.roles.seller.claimsFalse },
};

function frac(value: Fraction): string {
  return value.of === 0 ? "N/A (0)" : `${value.count}/${value.of}`;
}

function stat(value: Stats): string {
  return value.n === 0 ? "N/A (n=0)" : `${formatPoints(value.mean)} (n=${value.n}, ${formatPoints(value.min)} to ${formatPoints(value.max)})`;
}

export function Results(props: { runs: RunRecord[]; run: RunRecord | null; session: SessionState; onNotice: (message: string | null) => void }) {
  const [cellA, setCellA] = useState("");
  const [cellB, setCellB] = useState("");
  const [metric, setMetric] = useState("welfare");
  const [saving, setSaving] = useState(false);
  const run = props.run;
  if (!run) return <p>Run a Sandbox matrix, the fixture demonstration or a Live cell to fill this page.</p>;
  const rows = rowsOf(run);
  const summaries = summarizeCells(rows);
  const cells = run.spec.cells.map((cell) => cell.cellId);
  const a = cellA || cells[0] || "";
  const b = cellB || cells[1] || cells[0] || "";
  const reader = METRICS[metric] ?? METRICS.welfare!;
  const paired = a && b && a !== b ? pairedDifferences(rows, a, b, reader.read) : null;
  const specDigest = runSpecDigest(run.spec);

  async function saveAll() {
    if (!run || !props.session.userId) return;
    setSaving(true);
    const messages: string[] = [];
    let saved = 0;
    try {
      for (const execution of run.executions) {
        const message = await saveExecution(props.session.userId, run, execution);
        if (message) messages.push(`#${execution.planIndex}: ${message}`);
        else saved += 1;
      }
    } catch (problem) {
      messages.push(problem instanceof Error ? problem.message : "The save stopped.");
    } finally {
      setSaving(false);
    }
    props.onNotice(`Saved ${saved} of ${run.executions.length} executions.${messages.length ? ` ${messages.join(" ")}` : ""} The in-memory results are unchanged.`);
  }

  return (
    <section>
      {props.runs.length > 1 ? (
        <>
          <label htmlFor="run-pick">Run</label>
          <select id="run-pick" value={run.runId} onChange={(event) => navigate("results", { run: event.target.value })}>
            {props.runs.map((item) => <option key={item.runId} value={item.runId}>{item.label} ({item.source}, {item.state}, {item.startedAt})</option>)}
          </select>
        </>
      ) : null}
      <h2>{run.label}</h2>
      <p>
        Run spec <span className="tag">{specDigest.slice(0, 16)}</span>, ruleset {run.spec.versions.ruleset}, engine {run.spec.versions.engine}, scoring {run.spec.versions.scoring}.
        Source {run.spec.gitSha ? `git ${run.spec.gitSha}` : "uncommitted or unknown (no git SHA recorded)"}.
        {run.source === "fixture" ? " Synthetic fixture run: hand-authored data, not recorded LLM output." : ""}
        {run.state !== "done" ? ` State: ${run.state}.` : ""}
      </p>
      <div className="actions">
        <button type="button" onClick={() => downloadText(`${run.spec.definition.id}-games.csv`, gamesCsv(rows), "text/csv")}>games.csv</button>
        <button type="button" onClick={() => downloadText(`${run.spec.definition.id}-turns.csv`, turnsCsv(run.executions), "text/csv")}>turns.csv</button>
        <button type="button" className="secondary" onClick={() => downloadText(`${run.spec.definition.id}-runspec.json`, `${JSON.stringify(run.spec, null, 2)}\n`, "application/json")}>Run spec JSON</button>
        <button type="button" className="secondary" disabled={props.session.status !== "ready" || saving || run.state === "running"} onClick={() => void saveAll()}>Save executions to account</button>
      </div>
      <p className="hint">CSVs hold IDs and public action summaries only. Run spec and transcript downloads contain both private cards.</p>

      <h3>Cells</h3>
      <p className="hint">Aggregated only within one exact cell (definition, ruleset, per-role configuration and prompt variant). Two seeds describe this sandbox; they do not support confidence intervals or rankings.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cell</th><th>Planned / attempted / resolved</th><th>Agreement (of attempted / of resolved)</th><th>Walk / cap</th><th>Failures</th>
              <th>Buyer gain</th><th>Seller gain</th><th>Welfare</th><th>IR violations B / S</th><th>Missed deal</th>
              <th>False claims B / S</th><th>Claim disclosure B / S</th><th>Own-number candidates B / S</th><th>Accept below own claim B / S</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((cell) => <CellRow key={cell.cellKey} cell={cell} />)}
          </tbody>
        </table>
      </div>

      <h3>Games (every planned match)</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Cell</th><th>Seed</th><th>Rep</th><th>Status</th><th>Outcome</th><th>Buyer U / gain</th><th>Seller U / gain</th><th>Efficiency</th><th>Claims false</th><th /></tr></thead>
          <tbody>
            {rows.map((row) => {
              const m = row.metrics;
              const execution = run.executions.find((item) => item.planIndex === row.planIndex);
              return (
                <tr key={row.planIndex}>
                  <td>{row.planIndex}</td>
                  <td>{row.cellId}</td>
                  <td>{row.instanceSeed}</td>
                  <td>{row.replicate}</td>
                  <td className={row.status === "complete" ? "good" : row.status === "not_started" ? "" : "bad"}>{row.status}</td>
                  <td>{m?.outcome ?? m?.failureReason ?? "-"}</td>
                  <td>{formatPoints(m?.roles.buyer.utility)} / {formatPoints(m?.roles.buyer.gain)}</td>
                  <td>{formatPoints(m?.roles.seller.utility)} / {formatPoints(m?.roles.seller.gain)}</td>
                  <td>{m?.efficiency !== null && m?.efficiency !== undefined ? formatPoints(m.efficiency * 100) + "%" : m?.efficiencyNullReason ?? "-"}</td>
                  <td>{m ? `${m.roles.buyer.claimsFalse}/${m.roles.buyer.claimsEvaluated} B, ${m.roles.seller.claimsFalse}/${m.roles.seller.claimsEvaluated} S` : "-"}</td>
                  <td>
                    {execution ? (
                      <>
                        <a href={`/?page=replay&run=${run.runId}&plan=${row.planIndex}`} onClick={(event) => { event.preventDefault(); navigate("replay", { run: run.runId, plan: String(row.planIndex) }); }}>Replay</a>{" "}
                        <button type="button" className="link" onClick={() => {
                          try {
                            downloadText(`${row.cellId}-seed${row.instanceSeed}-r${row.replicate}-${execution.executionId}.jsonl`, transcriptText(run, execution), "application/x-ndjson");
                          } catch (problem) {
                            props.onNotice(problem instanceof Error ? problem.message : "The transcript could not be exported.");
                          }
                        }}>JSONL</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>Paired differences</h3>
      <p className="hint">Descriptive only: the two cells are compared on identical instance id, seed and replicate. Not a causal bluff effect and not an inferential interval. Identical scripted policies under two prompt variants are an equality sanity check.</p>
      <div className="inline">
        <label htmlFor="cell-a">Cell A</label>
        <select id="cell-a" value={a} onChange={(event) => setCellA(event.target.value)}>{cells.map((cell) => <option key={cell} value={cell}>{cell}</option>)}</select>
        <label htmlFor="cell-b">Cell B</label>
        <select id="cell-b" value={b} onChange={(event) => setCellB(event.target.value)}>{cells.map((cell) => <option key={cell} value={cell}>{cell}</option>)}</select>
        <label htmlFor="metric">Metric</label>
        <select id="metric" value={metric} onChange={(event) => setMetric(event.target.value)}>
          {Object.entries(METRICS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
        </select>
      </div>
      {paired ? (
        <>
          <p>Shared complete pairs {paired.sharedComplete}; missing or undefined pairs {paired.missingPairs}; mean B minus A {formatPoints(paired.meanDelta)}.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Instance</th><th>Seed</th><th>Rep</th><th>A</th><th>B</th><th>B - A</th></tr></thead>
              <tbody>
                {paired.deltas.map((delta) => (
                  <tr key={`${delta.instanceId}-${delta.instanceSeed}-${delta.replicate}`}>
                    <td><span className="tag">{delta.instanceId.slice(0, 12)}</span></td><td>{delta.instanceSeed}</td><td>{delta.replicate}</td>
                    <td>{formatPoints(delta.a)}</td><td>{formatPoints(delta.b)}</td><td>{formatPoints(delta.delta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <p>Choose two different cells.</p>}
    </section>
  );
}

function CellRow(props: { cell: CellSummary }) {
  const cell = props.cell;
  const failures = Object.entries(cell.failures).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`).join(", ") || "none";
  return (
    <tr>
      <td>{cell.cellId}<br /><span className="tag">{cell.agentClass}</span></td>
      <td>{cell.planned} / {cell.attempted} / {cell.resolved}{cell.notStarted ? ` (${cell.notStarted} not started)` : ""}</td>
      <td>{frac(cell.agreementOfAttempted)} / {frac(cell.agreementOfResolved)}</td>
      <td>{cell.outcomes.walk} / {cell.outcomes.cap}</td>
      <td>{failures}{cell.attempted ? ` (of ${cell.attempted} attempted)` : ""}</td>
      <td>{stat(cell.gain.buyer)}</td>
      <td>{stat(cell.gain.seller)}</td>
      <td>{stat(cell.welfare)}</td>
      <td>{frac(cell.irViolation.buyer)} / {frac(cell.irViolation.seller)}</td>
      <td>{frac(cell.missedDeal)}</td>
      <td>{frac(cell.falseStructuredClaim.buyer)} / {frac(cell.falseStructuredClaim.seller)}</td>
      <td>{frac(cell.claimDisclosure.buyer)} / {frac(cell.claimDisclosure.seller)}</td>
      <td>{frac(cell.ownNumberDisclosureCandidates.buyer)} / {frac(cell.ownNumberDisclosureCandidates.seller)}</td>
      <td>{frac(cell.claimActionInconsistency.buyer)} / {frac(cell.claimActionInconsistency.seller)}</td>
    </tr>
  );
}
