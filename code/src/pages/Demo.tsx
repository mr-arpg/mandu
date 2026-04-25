import { useLayoutEffect, useRef } from "react";
import Index from "./Index.tsx";
import { DEMO_TASK_ROWS, type DemoTaskRow } from "@/demoTasks";

/**
 * GitHub Pages demo wrapper.
 *
 * The "real" app (`Index.tsx`) talks to `http://localhost:3001/api/tasks` over
 * `fetch()`. GitHub Pages is a static host — no Node, no SQLite — so those
 * requests would all fail.
 *
 * Rather than fork or modify `Index.tsx` (it's 1800+ lines of carefully tuned
 * timer/animation logic), this page mounts a tiny in-memory store and a
 * `window.fetch` proxy that handles every `/api/tasks*` URL the way `server.js`
 * would. Anything else falls through to the original `fetch`. The proxy is
 * installed in `useLayoutEffect`, which runs *before* `Index`'s mount-time
 * `useEffect` that does the initial GET, so by the time `Index` reaches out to
 * the "server" the mock is already in place.
 *
 * The proxy is uninstalled on unmount so navigating away from the demo route
 * (or React StrictMode's double-mount) doesn't leak the patch.
 */

const CATEGORY_COLORS = [
  "#61DAFB",
  "#A855F7",
  "#10B981",
  "#FB7185",
  "#F97316",
  "#22D3EE",
  "#8B5CF6",
  "#14B8A6",
  "#F43F5E",
  "#3B82F6",
  "#EDEBD7",
];

type StoredTask = DemoTaskRow;

/**
 * Mirror of `tasksWithColorsFromRows` in `server.js`: assign colors by walking
 * the rows in order and tracking distinct categories. Whatever Index expects
 * the server to send back, this needs to send back.
 */
function withColors(rows: StoredTask[]) {
  const uniqueCategories: string[] = [];
  for (const t of rows) {
    if (!uniqueCategories.includes(t.category)) {
      uniqueCategories.push(t.category);
    }
  }
  return rows.map((task) => {
    const idx = uniqueCategories.indexOf(task.category);
    const safeIdx = idx === -1 ? 0 : idx;
    return { ...task, color: CATEGORY_COLORS[safeIdx % CATEGORY_COLORS.length] };
  });
}

const TASKS_URL_RE = /\/api\/tasks(?:\/(\d+))?$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const Demo = () => {
  const storeRef = useRef<StoredTask[]>(
    DEMO_TASK_ROWS.map((row) => ({ ...row }))
  );

  useLayoutEffect(() => {
    const originalFetch = window.fetch.bind(window);

    const mockFetch: typeof window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url;

      const match = url.match(TASKS_URL_RE);
      if (!match) {
        return originalFetch(input, init);
      }

      const idStr = match[1];
      const method = (init?.method ?? "GET").toUpperCase();
      const store = storeRef.current;

      // Mirrors the server's ACTIVE_TASKS_QUERY: hide rows where time === 'done'.
      if (method === "GET" && !idStr) {
        const active = store.filter((t) => (t.time ?? "") !== "done");
        return jsonResponse(withColors(active));
      }

      if (method === "PUT" && idStr) {
        const id = Number(idStr);
        const idx = store.findIndex((t) => t.id === id);
        if (idx === -1) {
          return jsonResponse({ error: "not found" }, 404);
        }
        let body: Partial<StoredTask> = {};
        if (init?.body) {
          try {
            body = JSON.parse(
              typeof init.body === "string"
                ? init.body
                : new TextDecoder().decode(init.body as ArrayBuffer)
            );
          } catch {
            body = {};
          }
        }
        store[idx] = {
          ...store[idx],
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.time !== undefined ? { time: body.time } : {}),
          ...(body.current_time !== undefined
            ? { current_time: body.current_time }
            : {}),
        };
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "method not allowed" }, 405);
    };

    window.fetch = mockFetch;
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return <Index />;
};

export default Demo;
