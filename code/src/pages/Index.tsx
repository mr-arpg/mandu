import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type Task = {
  id: number;
  category: string;
  time: string;
  text: string;
  color: string;
};

type TaskTimer = {
  remainingSeconds: number;
  animationBaseSeconds: number;
  isRunning: boolean;
};

const slideVariants = {
  enter: (direction: number) => ({ x: direction === 1 ? "100vw" : "-100vw" }),
  center: { x: 0 },
  exit: (direction: number) => ({ x: direction === 1 ? "-100vw" : "100vw" }),
};

/**
 * Color palette. Each unique category, in order of first appearance among the loaded tasks,
 * gets the next color slot. The 11th slot (`#EDEBD7`, white-ish) is intentionally last so it
 * only ever appears after all 10 other colors have been used.
 */
const CATEGORY_COLORS: readonly string[] = [
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

/**
 * Unique list of categories from a committed (id -> category) map, in id-ascending order
 * of first appearance. This is the source of truth for both the Up/Down cycle list and
 * the color slot ordering — anchoring on the committed state (instead of the mutated
 * local `tasks` array) avoids two pitfalls:
 *   1. local edits collapsing the unique set and locking the user out of cycling;
 *   2. the color slot index changing under a category mid-session.
 */
function uniqueCategoriesFromCommitted(
  committed: Record<number, string>
): string[] {
  const ids = Object.keys(committed)
    .map((s) => Number(s))
    .sort((a, b) => a - b);
  const seen: string[] = [];
  for (const id of ids) {
    const cat = committed[id];
    if (!seen.includes(cat)) {
      seen.push(cat);
    }
  }
  return seen;
}

/**
 * Re-color tasks against a sticky `categoryOrder`. The order list grows monotonically
 * (categories are only ever appended, never reordered), so once a category lands in slot N
 * it keeps slot N for the rest of the session — no surprise color flips when the user
 * cycles or commits.
 */
function tasksWithClientColors(tasks: Task[], categoryOrder: string[]): Task[] {
  return tasks.map((t) => {
    const idx = categoryOrder.indexOf(t.category);
    const safeIdx = idx === -1 ? 0 : idx;
    return { ...t, color: CATEGORY_COLORS[safeIdx % CATEGORY_COLORS.length] };
  });
}

const categoryVariants = {
  enter: (dir: number) => ({ y: dir === 1 ? -30 : 30, opacity: 0 }),
  center: { y: 0, opacity: 1 },
  exit: (dir: number) => ({ y: dir === 1 ? 30 : -30, opacity: 0 }),
};

function parseTimeToSeconds(time: string): number {
  // Sub-minute timers like "10 sec" / "30 sec" — handy for quick testing of the completion
  // animation without waiting a full minute.
  const matchSeconds = time.match(/^(\d+)\s*sec/i);
  if (matchSeconds) {
    return Math.max(1, Number(matchSeconds[1]));
  }
  const matchMinutes = time.match(/^(\d+)\s*min/i);
  if (matchMinutes) {
    return Math.max(1, Number(matchMinutes[1])) * 60;
  }
  const digits = time.match(/(\d+)/);
  if (digits) {
    return Math.max(1, Number(digits[1])) * 60;
  }
  return 60;
}

function defaultTimerForTask(task: Task): TaskTimer {
  const seconds = parseTimeToSeconds(task.time);
  return {
    remainingSeconds: seconds,
    animationBaseSeconds: Math.max(seconds, 1),
    isRunning: false,
  };
}

/**
 * Pretty-print the time remaining. Above a minute we report whole minutes (ceil), so the
 * label jumps only when a minute boundary is crossed. Under a minute we count seconds —
 * useful for short timers and for the final countdown of any longer timer.
 */
function formatRemainingAsMinutesLabel(remainingSeconds: number): string {
  const whole = Math.max(0, Math.floor(remainingSeconds));
  if (whole < 60) {
    return `${whole} sec`;
  }
  const minutes = Math.ceil(whole / 60);
  return `${minutes} min`;
}

const Index = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [catDirection, setCatDirection] = useState(1);
  const [fadeCategoryOut, setFadeCategoryOut] = useState(false);
  const categoryChangedByKeyRef = useRef(false);
  const [timersByTaskId, setTimersByTaskId] = useState<Record<number, TaskTimer>>({});
  /**
   * What the server currently has stored for each task's category.
   * Up/Down only mutates `tasks` locally — the server is updated lazily, only when the user
   * navigates away from a task (Left/Right). This map lets us (a) detect whether a leaving
   * task is dirty and (b) revert correctly if the eventual PUT fails.
   */
  const [committedCategoryByTaskId, setCommittedCategoryByTaskId] = useState<Record<number, string>>({});
  /**
   * Sticky color-slot ordering. The Nth element of this array gets `CATEGORY_COLORS[N]`.
   * Categories are appended on first sighting and never moved or removed, so each category's
   * color stays stable for the entire session even as the user cycles or commits.
   */
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  /**
   * The task whose timer just hit zero and is currently playing the "done" animation.
   * While set:
   *   - the timer label renders "done" with the gold shine instead of "X min";
   *   - the task line pops out;
   *   - input (arrows/space) is ignored so the animation can't be interrupted;
   *   - after the animation finishes the task is removed from `tasks` and the server is
   *     told to set `time = "done"`.
   */
  const [completingTaskId, setCompletingTaskId] = useState<number | null>(null);
  /** Flips to true once the initial GET resolves, so we can distinguish first-load
   * from the "all tasks completed" empty state and show different copy in each case. */
  const [hasFetchedTasks, setHasFetchedTasks] = useState(false);
  /**
   * One-shot bottom feedback when starting/resuming with space.
   * It fades out on its own, then the regular idle/paused hint takes over again.
   */
  const [spaceFeedback, setSpaceFeedback] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const response = await fetch("http://localhost:3001/api/tasks");
        if (!response.ok) {
          throw new Error("Failed to fetch tasks");
        }

        const data: Task[] = await response.json();
        const initialCommitted = Object.fromEntries(
          data.map((t) => [t.id, t.category])
        );
        const initialOrder = uniqueCategoriesFromCommitted(initialCommitted);
        setCategoryOrder(initialOrder);
        setCommittedCategoryByTaskId(initialCommitted);
        setTasks(tasksWithClientColors(data, initialOrder));
        setCurrentIndex(0);
      } catch (error) {
        console.error(error);
      } finally {
        setHasFetchedTasks(true);
      }
    };

    fetchTasks();
  }, []);

  useEffect(() => {
    if (tasks.length === 0) {
      return;
    }

    setTimersByTaskId((prev) => {
      const next = { ...prev };
      for (const task of tasks) {
        if (next[task.id] === undefined) {
          next[task.id] = defaultTimerForTask(task);
        }
      }
      return next;
    });
  }, [tasks]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTimersByTaskId((prev) => {
        const runningEntry = Object.entries(prev).find(([, v]) => v.isRunning);
        if (!runningEntry) {
          return prev;
        }

        const taskId = Number(runningEntry[0]);
        const t = runningEntry[1];

        // The tick that lands on 0: stop the timer. The completion handoff is done by a
        // separate observer effect below — doing it here from inside the updater (or via
        // a closure variable read right after) is racy under React 18's auto-batching.
        if (t.remainingSeconds <= 1) {
          return {
            ...prev,
            [taskId]: {
              ...t,
              remainingSeconds: 0,
              isRunning: false,
            },
          };
        }

        return {
          ...prev,
          [taskId]: {
            ...t,
            remainingSeconds: t.remainingSeconds - 1,
          },
        };
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  /**
   * Completion observer. Whenever any task's timer is at zero AND is no longer running,
   * flag it as the completing task so the dissolve plays. Robust to React 18 batching:
   * by the time this effect runs, both `timersByTaskId` and `completingTaskId` are
   * committed, so we can't miss a transition.
   */
  useEffect(() => {
    if (completingTaskId !== null) {
      return;
    }
    for (const [idStr, t] of Object.entries(timersByTaskId)) {
      if (t.remainingSeconds === 0 && !t.isRunning) {
        setCompletingTaskId(Number(idStr));
        return;
      }
    }
  }, [timersByTaskId, completingTaskId]);

  /**
   * How long the dissolve plays end-to-end. The keyframes below split this duration into
   * three beats:
   *   1. rise:  currentTaskColor -> bright cream peak (with glow ramping up)
   *   2. hold:  sustain the cream peak + glow for a beat (the "shine" lingering)
   *   3. fade:  drop opacity to the same "done" level and ease the color back to the
   *             task's own color, glow off
   * Must match the `duration` on the dissolve transitions in the render below.
   */
  const COMPLETION_DISSOLVE_MS = 1200;
  /**
   * Tiny breath we hold the now-faded task in place after the dissolve finishes, before the
   * slide-out kicks in. Keeps the eye from jumping straight from "fading" into "sliding".
   */
  const COMPLETION_HOLD_MS = 120;

  useEffect(() => {
    if (completingTaskId === null) {
      return;
    }
    const finishedId = completingTaskId;

    const timeoutId = window.setTimeout(() => {
      // Fire-and-forget the persistence; UI removes the task either way so the server can
      // catch up at its own pace. If it fails, we just log — the worst case is the row
      // reappears on next page load with its original time, and the user can let it run again.
      void (async () => {
        try {
          const res = await fetch(`http://localhost:3001/api/tasks/${finishedId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ time: "done" }),
          });
          if (!res.ok) {
            console.error(`Failed to mark task ${finishedId} as done: ${res.status}`);
          }
        } catch (err) {
          console.error("Network error marking task as done:", err);
        }
      })();

      // Drop the finished task locally and clamp `currentIndex` to a still-valid slot so
      // AnimatePresence (keyed on task id) slides the next task into place.
      setTasks((prev) => {
        const next = prev.filter((t) => t.id !== finishedId);
        setCurrentIndex((idx) => (next.length === 0 ? 0 : Math.min(idx, next.length - 1)));
        return next;
      });
      setTimersByTaskId((prev) => {
        if (prev[finishedId] === undefined) {
          return prev;
        }
        const next = { ...prev };
        delete next[finishedId];
        return next;
      });
      setCommittedCategoryByTaskId((prev) => {
        if (prev[finishedId] === undefined) {
          return prev;
        }
        const next = { ...prev };
        delete next[finishedId];
        return next;
      });
      setDirection(1);
      setCompletingTaskId(null);
    }, COMPLETION_DISSOLVE_MS + COMPLETION_HOLD_MS);

    return () => window.clearTimeout(timeoutId);
  }, [completingTaskId]);

  useEffect(() => {
    const handleArrowNavigation = (event: KeyboardEvent) => {
      const { key } = event;
      if (
        key !== "ArrowRight" &&
        key !== "ArrowLeft" &&
        key !== "ArrowUp" &&
        key !== "ArrowDown"
      ) {
        return;
      }

      if (tasks.length === 0) {
        return;
      }

      // Lock out navigation/category cycling while the completion shine+pop is playing,
      // otherwise the user can swap the disappearing task's category mid-animation.
      if (completingTaskId !== null) {
        event.preventDefault();
        return;
      }

      if (key === "ArrowUp" || key === "ArrowDown") {
        const current = tasks[currentIndex];
        if (!current) {
          return;
        }
        // Source the cycle list from the committed (server) state, NOT from `tasks`. Otherwise,
        // local edits can collapse the local unique set (e.g. cycling the only `personal` task
        // to `demo` leaves `[demo, demo, demo]` locally) and lock the user out of cycling back.
        const availableCategories = uniqueCategoriesFromCommitted(committedCategoryByTaskId);
        const len = availableCategories.length;
        if (len < 2) {
          return;
        }
        const curIdx = availableCategories.indexOf(current.category);
        const safeIdx = curIdx === -1 ? 0 : curIdx;
        const isDown = key === "ArrowDown";
        const newIdx = isDown
          ? (safeIdx + 1) % len
          : (safeIdx - 1 + len) % len;
        const newCategory = availableCategories[newIdx];
        if (newCategory === current.category) {
          return;
        }

        event.preventDefault();
        categoryChangedByKeyRef.current = true;
        setCatDirection(isDown ? 1 : -1);
        const taskId = current.id;

        // Local-only update. The server commit is deferred until the user navigates with
        // Left/Right, so cycling demo -> personal -> demo with Up/Down never hits the API.
        setTasks((prev) =>
          tasksWithClientColors(
            prev.map((t) =>
              t.id === taskId ? { ...t, category: newCategory } : t
            ),
            categoryOrder
          )
        );
        return;
      }

      event.preventDefault();

      // Before navigating away, flush any pending category change for the task we're leaving.
      const leavingTask = tasks[currentIndex];
      if (leavingTask) {
        const previousCommitted = committedCategoryByTaskId[leavingTask.id];
        const desiredCategory = leavingTask.category;
        if (
          previousCommitted !== undefined &&
          previousCommitted !== desiredCategory
        ) {
          const taskId = leavingTask.id;
          void (async () => {
            try {
              const res = await fetch(`http://localhost:3001/api/tasks/${taskId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category: desiredCategory }),
              });
              if (!res.ok) {
                setTasks((prev) =>
                  tasksWithClientColors(
                    prev.map((t) =>
                      t.id === taskId ? { ...t, category: previousCommitted } : t
                    ),
                    categoryOrder
                  )
                );
                return;
              }
              setCommittedCategoryByTaskId((prev) => ({
                ...prev,
                [taskId]: desiredCategory,
              }));
            } catch {
              setTasks((prev) =>
                tasksWithClientColors(
                  prev.map((t) =>
                    t.id === taskId ? { ...t, category: previousCommitted } : t
                  ),
                  categoryOrder
                )
              );
            }
          })();
        }
      }

      if (key === "ArrowRight") {
        setDirection(1);
        setCurrentIndex((prev) => (prev + 1) % tasks.length);
      } else {
        setDirection(-1);
        setCurrentIndex((prev) => (prev - 1 + tasks.length) % tasks.length);
      }
    };

    window.addEventListener("keydown", handleArrowNavigation);

    return () => {
      window.removeEventListener("keydown", handleArrowNavigation);
    };
  }, [tasks, currentIndex, committedCategoryByTaskId, categoryOrder, completingTaskId]);

  useEffect(() => {
    const handleSpace = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }

      event.preventDefault();

      if (tasks.length === 0) {
        return;
      }

      // Don't let space restart/pause anything while we're playing the completion animation.
      if (completingTaskId !== null) {
        return;
      }

      const task = tasks[currentIndex];
      const taskId = task.id;
      const timerBeforeToggle = timersByTaskId[taskId] ?? defaultTimerForTask(task);
      const isStartingOrResuming = !timerBeforeToggle.isRunning;
      const isFirstStart = timerBeforeToggle.remainingSeconds >= timerBeforeToggle.animationBaseSeconds;

      setTimersByTaskId((prev) => {
        const current =
          prev[taskId] ?? defaultTimerForTask(task);

        // PAUSE: freeze infill exactly where it is — touch nothing except isRunning
        if (current.isRunning) {
          return {
            ...prev,
            [taskId]: {
              ...current,
              isRunning: false,
            },
          };
        }

        // RESUME / START: activate this task; reset other tasks' infill to 100%
        const next: Record<number, TaskTimer> = {};
        for (const [id, timer] of Object.entries(prev)) {
          const numId = Number(id);
          if (numId === taskId) {
            next[numId] = { ...timer, isRunning: true };
          } else {
            next[numId] = {
              ...timer,
              isRunning: false,
              animationBaseSeconds: Math.max(timer.remainingSeconds, 1),
            };
          }
        }

        return next;
      });

      if (isStartingOrResuming) {
        setSpaceFeedback({
          id: Date.now(),
          text: isFirstStart ? "started!" : "continuing",
        });
      }
    };

    window.addEventListener("keydown", handleSpace);

    return () => {
      window.removeEventListener("keydown", handleSpace);
    };
  }, [tasks, currentIndex, completingTaskId, timersByTaskId]);

  useEffect(() => {
    if (spaceFeedback === null) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setSpaceFeedback((prev) => (prev?.id === spaceFeedback.id ? null : prev));
    }, 2250);
    return () => window.clearTimeout(timeoutId);
  }, [spaceFeedback]);

  const currentTask = tasks[currentIndex];
  const currentTaskColor = currentTask?.color ?? "#EDEBD7";
  const isLongText = currentTask ? currentTask.text.length > 55 : false;

  const currentTimer =
    currentTask && timersByTaskId[currentTask.id] !== undefined
      ? timersByTaskId[currentTask.id]
      : currentTask
        ? defaultTimerForTask(currentTask)
        : null;

  const fillPercentage =
    currentTimer && currentTimer.animationBaseSeconds > 0
      ? (currentTimer.remainingSeconds / currentTimer.animationBaseSeconds) * 100
      : 100;

  const displayedTimeLabel = currentTimer
    ? formatRemainingAsMinutesLabel(currentTimer.remainingSeconds)
    : "";

  useEffect(() => {
    if (tasks.length === 0) {
      return;
    }

    setFadeCategoryOut(false);
    const timeoutId = window.setTimeout(() => {
      setFadeCategoryOut(true);
    }, 2500);

    return () => {
      window.clearTimeout(timeoutId);
    };
    categoryChangedByKeyRef.current = false;
  }, [currentIndex, tasks.length, currentTask?.category]);

  const isTimerActive = currentTimer ? currentTimer.isRunning || currentTimer.remainingSeconds < currentTimer.animationBaseSeconds : false;
  const isCurrentTaskCompleting = currentTask !== undefined && currentTask.id === completingTaskId;

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-mandu-bg text-mandu-white">

      {/* Full-screen color wipe — drains downward as time passes */}
      {tasks.length > 0 && isTimerActive && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-0"
          style={{
            height: `${Math.min(100, Math.max(0, 100 - fillPercentage))}%`,
            backgroundColor: "#EDEBD7",
            opacity: 0.08,
            // Freeze instantly on pause; keep smooth drip while running.
            transition: currentTimer?.isRunning ? "height 1s linear" : "none",
          }}
        />
      )}

      {/* Top right dumpling icon */}
      <button
        type="button"
        className="absolute top-6 right-8 z-30 inline-flex cursor-default select-none border-0 bg-transparent p-2 text-3xl leading-none opacity-40 transition-transform duration-200 ease-out will-change-transform focus:outline-none hover:scale-110 hover:opacity-100"
        aria-label="Profile"
      >
        🥟
      </button>

      {/* main is pointer-events-none so the hit area does not sit on top of the dumpling; content re-enables events */}
      <main className="pointer-events-none relative z-10 flex min-h-screen w-full items-center justify-center overflow-hidden">
        {tasks.length === 0 ? (
          <h1 className="pointer-events-auto px-0.5 text-center text-3xl font-thin tracking-tight sm:px-1 md:px-1.5 md:text-5xl">
            {hasFetchedTasks ? "you're done for today" : "Loading universe..."}
          </h1>
        ) : (
          <div className="flex w-full max-w-[min(100%,min(90rem,98svw))] flex-col items-center px-0.5 pointer-events-auto sm:px-1 md:px-1.5">
            <div className="mb-2 w-full self-end overflow-hidden text-right text-sm font-thin uppercase tracking-widest">
              <motion.div
                layout={false}
                initial={{ opacity: 0 }}
                animate={{ opacity: fadeCategoryOut ? 0 : 1 }}
                transition={{
                  opacity: {
                    delay: fadeCategoryOut ? 0 : (categoryChangedByKeyRef.current ? 0 : 0.75),
                    duration: fadeCategoryOut ? 1 : 0.2,
                    ease: fadeCategoryOut ? "easeInOut" : "easeOut",
                  },
                }}
              >
                <AnimatePresence custom={catDirection} mode="popLayout">
                  <motion.span
                    key={currentTask.category}
                    custom={catDirection}
                    variants={categoryVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    className="inline-block"
                    style={{ color: currentTaskColor }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                  >
                    {currentTask.category}
                  </motion.span>
                </AnimatePresence>
              </motion.div>
            </div>
            <AnimatePresence custom={direction} mode="popLayout">
              <motion.div
                /*
                 * Keying on `currentTask.id` (not `currentIndex`) means that when a finished
                 * task is removed and the next task slides into the same index, the key
                 * still changes — so AnimatePresence runs an exit + enter and gives us the
                 * slide transition we want. Keying on the index would be a no-op in that
                 * case and the new task would just teleport in.
                 */
                key={currentTask.id}
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "spring", stiffness: 150, damping: 38, mass: 1.1 }}
                className="w-full"
              >
                <div
                  className={`w-full text-center leading-tight ${
                    isLongText ? "text-3xl md:text-5xl" : "text-4xl md:text-6xl"
                  }`}
                >
                  {/*
                   * Timer / "done" label. Cross-faded via AnimatePresence so "X sec"
                   * smoothly transforms into "done" instead of snapping. The key only
                   * changes when entering/leaving the completing state — during normal
                   * ticking the displayedTimeLabel updates inside the same span without
                   * a remount, so we don't get a fade on every second tick.
                   */}
                  <span className="mr-4 font-thin md:mr-6" style={{ display: "inline" }}>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={isCurrentTaskCompleting ? "done" : "ticking"}
                        style={{ color: currentTaskColor, display: "inline" }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: isCurrentTaskCompleting ? 0.3 : 0.7 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25, ease: "easeInOut" }}
                      >
                        {isCurrentTaskCompleting ? "done" : displayedTimeLabel}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  {/*
                   * Task text — stays in place. Three things animate over the dissolve in
                   * a 4-keyframe rise/hold/fade sequence (times: [0, 0.35, 0.55, 1]):
                   *   - color:     currentTaskColor -> #F5EDD8 -> #F5EDD8 -> currentTaskColor
                   *                (rises to cream, holds at peak, eases back to original)
                   *   - opacity:   1 -> 1 -> 1 -> 0.3
                   *                (fully visible through the shine, then drops to match
                   *                 the "done" label's faded level)
                   *   - textShadow: 0 -> peak glow -> peak glow -> 0
                   *                 (cream halo lingers through the hold, then fades out)
                   * No scale, no x/y, no letter-spacing — the text doesn't move.
                   */}
                  <motion.span
                    className="break-words font-black"
                    style={{ color: currentTaskColor, display: "inline" }}
                    animate={
                      isCurrentTaskCompleting
                        ? {
                            color: [
                              currentTaskColor,
                              "#F5EDD8",
                              "#F5EDD8",
                              currentTaskColor,
                            ],
                            opacity: [1, 1, 1, 0.3],
                            textShadow: [
                              "0 0 0px rgba(245,237,216,0)",
                              "0 0 18px rgba(245,237,216,0.55)",
                              "0 0 18px rgba(245,237,216,0.55)",
                              "0 0 0px rgba(245,237,216,0)",
                            ],
                          }
                        : {
                            color: currentTaskColor,
                            opacity: 1,
                            textShadow: "0 0 0px rgba(245,237,216,0)",
                          }
                    }
                    transition={{
                      duration: isCurrentTaskCompleting
                        ? COMPLETION_DISSOLVE_MS / 1000
                        : 0.2,
                      times: isCurrentTaskCompleting ? [0, 0.35, 0.85, 1] : undefined,
                      ease: "easeInOut",
                    }}
                  >
                    {currentTask.text}
                  </motion.span>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* Looping status hint: "press ⎵ to start" (idle) / "paused" (paused).
          Hidden during the completion dissolve, the moment the timer hits zero,
          while the timer is running, and while the one-shot space feedback is on screen. */}
      {!isCurrentTaskCompleting
        && tasks.length > 0
        && spaceFeedback === null
        && currentTimer?.isRunning !== true
        && currentTimer?.remainingSeconds !== 0 && (
        <motion.div
          key={`status-hint-${isTimerActive ? "paused" : "idle"}`}
          className="absolute bottom-12 left-1/2 z-30 -translate-x-1/2 select-none text-lg font-thin tracking-wide text-mandu-white/80"
          initial={{ opacity: 0.25 }}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{
            duration: isTimerActive ? 2.2 : 3.1,
            ease: "easeInOut",
            repeat: Infinity,
            repeatType: "loop",
          }}
        >
          {isTimerActive ? "paused" : "press ⎵ to start"}
        </motion.div>
      )}

      {/* One-shot start/resume feedback ("started!" / "continuing") with a clean exit fade. */}
      <AnimatePresence>
        {!isCurrentTaskCompleting && tasks.length > 0 && spaceFeedback && (
          <motion.div
            key={`space-feedback-${spaceFeedback.id}`}
            className="absolute bottom-12 left-1/2 z-30 -translate-x-1/2 select-none text-lg font-thin tracking-wide text-mandu-white/80"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2.1, ease: "easeInOut", times: [0, 0.35, 1] }}
          >
            {spaceFeedback.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Index;
