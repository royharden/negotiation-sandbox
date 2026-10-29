import { useEffect, useState } from "react";
import { analyzeDeception } from "../engine.ts";
import { formatPoints, pairingLabel } from "../format.ts";
import type { SessionBatch } from "../savedBatch.ts";

/** Read-only replay of historical v1 saved rows, under their original payoff and claim definitions. */
export function LegacyReplay(props: { batch: SessionBatch | null; rowIndex: number }) {
  const [turnIndex, setTurnIndex] = useState(0);
  const batch = props.batch;
  const row = batch?.rows[props.rowIndex];

  useEffect(() => {
    setTurnIndex(0);
  }, [props.rowIndex]);

  if (!batch || !row) return <p>Choose a saved v1 run from the account page.</p>;

  const report = analyzeDeception(batch.scenario, row.history);
  const turn = row.history[turnIndex];
  const flags = report.turns[turnIndex];

  return (
    <section>
      <p className="banner">Legacy v1 row: original ruleset (shared no-deal payoff, equality claims with tolerance 0.5). It is shown as recorded and is not rewritten as v2.</p>
      <h2>{pairingLabel(row.buyerAgent, row.sellerAgent)}, seed {row.seed}</h2>
      <p>
        {row.scores?.outcome ?? row.status}
        {row.scores?.welfare !== null && row.scores?.welfare !== undefined ? `, welfare ${formatPoints(row.scores.welfare)}` : ""}
        {row.error ? `. ${row.error}` : ""}
      </p>
      {row.history.length === 0 ? <p>This game has no public turns.</p> : (
        <div className="panel">
          <p>Turn {turnIndex + 1} of {row.history.length}</p>
          {turn ? (
            <dl className="turn">
              <dt>Speaker</dt>
              <dd>{turn.role}</dd>
              <dt>Action</dt>
              <dd>{turn.action.type}</dd>
              <dt>Terms</dt>
              <dd>{turn.action.terms ? Object.entries(turn.action.terms).map(([key, value]) => `${key} ${value}`).join(", ") : "—"}</dd>
              <dt>Note</dt>
              <dd>{turn.action.note || "—"}</dd>
              <dt>Claims</dt>
              <dd>{turn.action.claims?.map((claim) => `${claim.about} ${claim.stated}`).join("; ") || "—"}</dd>
              <dt>Checks</dt>
              <dd className={flags && (flags.violations.length || flags.drifts.length || flags.leakages.length) ? "bad" : ""}>
                {flags && (flags.violations.length || flags.drifts.length || flags.leakages.length)
                  ? [...flags.violations, ...flags.drifts, ...flags.leakages].join(" ")
                  : "No deception flag on this turn."}
              </dd>
            </dl>
          ) : null}
          <div className="actions">
            <button type="button" disabled={turnIndex === 0} onClick={() => setTurnIndex((current) => current - 1)}>Previous</button>
            <button type="button" disabled={turnIndex >= row.history.length - 1} onClick={() => setTurnIndex((current) => current + 1)}>Next</button>
          </div>
        </div>
      )}
      <details className="panel">
        <summary>Operator view of the hidden cards</summary>
        <p>These cards are not sent to the other agent. A model prompt receives only the acting side's card.</p>
        <h3>Buyer</h3>
        <pre>{JSON.stringify(batch.scenario.parties.buyer.private, null, 2)}</pre>
        <h3>Seller</h3>
        <pre>{JSON.stringify(batch.scenario.parties.seller.private, null, 2)}</pre>
      </details>
    </section>
  );
}
