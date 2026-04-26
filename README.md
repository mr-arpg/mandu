# 🥟 mandu 

A keyboard-first, single-task-at-a-time timer. Each task takes the whole
screen, drains a wipe from top to bottom over its duration, and lets you flip
between tasks/categories with the arrow keys. Built with React + Vite +
Framer Motion on the front end and a small Express + SQLite service on the
back end.

## Repo layout

```
mandu/
├── server.js          # Express + SQLite API (port 3001)
├── database.sqlite    # auto-created on first run, gitignored
├── package.json       # backend deps
└── code/              # Vite + React front end
    ├── src/
    │   ├── pages/
    │   │   ├── Index.tsx   # the real app — talks to the API
    │   │   └── Demo.tsx    # GitHub Pages demo wrapper (mocks fetch)
    │   └── demoTasks.ts    # hardcoded seed rows (mirror of server seeds)
    └── package.json
```

## Controls

- <kbd>Space</kbd> — start / pause the current task's timer.
- <kbd>←</kbd> / <kbd>→</kbd> — switch to the previous / next task.
- <kbd>↑</kbd> / <kbd>↓</kbd> — cycle the current task's category (and color).
- Long-press <kbd>Space</kbd> — force-complete the current task.

## Running locally (full stack)

You need two terminals: one for the API, one for the Vite dev server.

```bash
# Terminal 1 — API on http://localhost:3001
npm install
npm start

# Terminal 2 — front end on http://localhost:8080
cd code
npm install
npm run dev
```

The app is at `http://localhost:8080/`. The first run seeds the SQLite DB
with three demo tasks (see `INITIAL_TASKS` in `server.js`). Editing or
finishing a task is persisted across reloads.

### Trying the demo route locally

The same hardcoded demo that ships to GitHub Pages is also wired up at
`http://localhost:8080/demo`. It does **not** hit the backend — it intercepts
`fetch` calls to `/api/tasks*` and serves the rows from `code/src/demoTasks.ts`
in memory. Useful if you want to play with the UI without starting the server.

## GitHub Pages demo

GitHub Pages is static-only (no Node, no SQLite), so the live app cannot run
there as-is. The deployed site is the demo: it loads `Index.tsx` exactly as
in production, but `Demo.tsx` patches `window.fetch` for `/api/tasks*` URLs
and answers from an in-memory copy of the seed rows. `Index.tsx` itself is
unchanged — same timer logic, same animations, same code path.

### One-time setup

1. **Repository settings → Pages** → set "Source" to "GitHub Actions".
2. Push to `main`. The workflow at `.github/workflows/deploy-pages.yml`
   builds with `npm run build:github-pages` and publishes the `code/dist/`
   folder.
3. Visit `https://<your-user>.github.io/<repo-name>/`.

The workflow passes `GITHUB_PAGES_BASE=/<repo-name>/` so Vite emits assets
with the right prefix, and copies `index.html` to `404.html` so deep links
fall back to the SPA.

### Local preview of the GH Pages build

```bash
cd code
GITHUB_PAGES_BASE=/ npm run build:github-pages
npm run preview
```

(`GITHUB_PAGES_BASE=/` because there's no `/<repo>/` prefix when you preview
from `localhost`.)

## How it stays in sync

`code/src/demoTasks.ts` mirrors `INITIAL_TASKS` in `server.js`. If you edit
the seeds in one place, copy the change to the other so the demo reflects a
fresh DB. There is no build-time check that enforces this — it's a manual
mirror, kept short on purpose.
