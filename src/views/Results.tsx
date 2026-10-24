import { useState } from "react";
import { summarizePairings } from "../engine.ts";
import { formatPoints, pairingLabel } from "../format.ts";
import { saveRuns } from "../lib/repository.ts";
import type { SessionState } from "../lib/session.ts";
import { navigate } from "../route.ts";
import type { SessionBatch } from "../savedBatch.ts";

export function Results(props: { batch: SessionBatch | null; session: SessionState; onNotice: (message: string | null) => void }) {
  const [saving, setSaving] = useState(false);
  const batch = props.batch;
  if (!batch) return <p>Run a batch to fill this table.</p>;
  const summary = summarizePairings(batch.rows, 1);

  async function save() {
    if (!batch || !props.session.userId) return;
    setSaving(true);
    const result = await saveRuns(props.session.userId, batch.scenario, batch.rows, batch.label);
    setSaving(false);
    props.onNotice(result.error ?? `Saved ${result.saved} scored runs.`);
  }

  function download() {
    const blob = new Blob([JSON.stringify({ label: batch?.label, scenario: batch?.scenario, rows: batch?.rows }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${batch?.scenario.id ?? "results"}-results.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section>
      <div className="actions">
        <button type="button" onClick={download}>Download JSON</button>
        <button type="button" className="secondary" disabled={props.session.status !== "ready" || saving} onClick={() => void save()}>
          Save scored runs
        </button>
      </div>
      <h2>Pairings</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pairing</th>
              <th>Agreements</th>
              <th>Walk-aways</th>
              <th>Failures</th>
              <th>Mean welfare</th>
              <th>Interval</th>
              <th>Buyer violations</th>
              <th>Seller violations</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((row) => (
              <tr key={`${row.buyerAgent}|${row.sellerAgent}`}>
                <td>{pairingLabel(row.buyerAgent, row.sellerAgent)}</td>
                <td>{row.agreements}</td>
                <td>{row.disagreements}</td>
                <td>{row.failures + row.blocked}</td>
                <td>{formatPoints(row.meanWelfare)}</td>
                <td>{row.welfareLow === null ? "—" : `${formatPoints(row.welfareLow)} to ${formatPoints(row.welfareHigh)}`}</td>
                <td>{row.buyerViolations}</td>
                <td>{row.sellerViolations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Games</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Seed</th>
              <th>Pairing</th>
              <th>Outcome</th>
              <th>Welfare</th>
              <th>Buyer</th>
              <th>Seller</th>
              <th>Replay</th>
            </tr>
          </thead>
          <tbody>
            {batch.rows.map((row, index) => (
              <tr key={`${row.seed}-${row.buyerAgent}-${row.sellerAgent}-${index}`}>
                <td>{row.seed}</td>
                <td>{pairingLabel(row.buyerAgent, row.sellerAgent)}</td>
                <td className={row.scores?.outcome === "agreement" ? "good" : row.status === "complete" ? "" : "bad"}>
                  {row.status === "blocked" ? row.error ?? "blocked" : row.scores?.outcome ?? row.status}
                </td>
                <td>{formatPoints(row.scores?.welfare)}</td>
                <td>{formatPoints(row.scores?.buyerUtility)}</td>
                <td>{formatPoints(row.scores?.sellerUtility)}</td>
                <td>
                  <a href={`/?page=replay&row=${index}`} onClick={(event) => { event.preventDefault(); navigate("replay", { row: String(index) }); }}>
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
