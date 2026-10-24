import { useState } from "react";
import type { AgentId, Scenario } from "../engine.ts";
import { runBatch } from "../engine.ts";
import { modelDecide } from "../lib/modelTurn.ts";
import { navigate } from "../route.ts";
import { parseSeeds } from "../seeds.ts";
import type { SessionBatch } from "../savedBatch.ts";

const AGENTS: AgentId[] = ["concession", "firm", "bluff", "model"];
const DEFAULTS = ["concession|concession", "concession|firm", "bluff|concession"];

export function Bench(props: {
  scenario: Scenario | null;
  onBatch: (batch: SessionBatch) => void;
  onNotice: (message: string | null) => void;
}) {
  const [seeds, setSeeds] = useState("1, 2");
  const [checked, setChecked] = useState<string[]>(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scenario = props.scenario;

  function toggle(key: string) {
    setChecked((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  async function run() {
    if (!scenario) return;
    const parsedSeeds = parseSeeds(seeds);
    if (!parsedSeeds.ok) {
      setError(parsedSeeds.error);
      return;
    }
    const pairings = checked.flatMap((key) => {
      const [buyer, seller] = key.split("|");
      if (!isAgent(buyer) || !isAgent(seller)) return [];
      return [{ buyer, seller }];
    });
    if (pairings.length === 0) {
      setError("Choose at least one pairing.");
      return;
    }
    setError(null);
    setRunning(true);
    props.onNotice(null);
    try {
      const rows = await runBatch({
        scenario,
        seeds: parsedSeeds.seeds,
        pairings,
        stopOnBlocked: true,
        decide: modelDecide(scenario),
      });
      const blocked = rows.find((row) => row.status === "blocked");
      props.onBatch({
        label: `${scenario.id} seeds ${parsedSeeds.seeds.join(" ")}`,
        scenario,
        rows,
      });
      navigate("results");
      props.onNotice(blocked?.error ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The batch stopped.");
    } finally {
      setRunning(false);
    }
  }

  if (!scenario) return <p className="notice">Load a scenario before running a batch.</p>;

  const usesModel = checked.some((key) => key.includes("model"));

  return (
    <section className="panel">
      <h2>Run {scenario.title}</h2>
      <p>{scenario.rules.maxRounds} rounds, {scenario.rules.openingRole} opens. The same seeds are played for every checked pairing.</p>
      <label htmlFor="seeds">Seeds</label>
      <input id="seeds" type="text" value={seeds} onChange={(event) => setSeeds(event.target.value)} />
      <fieldset className="pairings">
        <legend>Pairings</legend>
        {AGENTS.flatMap((buyer) => AGENTS.map((seller) => {
          const key = `${buyer}|${seller}`;
          return (
            <label key={key}>
              <input type="checkbox" checked={checked.includes(key)} onChange={() => toggle(key)} /> {buyer} vs {seller}
            </label>
          );
        }))}
      </fieldset>
      {usesModel ? (
        <p>A model sees only its own private card. If the server secret is missing, the batch stops and no offer is invented.</p>
      ) : null}
      {error ? <p className="notice" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" disabled={running} onClick={() => void run()}>{running ? "Running…" : "Run batch"}</button>
      </div>
    </section>
  );
}

function isAgent(value: string | undefined): value is AgentId {
  return value === "concession" || value === "firm" || value === "bluff" || value === "model";
}
