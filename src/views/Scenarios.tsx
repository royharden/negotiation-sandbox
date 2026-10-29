import { useMemo, useState } from "react";
import { analyzeGrid, canonicalJson, instantiate, parseScenarioText, toPublicScenario } from "../engine.ts";
import type { Role, ScenarioDefinition } from "../engine.ts";
import { formatPoints } from "../format.ts";
import { saveScenario } from "../lib/repository.ts";
import type { SessionState } from "../lib/session.ts";
import { downloadText } from "../runState.ts";

export function Scenarios(props: {
  definitions: ScenarioDefinition[];
  selectedId: string;
  session: SessionState;
  onSelect: (id: string) => void;
  onLoad: (definition: ScenarioDefinition) => void;
  onNotice: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seedText, setSeedText] = useState("1");
  const selected = props.definitions.find((definition) => definition.id === props.selectedId) ?? null;

  async function save() {
    if (!selected || props.session.userId === null) return;
    setSaving(true);
    const message = await saveScenario(props.session.userId, selected);
    setSaving(false);
    props.onNotice(message ?? `Saved ${selected.title} to your account.`);
  }

  function validate() {
    const parsed = parseScenarioText(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    props.onLoad(parsed.definition);
    props.onNotice(`Loaded ${parsed.definition.title} (schema v${parsed.definition.schemaVersion}).`);
  }

  return (
    <section>
      <div className="grid">
        {props.definitions.map((definition) => (
          <article key={definition.id} className={definition.id === props.selectedId ? "card selected" : "card"}>
            <p className="eyebrow">
              {definition.schemaVersion === 2 ? "schema v2 / ruleset 2" : "schema v1 / legacy ruleset"}
              {definition.schemaVersion === 2 && definition.variation ? " / sampled cards" : " / fixed cards"}
            </p>
            <h2>{definition.title}</h2>
            <p>{definition.publicBrief}</p>
            <ul className="chips">
              {definition.issues.map((issue) => <li key={issue.id}>{issue.label}</li>)}
            </ul>
            <div className="actions">
              <button type="button" onClick={() => props.onSelect(definition.id)}>Use this scenario</button>
            </div>
          </article>
        ))}
      </div>

      {selected ? <Inspector definition={selected} seedText={seedText} onSeedText={setSeedText} /> : null}

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h2>Load a scenario file</h2>
        <p>Paste schema version 1 or 2 JSON (at most 32 KiB; duplicate keys and unknown fields are rejected). The referee checks the document before it can be run.</p>
        <label htmlFor="scenario-json">Scenario JSON</label>
        <textarea id="scenario-json" value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
        {error ? <p className="notice" role="alert">{error}</p> : null}
        <div className="actions">
          <button type="button" disabled={draft.trim() === ""} onClick={validate}>Validate and load</button>
          <button
            type="button"
            className="secondary"
            disabled={!selected}
            onClick={() => selected && downloadText(`${selected.id}.json`, `${JSON.stringify(selected, null, 2)}\n`, "application/json")}
          >
            Download selected JSON
          </button>
          <button type="button" className="secondary" disabled={!selected || props.session.status !== "ready" || saving} onClick={() => void save()}>
            Save selected to account
          </button>
        </div>
        <p className="hint">A downloaded definition contains both private cards. Saving needs a signed-in owner.</p>
      </div>
    </section>
  );
}

function Inspector(props: { definition: ScenarioDefinition; seedText: string; onSeedText: (text: string) => void }) {
  const { definition } = props;
  const seed = /^\d{1,10}$/.test(props.seedText.trim()) ? Number(props.seedText.trim()) : null;
  const built = useMemo(() => (seed === null ? null : instantiate(definition, seed)), [definition, seed]);
  const instance = built?.ok ? built.instance : null;
  const grid = useMemo(() => {
    if (!instance) return null;
    try {
      return analyzeGrid(instance.scenario, instance.instanceId);
    } catch (problem) {
      return problem instanceof Error ? problem.message : "grid analysis failed";
    }
  }, [instance]);
  const publicView = toPublicScenario(definition);
  const roleLabel = (role: Role) => definition.parties[role].label ?? role;

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2>{definition.title}</h2>
      <h3>Public scenario (what both agents see)</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Issue</th><th>Kind</th><th>Range or options</th></tr></thead>
          <tbody>
            {publicView.issues.map((issue) => (
              <tr key={issue.id}>
                <td>{issue.label} <span className="tag">{issue.id}</span></td>
                <td>{issue.kind}</td>
                <td>{issue.kind === "number" ? `${issue.min} to ${issue.max}, step ${issue.step}${issue.unit ? ` ${issue.unit}` : ""}` : issue.options.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Max rounds {definition.rules.maxRounds} ({definition.rules.maxRounds * 2} legal turns at most); {roleLabel(definition.rules.openingRole)} opens.</p>
      {(["buyer", "seller"] as const).map((role) => (
        <p key={role}><strong>{roleLabel(role)}</strong> ({role}): {definition.parties[role].publicBrief}</p>
      ))}

      <h3>Instance</h3>
      <label htmlFor="inspect-seed">Instance seed (0 to 1000000000)</label>
      <input id="inspect-seed" type="text" inputMode="numeric" value={props.seedText} onChange={(event) => props.onSeedText(event.target.value)} />
      {built && !built.ok ? <p className="notice" role="alert">{built.error}</p> : null}
      {instance ? (
        <>
          <p>
            Generator <span className="tag">{instance.generator}</span>, instance id <span className="tag">{instance.instanceId.slice(0, 16)}</span>
            {instance.generator === "fixed-v1" ? " - v1 cards are fixed; the seed only drives scripted policies." : " - the seed samples bounded offsets to the cards before play."}
          </p>
          {typeof grid === "string" ? <p className="notice">{grid}</p> : grid ? (
            <p>
              {grid.packageCount} legal packages.{" "}
              {grid.zopaEmpty
                ? "ZOPA is empty: no package is at least as good as walking away for both sides, so any agreement violates someone's reservation."
                : `ZOPA is non-empty: the best package for both sides together beats both walk-away baselines by ${formatPoints(grid.maxJointGain)} utility units in total.`}
            </p>
          ) : null}
          {definition.schemaVersion === 1 && (["buyer", "seller"] as const).some((role) => (definition.rules.disagreementUtility ?? 0) !== definition.parties[role].private.reservationUtility) ? (
            <p className="banner">Legacy baseline: this v1 file pays a shared no-deal utility of {definition.rules.disagreementUtility ?? 0}, which differs from the reservation thresholds. Historical scores keep that definition.</p>
          ) : null}
          <details>
            <summary>Operator view: both private cards for this instance</summary>
            <p>Neither card is sent to the other agent. A model request receives only its own role's card.</p>
            {(["buyer", "seller"] as const).map((role) => (
              <div key={role}>
                <h4>{roleLabel(role)} ({role})</h4>
                <pre>{JSON.stringify(instance.scenario.parties[role].private, null, 2)}</pre>
              </div>
            ))}
            <p className="hint">Canonical instance bytes: {canonicalJson(instance.scenario).length} characters.</p>
          </details>
        </>
      ) : null}
    </div>
  );
}
