import { useEffect, useState } from "react";

export type Route = { page: string; params: URLSearchParams };

export function navigate(page: string, extra?: Record<string, string>): void {
  const params = new URLSearchParams({ page, ...extra });
  window.history.pushState(null, "", `/?${params.toString()}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return route;
}

function readRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  return { page: params.get("page") || "scenarios", params };
}
