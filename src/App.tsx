import { useCallback, useMemo, useState } from "react";
import type { ScenarioDefinition } from "./engine.ts";
import { loadBundledDefinitions, loadBundledFixtures } from "./fixtures.ts";
import { useSession } from "./lib/session.ts";
import { supabaseConfigError } from "./lib/supabase.ts";
import { navigate, useRoute } from "./route.ts";
import type { ImportedTranscript, RunRecord } from "./runState.ts";
import type { SessionBatch } from "./savedBatch.ts";
import { Account } from "./views/Account.tsx";
import { Bench } from "./views/Bench.tsx";
import { LegacyReplay } from "./views/LegacyReplay.tsx";
import { Replay } from "./views/Replay.tsx";
import { Results } from "./views/Results.tsx";
import { Scenarios } from "./views/Scenarios.tsx";

export type Mode = "sandbox" | "live";

export function App() {
  const route = useRoute();
  const bundled = useMemo(() => loadBundledDefinitions(), []);
  const bundledFixtures = useMemo(() => loadBundledFixtures(), []);
  const [added, setAdded] = useState<ScenarioDefinition[]>([]);
  const definitions = useMemo(() => {
    const map = new Map<string, ScenarioDefinition>();
    for (const definition of bundled.definitions) map.set(definition.id, definition);
    for (const definition of added) map.set(definition.id, definition);
    return [...map.values()];
  }, [added, bundled.definitions]);
  const [selectedId, setSelectedId] = useState(bundled.definitions[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("sandbox");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [imports, setImports] = useState<ImportedTranscript[]>([]);
  const [legacyBatch, setLegacyBatch] = useState<SessionBatch | null>(null);
  const startupErrors = [...bundled.errors, ...bundledFixtures.errors];
  const [notice, setNotice] = useState<string | null>(startupErrors.length ? startupErrors.join(" ") : null);
  const session = useSession();
  const selected = definitions.find((definition) => definition.id === selectedId) ?? definitions[0] ?? null;

  const upsertRun = useCallback((run: RunRecord) => {
    setRuns((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
  }, []);
  const addImport = useCallback((item: ImportedTranscript) => {
    setImports((current) => [item, ...current.filter((existing) => existing.id !== item.id)]);
  }, []);

  const param = (name: string) => route.params.get(name);
  const runParam = param("run");
  const currentRun = runs.find((run) => run.runId === runParam) ?? runs[0] ?? null;
  const planValue = Number(param("plan") ?? "0");
  const planIndex = Number.isInteger(planValue) && planValue >= 0 ? planValue : 0;

  let page = <p>That page is not in the sandbox. <a href="/?page=scenarios" onClick={(event) => { event.preventDefault(); navigate("scenarios"); }}>Back to scenarios</a></p>;
  if (route.page === "scenarios") {
    page = (
      <Scenarios
        definitions={definitions}
        selectedId={selected?.id ?? ""}
        session={session}
        onSelect={setSelectedId}
        onLoad={(definition) => {
          setAdded((current) => [...current.filter((item) => item.id !== definition.id), definition]);
          setSelectedId(definition.id);
        }}
        onNotice={setNotice}
      />
    );
  } else if (route.page === "bench") {
    page = (
      <Bench
        definition={selected}
        fixtures={bundledFixtures.fixtures}
        mode={mode}
        onMode={setMode}
        session={session}
        onRun={upsertRun}
        onNotice={setNotice}
      />
    );
  } else if (route.page === "results") {
    page = <Results runs={runs} run={currentRun} session={session} onNotice={setNotice} />;
  } else if (route.page === "replay") {
    const legacy = param("legacy") === "1";
    const importId = param("import");
    const rowValue = Number(param("row") ?? "0");
    page = legacy
      ? <LegacyReplay batch={legacyBatch} rowIndex={Number.isInteger(rowValue) && rowValue >= 0 ? rowValue : 0} />
      : <Replay run={importId ? null : currentRun} planIndex={planIndex} imported={imports.find((item) => item.id === importId) ?? null} imports={imports} onImport={addImport} onNotice={setNotice} />;
  } else if (route.page === "account") {
    page = <Account session={session} onLegacyReplay={setLegacyBatch} onImport={addImport} onNotice={setNotice} />;
  }

  return (
    <div className="app">
      <header className="mast">
        <div>
          <p className="eyebrow">Two parties, hidden cards</p>
          <h1>Negotiation sandbox</h1>
        </div>
        <nav aria-label="Sections">
          {["scenarios", "bench", "results", "replay", "account"].map((section) => (
            <a
              key={section}
              href={`/?page=${section}`}
              aria-current={route.page === section ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(section);
              }}
            >
              {section[0]?.toUpperCase()}{section.slice(1)}
            </a>
          ))}
        </nav>
      </header>
      <p className="modebar" role="status">
        Mode: <strong>{mode === "sandbox" ? "Sandbox" : "Live"}</strong>
        {mode === "sandbox"
          ? " - scripted and synthetic seats run in this browser, with no account, database or provider."
          : " - model seats call negotiate-turn; each attempt counts against your daily allowance."}
      </p>
      {supabaseConfigError ? <p className="banner">{supabaseConfigError}</p> : null}
      {session.recovery && route.page !== "account" ? <p className="notice" role="alert">Password recovery link accepted. <a href="/?page=account" onClick={(event) => { event.preventDefault(); navigate("account"); }}>Set a new password</a>.</p> : null}
      {notice ? <p className="notice" role="status">{notice} <button type="button" className="link" onClick={() => setNotice(null)}>Dismiss</button></p> : null}
      <main>{page}</main>
      <p className="footer">
        This is an operator-controlled simulation: the operator sees both private cards and full exports contain them.
        Private means absent from the counterpart agent's observation and model request.
      </p>
    </div>
  );
}
