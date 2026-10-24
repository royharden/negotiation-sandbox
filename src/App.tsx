import { useMemo, useState } from "react";
import type { Scenario } from "./engine.ts";
import { loadBundledScenarios } from "./fixtures.ts";
import { useSession } from "./lib/session.ts";
import { supabaseConfigError } from "./lib/supabase.ts";
import { navigate, useRoute } from "./route.ts";
import type { SessionBatch } from "./savedBatch.ts";
import { Account } from "./views/Account.tsx";
import { Bench } from "./views/Bench.tsx";
import { Replay } from "./views/Replay.tsx";
import { Results } from "./views/Results.tsx";
import { Scenarios } from "./views/Scenarios.tsx";

export function App() {
  const route = useRoute();
  const bundled = useMemo(() => loadBundledScenarios(), []);
  const [added, setAdded] = useState<Scenario[]>([]);
  const scenarios = useMemo(() => {
    const map = new Map<string, Scenario>();
    for (const scenario of bundled.scenarios) map.set(scenario.id, scenario);
    for (const scenario of added) map.set(scenario.id, scenario);
    return [...map.values()];
  }, [added, bundled.scenarios]);
  const [selectedId, setSelectedId] = useState(bundled.scenarios[0]?.id ?? "");
  const [batch, setBatch] = useState<SessionBatch | null>(null);
  const [notice, setNotice] = useState<string | null>(bundled.errors.length ? bundled.errors.join(" ") : null);
  const session = useSession();
  const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? scenarios[0] ?? null;
  const rowValue = Number(route.params.get("row") ?? "0");
  const rowIndex = Number.isInteger(rowValue) && rowValue >= 0 ? rowValue : 0;

  let page = <p>That page is not in the sandbox. <a href="/?page=scenarios" onClick={(event) => { event.preventDefault(); navigate("scenarios"); }}>Back to scenarios</a></p>;
  if (route.page === "scenarios") {
    page = (
      <Scenarios
        scenarios={scenarios}
        selectedId={selected?.id ?? ""}
        session={session}
        onSelect={setSelectedId}
        onLoad={(scenario) => {
          setAdded((current) => [...current.filter((item) => item.id !== scenario.id), scenario]);
          setSelectedId(scenario.id);
        }}
        onNotice={setNotice}
      />
    );
  } else if (route.page === "bench") {
    page = <Bench scenario={selected} onBatch={setBatch} onNotice={setNotice} />;
  } else if (route.page === "results") {
    page = <Results batch={batch} session={session} onNotice={setNotice} />;
  } else if (route.page === "replay") {
    page = <Replay batch={batch} rowIndex={rowIndex} />;
  } else if (route.page === "account") {
    page = <Account session={session} onReplay={setBatch} onNotice={setNotice} />;
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
      {supabaseConfigError ? <p className="banner">{supabaseConfigError}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <main>{page}</main>
      <p className="footer">Scripted games run in this browser. Saved runs and model calls use your Bolt database.</p>
    </div>
  );
}

