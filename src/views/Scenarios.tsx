import { useState } from "react";
import type { Scenario } from "../engine.ts";
import { parseScenario } from "../engine.ts";
import { saveScenario } from "../lib/repository.ts";
import type { SessionState } from "../lib/session.ts";

export function Scenarios(props: {
  scenarios: Scenario[];
  selectedId: string;
  session: SessionState;
  onSelect: (id: string) => void;
  onLoad: (scenario: Scenario) => void;
  onNotice: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = props.scenarios.find((scenario) => scenario.id === props.selectedId) ?? null;

  async function save() {
    if (!selected || props.session.userId === null) return;
    setSaving(true);
    const message = await saveScenario(props.session.userId, selected);
    setSaving(false);
    props.onNotice(message ?? `Saved ${selected.title} to your account.`);
  }

  return (
    <section>
      <div className="grid">
        {props.scenarios.map((scenario) => (
          <article key={scenario.id} className={scenario.id === props.selectedId ? "card selected" : "card"}>
            <h2>{scenario.title}</h2>
            <p>{scenario.publicBrief}</p>
            <ul className="chips">
              {scenario.issues.map((issue) => <li key={issue.id}>{issue.label}</li>)}
            </ul>
            <div className="actions">
              <button type="button" onClick={() => props.onSelect(scenario.id)}>Use this scenario</button>
            </div>
          </article>
        ))}
      </div>
      <div className="panel" style={{ marginTop: "1rem" }}>
        <h2>Load a scenario file</h2>
        <p>Paste schema version 1 JSON. The referee checks the document before it can be run.</p>
        <label htmlFor="scenario-json">Scenario JSON</label>
        <textarea
          id="scenario-json"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        {error ? <p className="notice" role="alert">{error}</p> : null}
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              try {
                const parsed = parseScenario(JSON.parse(draft) as unknown);
                if (!parsed.ok) {
                  setError(parsed.error);
                  return;
                }
                setError(null);
                props.onLoad(parsed.scenario);
                props.onNotice(`Loaded ${parsed.scenario.title}.`);
              } catch {
                setError("That text is not JSON.");
              }
            }}
          >
            Validate and load
          </button>
          <button type="button" className="secondary" disabled={!selected || props.session.status !== "ready" || saving} onClick={() => void save()}>
            Save selected to account
          </button>
        </div>
      </div>
    </section>
  );
}
