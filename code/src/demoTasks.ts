/**
 * Same seed rows as `INITIAL_TASKS` in the root `server.js` SQLite bootstrap.
 * Loaded by `Demo.tsx` so the GitHub Pages build can run the full UI without
 * a backend — the demo intercepts `fetch` and serves these rows from memory.
 */
export type DemoTaskRow = {
  id: number;
  category: string;
  time: string;
  text: string;
  current_time: string;
};

export const DEMO_TASK_ROWS: DemoTaskRow[] = [
  {
    id: 1,
    category: "demo",
    time: "10 sec",
    text: 'press space bar to start your task!',
    current_time: "10 sec",
  },
  {
    id: 2,
    category: "demo",
    time: "30 sec",
    text: "hit space again after starting a task to pause it!",
    current_time: "30 sec",
  },
  {
    id: 3,
    category: "demo",
    time: "1 min",
    text: "use arrows to change tasks and categories",
    current_time: "1 min",
  },
  {
    id: 4,
    category: "demo",
    time: "1 min",
    text: "long press space to complete a task",
    current_time: "1 min",
  },
  {
    id: 5,
    category: "personal",
    time: "2 min",
    text: "smile for 2 minutes straight",
    current_time: "2 min",
  },
];
