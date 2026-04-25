const express = require("express");
const cors = require("cors");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = 3001;
/** Allow any localhost / 127.0.0.1 dev origin so vite port shifts (8080 -> 8081 ...) don't break CORS. */
const DEV_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const DB_PATH = path.join(__dirname, "database.sqlite");
const CATEGORY_COLORS = [
  "#61DAFB", // cyan
  "#A855F7", // purple
  "#10B981", // emerald
  "#FB7185", // coral pink
  "#F97316", // orange
  "#22D3EE", // bright teal
  "#8B5CF6", // violet
  "#14B8A6", // aqua green
  "#F43F5E", // rose red
  "#3B82F6", // blue
  "#EDEBD7", // white-ish, always last fallback
];

/**
 * Assign a color to each task by walking the rows in order and tracking which categories
 * we've already seen. The Nth distinct category gets `CATEGORY_COLORS[N]`. The white-ish
 * slot (`#EDEBD7`) sits last in the palette on purpose, so it only kicks in after the 10
 * other colors are exhausted.
 */
function tasksWithColorsFromRows(rows) {
  const uniqueCategories = [];
  for (const task of rows) {
    if (!uniqueCategories.includes(task.category)) {
      uniqueCategories.push(task.category);
    }
  }
  return rows.map((task) => {
    const idx = uniqueCategories.indexOf(task.category);
    const safeIdx = idx === -1 ? 0 : idx;
    return { ...task, color: CATEGORY_COLORS[safeIdx % CATEGORY_COLORS.length] };
  });
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || DEV_ORIGIN_PATTERN.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  })
);
app.use(express.json());

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Failed to connect to SQLite database:", err.message);
    process.exit(1);
  }
});

const INITIAL_TASKS = [
  { category: "demo", time: "1 min", text: 'press espace "⎵" to start your task!' },
  { category: "demo", time: "1 min", text: "press espace again after starting a task to pause it!" },
  { category: "personal", time: "2 min", text: "smile for 2 minutes straight" },
];

function initializeDatabase() {
  db.serialize(() => {
    db.run(
      `
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        category TEXT,
        time TEXT,
        text TEXT,
        current_time TEXT
      )
      `,
      (createErr) => {
        if (createErr) {
          console.error("Failed to create tasks table:", createErr.message);
          process.exit(1);
        }
      }
    );

    // Idempotent migration: older databases were created without `current_time`.
    // SQLite has no IF NOT EXISTS for ADD COLUMN, so we just attempt it and
    // swallow the "duplicate column name" error. Bracket the column to disambiguate
    // from the built-in time-of-day function of the same name.
    db.run("ALTER TABLE tasks ADD COLUMN [current_time] TEXT", (alterErr) => {
      if (alterErr && !/duplicate column name/i.test(alterErr.message)) {
        console.error("Failed to add current_time column:", alterErr.message);
      }
    });

    db.get("SELECT COUNT(*) AS count FROM tasks", (countErr, row) => {
      if (countErr) {
        console.error("Failed to check tasks count:", countErr.message);
        process.exit(1);
      }

      if (row.count > 0) {
        return;
      }

      const insertTask = db.prepare(
        "INSERT INTO tasks (category, time, text, [current_time]) VALUES (?, ?, ?, ?)"
      );

      INITIAL_TASKS.forEach((task) => {
        insertTask.run(task.category, task.time, task.text, task.time);
      });

      insertTask.finalize((finalizeErr) => {
        if (finalizeErr) {
          console.error("Failed to insert initial tasks:", finalizeErr.message);
          process.exit(1);
        }
      });
    });
  });
}

initializeDatabase();

/**
 * SQL fragment used by every "give me the user-facing task list" query. Tasks whose `time`
 * column is the sentinel value `'done'` are kept in the database for history but are hidden
 * from the API so they disappear from the cycle. `COALESCE` guards against NULL legacy rows.
 *
 * `current_time` falls back to `time` for any row that doesn't have one yet (legacy / never
 * paused). Front-end always reads `current_time` for the live timer state.
 *
 * NOTE: `current_time` is a built-in SQLite time-of-day FUNCTION when used unquoted in an
 * expression. Without the brackets the COALESCE happily picks up the function's value
 * (e.g. "17:52:26") instead of the column. We bracket-quote on every read to force the
 * column lookup. The OUTPUT alias stays unquoted — it's just a name in the result set.
 */
const ACTIVE_TASKS_QUERY =
  "SELECT id, category, time, text, COALESCE(NULLIF([current_time], ''), time) AS current_time " +
  "FROM tasks WHERE COALESCE(time, '') != 'done' ORDER BY id ASC";

app.get("/api/tasks", (_req, res) => {
  db.all(ACTIVE_TASKS_QUERY, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch tasks" });
    }
    return res.json(tasksWithColorsFromRows(rows));
  });
});

app.put("/api/tasks/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const body = req.body ?? {};

  // Build the UPDATE dynamically so the same endpoint can patch `category`, `time`,
  // `current_time`, or any combination. Hits we expect:
  //   - `{ category }`           — Up/Down arrow cycle (when navigating).
  //   - `{ time: "done" }`       — long-press marks a task complete.
  //   - `{ current_time: "X sec" }` — periodic / on-pause sync of remaining time.
  //   - `{ current_time: "<originalTime>" }` — natural completion resets to start.
  const setClauses = [];
  const params = [];
  if (typeof body.category === "string" && body.category.trim()) {
    setClauses.push("category = ?");
    params.push(body.category.trim());
  }
  if (typeof body.time === "string" && body.time.trim()) {
    setClauses.push("time = ?");
    params.push(body.time.trim());
  }
  if (typeof body.current_time === "string" && body.current_time.trim()) {
    // Bracket-quote the column name so SQLite reads it as a column rather than the
    // built-in CURRENT_TIME time-of-day function.
    setClauses.push("[current_time] = ?");
    params.push(body.current_time.trim());
  }
  if (setClauses.length === 0) {
    return res
      .status(400)
      .json({ error: "Nothing to update (expected category, time, and/or current_time)" });
  }

  params.push(id);
  db.run(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`, params, function (err) {
    if (err) {
      return res.status(500).json({ error: "Failed to update task" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Task not found" });
    }
    db.all(ACTIVE_TASKS_QUERY, (allErr, allRows) => {
      if (allErr) {
        return res.status(500).json({ error: "Failed to fetch tasks" });
      }
      return res.json(tasksWithColorsFromRows(allRows));
    });
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
