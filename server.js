const express = require("express");
const cors = require("cors");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = 3001;
const FRONTEND_ORIGIN = "http://localhost:8080";
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

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
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
        text TEXT
      )
      `,
      (createErr) => {
        if (createErr) {
          console.error("Failed to create tasks table:", createErr.message);
          process.exit(1);
        }
      }
    );

    db.get("SELECT COUNT(*) AS count FROM tasks", (countErr, row) => {
      if (countErr) {
        console.error("Failed to check tasks count:", countErr.message);
        process.exit(1);
      }

      if (row.count > 0) {
        return;
      }

      const insertTask = db.prepare(
        "INSERT INTO tasks (category, time, text) VALUES (?, ?, ?)"
      );

      INITIAL_TASKS.forEach((task) => {
        insertTask.run(task.category, task.time, task.text);
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

app.get("/api/tasks", (_req, res) => {
  db.all("SELECT id, category, time, text FROM tasks ORDER BY id ASC", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch tasks" });
    }

    const uniqueCategories = [];

    rows.forEach((task) => {
      if (!uniqueCategories.includes(task.category)) {
        uniqueCategories.push(task.category);
      }
    });

    const tasksWithColors = rows.map((task) => ({
      ...task,
      color:
        CATEGORY_COLORS[
          uniqueCategories.indexOf(task.category) % CATEGORY_COLORS.length
        ],
    }));

    return res.json(tasksWithColors);
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
