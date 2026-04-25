import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useTime,
  useTransform,
  type AnimationPlaybackControls,
  type MotionValue,
} from "framer-motion";

type Task = {
  id: number;
  category: string;
  /** Original duration ("1 min", "10 sec", ...). On a fresh task the wipe is sized
   *  against this; on a reload-from-`current_time` the wipe is re-sized against the
   *  remaining seconds so it always starts from the top (see `persistedTimerForTask`). */
  time: string;
  /** Server-persisted remaining time. On natural completion this resets to `time` (the
   *  original) so the next reload starts fresh. On pause / navigation / tab hide we save
   *  the running task's remaining seconds here. */
  current_time: string;
  text: string;
  color: string;
};

type TaskTimer = {
  /**
   * Discrete display value, updated once per second for the visible "X sec" / "X min"
   * label. NOT the source of truth for the wipe — see the run-start timestamps below.
   * When paused, this is also the snapshot we resume from.
   */
  remainingSeconds: number;
  /** Total duration the wipe is scaled against (full screen = 100% of this). */
  animationBaseSeconds: number;
  isRunning: boolean;
  /**
   * Time-based source of truth for the wipe and for "what's *really* left right now".
   * `runStartedAt` is `performance.now()` at the moment the timer last toggled to
   * running; `remainingAtRunStart` is what `remainingSeconds` was at that instant.
   * Both are NULL while paused. The wipe RAF reads these every frame so the visible
   * fill is always exact — no waiting for the next interval tick, no per-tick
   * `animate(...)` chaining, no rate variance after pause/resume.
   */
  runStartedAt: number | null;
  remainingAtRunStart: number | null;
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
    runStartedAt: null,
    remainingAtRunStart: null,
  };
}

/**
 * Timer state to use whenever we're loading a task from the server (initial fetch,
 * pre-init render fallbacks). `remainingSeconds` reads from the server-persisted
 * `current_time`, falling back to the original `time` when nothing has been saved yet.
 *
 * `animationBaseSeconds` is pinned to `remainingSeconds`, NOT to the original `time`.
 * That way a reload starts the wipe FROM THE TOP — invisible at first, then drains
 * over the remaining seconds as the user runs the task. (If we used the original
 * time as the base, a half-done task would come back with the wipe already half-way
 * down the screen, which the user explicitly didn't want.)
 */
function persistedTimerForTask(task: Task): TaskTimer {
  const remainingStr =
    typeof task.current_time === "string" && task.current_time.trim()
      ? task.current_time
      : task.time;
  const remainingSeconds = parseTimeToSeconds(remainingStr);
  return {
    remainingSeconds,
    animationBaseSeconds: Math.max(remainingSeconds, 1),
    isRunning: false,
    runStartedAt: null,
    remainingAtRunStart: null,
  };
}

/**
 * Live remaining seconds for a timer — the *real* number, accurate to the millisecond.
 *
 * When paused: just returns the snapshotted `remainingSeconds`.
 * When running: returns `remainingAtRunStart - elapsed`, where `elapsed` is wall-clock
 * time since the last play press. This is what every continuous visual (the wipe) and
 * every persistence call should read; `timer.remainingSeconds` is only refreshed once
 * per interval tick (it'd otherwise lag the actual time by up to a second).
 */
function liveRemaining(t: TaskTimer): number {
  if (
    !t.isRunning ||
    t.runStartedAt === null ||
    t.remainingAtRunStart === null
  ) {
    return Math.max(0, t.remainingSeconds);
  }
  const elapsed = (performance.now() - t.runStartedAt) / 1000;
  return Math.max(0, t.remainingAtRunStart - elapsed);
}

/**
 * Fire-and-forget PUT to write the current remaining-time back to the database. Format
 * matches what `parseTimeToSeconds` understands ("X sec"). Failures are swallowed —
 * losing one save is fine; the next pause / navigation / visibilitychange will retry.
 */
function persistCurrentTimeSeconds(taskId: number, seconds: number): void {
  const value = `${Math.max(0, Math.floor(seconds))} sec`;
  void fetch(`http://localhost:3001/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_time: value }),
  }).catch(() => {});
}

/**
 * Persist a verbatim `current_time` string (e.g. the original `task.time` when resetting
 * after a natural completion). Useful when we want the DB to mirror a friendly "1 min"
 * label rather than "60 sec".
 */
function persistCurrentTimeRaw(taskId: number, value: string): void {
  void fetch(`http://localhost:3001/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_time: value }),
  }).catch(() => {});
}

/**
 * Pretty-print the time remaining. Above a minute we report whole minutes (ceil), so the
 * label jumps only when a minute boundary is crossed. Under a minute we count seconds —
 * useful for short timers and for the final countdown of any longer timer.
 */
function formatRemainingAsMinutesLabel(remainingSeconds: number): string {
  // CEIL, not floor: the label says "what's still left, rounded up". A timer that
  // just started with 10 s should show "10 sec" until live actually drops below
  // 10 (i.e. for the first full second), THEN "9 sec", and so on. With `floor`
  // any sub-second progress would prematurely tick the label down.
  const whole = Math.max(0, Math.ceil(remainingSeconds));
  if (whole < 60) {
    return `${whole} sec`;
  }
  const minutes = Math.ceil(whole / 60);
  return `${minutes} min`;
}

/**
 * Shake amplitude as a function of hold progress (0..1). Curve is `p^1.6` so the shake
 * is barely perceptible at the start of the hold and ramps up sharply near the top.
 * Centralised here so both the (no-longer-used) word-level approach and the per-letter
 * `ShakingLetter` below agree on the easing.
 */
const shakeAmp = (p: number) =>
  Math.pow(Math.max(0, Math.min(1, p)), 1.6);

type ShakingLetterProps = {
  char: string;
  /** 0-based index in the FULL task text (not within a word) — used to phase-offset
   *  this letter's oscillations from its neighbours so the whole word doesn't move in
   *  unison. */
  letterIndex: number;
  time: MotionValue<number>;
  /** 0..1 amplitude scalar. Driven by hold progress while pressing and faded to 0
   *  shortly after release, independent of the drain animation on the fill itself. */
  shakeIntensityMv: MotionValue<number>;
  taskColor: string;
  isCompleting: boolean;
  completionDurationMs: number;
};

/**
 * One letter of the task text, with its own independent jitter driven by motion values
 * shared at the parent level (`time`, `shakeIntensityMv`). Each letter's phase is
 * offset by `letterIndex * 137` (a golden-ratio-ish multiplier) so adjacent letters
 * never line up — the result reads as chaotic per-letter buzzing rather than a single
 * rigid wave.
 *
 * Color/opacity/textShadow during the completion dissolve are set by the parent
 * `motion.span`; CSS inheritance carries them onto every letter automatically.
 */
const ShakingLetter = ({
  char,
  letterIndex,
  time,
  shakeIntensityMv,
}: ShakingLetterProps) => {
  const phase = letterIndex * 137;

  const x = useTransform([time, shakeIntensityMv], (latest) => {
    const [t, p] = latest as [number, number];
    return (
      (Math.sin((t + phase) / 13) + Math.sin((t + phase * 2) / 7) * 0.45) *
      shakeAmp(p) *
      6
    );
  });
  const y = useTransform([time, shakeIntensityMv], (latest) => {
    const [t, p] = latest as [number, number];
    return (
      (Math.cos((t + phase * 1.3) / 15) +
        Math.cos((t + phase * 2.1) / 9) * 0.45) *
      shakeAmp(p) *
      5
    );
  });
  const rotate = useTransform([time, shakeIntensityMv], (latest) => {
    const [t, p] = latest as [number, number];
    return Math.sin((t + phase * 0.7) / 21) * shakeAmp(p) * 3;
  });

  return (
    <motion.span
      style={{
        display: "inline-block",
        x,
        y,
        rotate,
      }}
    >
      {char}
    </motion.span>
  );
};

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
  /**
   * Long-press "force complete" state machine. Four phases:
   *
   *   1. CHARGING — gradient fades IN over the existing timer wipe (same area:
   *      top → wipe-bottom). The wipe LOOKS like it's transforming into the
   *      gradient; the underlying grey wipe is still there, just covered as
   *      `holdOpacityMv` ramps 0 → 1. Letters start buzzing (shake step 1).
   *   2. WIPING  — gradient bleeds BELOW the wipe; `holdExtraMv` accelerates
   *      gently while held. The fill's bottom descends faster than the natural
   *      wipe. Letters intensify (shake step 2).
   *   3. DRAINING — on release, `holdExtraMv` tweens back to 0 (no bounce) so
   *      the bright bottom edge meets the real wipe line again.
   *   4. FADING  — gradient fades OUT (`holdOpacityMv` 1 → 0) revealing the
   *      regular grey wipe underneath.
   *
   * Throughout, height is always `wipeBottomMv + holdExtraMv` so the fill stays
   * glued to the wipe in real time (charging/fading: `holdExtraMv = 0`, draining:
   * shrinking to 0, wiping: growing).
   */
  const holdStateRef = useRef<
    "idle" | "charging" | "wiping" | "draining" | "fading"
  >("idle");
  const holdTimeoutRef = useRef<number | null>(null);
  const holdRafRef = useRef<number | null>(null);
  const isPressingRef = useRef(false);
  const wipingLastTickRef = useRef(0);
  const wipingPhaseStartRef = useRef(0);
  /**
   * Mirror of every state value the keyboard handlers need to read but should NOT cause
   * the listener effect to re-run when they change. The handler effect runs once on mount
   * and reads from these refs at event time.
   */
  const tasksRef = useRef(tasks);
  const currentIndexRef = useRef(currentIndex);
  const timersByTaskIdRef = useRef(timersByTaskId);
  const completingTaskIdRef = useRef(completingTaskId);
  /**
   * How the current completion was triggered — drives the timer label during the
   * dissolve and whether we POST `time: "done"`. Long-press / force = persist;
   * natural time expiry = same golden animation, but "0 sec" and no DB change.
   */
  const completionKindRef = useRef<"forced" | "natural" | null>(null);

  useEffect(() => {
    tasksRef.current = tasks;
    currentIndexRef.current = currentIndex;
    timersByTaskIdRef.current = timersByTaskId;
    completingTaskIdRef.current = completingTaskId;
  });

  const time = useTime();

  /**
   * Current visible wipe bottom, in viewport % from the top. Driven directly from
   * `liveRemaining()` of the active task on every animation frame (see the RAF
   * effect further down) — no per-tick `animate(target, 1s)` chains, no lag.
   * Used by both the wipe element AND the long-press fill's top so they line up
   * to the pixel.
   */
  const wipeBottomMv = useMotionValue(0);

  /**
   * Extra descent below the wipe, in viewport %. Stays at 0 during charging/fading
   * (fill just overlays the wipe), grows during wiping (fill dips below the wipe),
   * springs back to 0 during draining. Total visible fill height = `wipeBottomMv +
   * holdExtraMv`, clamped to 100.
   */
  const holdExtraMv = useMotionValue(0);
  const holdDrainAnimRef = useRef<AnimationPlaybackControls | null>(null);

  /**
   * Long-press fill opacity. 0 idle, 0→1 during charging, 1 during wiping/draining,
   * 1→0 during fading. Drives the gradient's "dissolve in / dissolve out" so the
   * grey wipe behind it can show through at the start and end.
   */
  const holdOpacityMv = useMotionValue(0);
  const chargeOpacityAnimRef = useRef<AnimationPlaybackControls | null>(null);
  const fadeOutAnimRef = useRef<AnimationPlaybackControls | null>(null);

  /**
   * Shake intensity for `ShakingLetter`. Two-step ramp: 0 → ~0.4 during charging
   * (gentle buzz), then 0.4 → 1.0 during wiping (peaks as the fill nears the
   * bottom). On release a quick fade brings it back to 0.
   */
  const shakeIntensityMv = useMotionValue(0);
  const chargeShakeAnimRef = useRef<AnimationPlaybackControls | null>(null);
  const shakeFadeAnimRef = useRef<AnimationPlaybackControls | null>(null);

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
          // First time we see this task: hydrate from the server-persisted `current_time`
          // (so reloads pick up where the user left off). Already-initialised tasks are
          // left alone so their live ticking state doesn't get clobbered.
          next[task.id] = persistedTimerForTask(task);
        }
      }
      return next;
    });
  }, [tasks]);

  /**
   * Discrete label tick. Polls 4× per second so the visible "X sec" / "X min" label
   * crosses second-boundaries within ~250 ms of when it should — without spamming
   * React with re-renders (we only commit when `ceil(live)` actually changed). The
   * wipe is NOT driven from here; it's RAF-time-based (see below).
   *
   * Auto-pause: as soon as a task's live remaining hits zero, drop `isRunning` and
   * clear the run timestamps on the same tick. The completion observer takes it
   * from there. No more "1-second buffer" effect — the wipe is always exact, so
   * there's nothing left to wait for.
   */
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTimersByTaskId((prev) => {
        let changed = false;
        let next: Record<number, TaskTimer> | null = null;
        for (const [idStr, t] of Object.entries(prev)) {
          if (!t.isRunning) {
            continue;
          }
          const live = liveRemaining(t);
          if (live <= 0) {
            if (!next) next = { ...prev };
            next[Number(idStr)] = {
              ...t,
              remainingSeconds: 0,
              isRunning: false,
              runStartedAt: null,
              remainingAtRunStart: null,
            };
            changed = true;
            continue;
          }
          // The label is `ceil(remainingSeconds)`, so a re-render is only
          // worthwhile when `ceil(live)` actually crossed an integer boundary.
          const ceiledLive = Math.ceil(live);
          const ceiledCur = Math.ceil(t.remainingSeconds);
          if (ceiledLive !== ceiledCur) {
            if (!next) next = { ...prev };
            next[Number(idStr)] = { ...t, remainingSeconds: live };
            changed = true;
          }
        }
        return changed && next ? next : prev;
      });
    }, 250);

    return () => window.clearInterval(intervalId);
  }, []);

  /**
   * Completion observer. Whenever any task's timer is at zero AND is no longer running,
   * flag it as the completing task so the dissolve plays. We hold for `COMPLETION_PRE_DELAY_MS`
   * first so the user gets a tiny "breath" on the normal screen with the timer at 0 and
   * the task text in its regular state, before the dissolve animation starts.
   */
  useEffect(() => {
    if (completingTaskId !== null) {
      return;
    }
    let toFinishId: number | null = null;
    for (const [idStr, t] of Object.entries(timersByTaskId)) {
      if (t.remainingSeconds === 0 && !t.isRunning) {
        toFinishId = Number(idStr);
        break;
      }
    }
    if (toFinishId === null) {
      return;
    }
    const pendingId = toFinishId;
    const timeoutId = window.setTimeout(() => {
      completionKindRef.current = "natural";
      setCompletingTaskId(pendingId);
    }, COMPLETION_PRE_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [timersByTaskId, completingTaskId]);

  /**
   * Pre-completion breath. After the timer hits 0 we sit on the normal screen
   * (timer label = 0:00, task text fully visible, no glow) for this long before
   * triggering the dissolve. Lets the eye register "I'm done" before the
   * animation starts, instead of cutting straight from running to fading.
   */
  const COMPLETION_PRE_DELAY_MS = 360;
  /**
   * How long the dissolve plays end-to-end. The keyframes below split this duration into
   * three beats:
   *   1. rise:  currentTaskColor -> bright cream peak (with glow ramping up)
   *   2. hold:  sustain the cream peak + glow for a beat (the "shine" lingering)
   *   3. fade:  drop opacity to the same "done" level and ease the color back to the
   *             task's own color, glow off
   * Must match the `duration` on the dissolve transitions in the render below.
   */
  const COMPLETION_DISSOLVE_MS = 1700;
  /**
   * Tiny breath we hold the now-faded task in place after the dissolve finishes, before the
   * slide-out kicks in. Keeps the eye from jumping straight from "fading" into "sliding".
   */
  const COMPLETION_HOLD_MS = 120;
  /**
   * Long-press tuning. Two-phase visual: first the gradient FADES IN over the
   * existing wipe area (charging), then the fill bottom DESCENDS faster than the
   * underlying wipe (wiping). On release the bar drains AND fades simultaneously
   * (with a small offset) so the retreat and dissolve read as one motion.
   *
   *   - THRESHOLD                  : delay before any visual; shorter taps = play/pause.
   *   - CHARGE_DURATION_MS         : opacity fade-in over the wipe (step 1 of shake).
   *   - SHAKE_PHASE1_TARGET        : shake intensity at the end of charging.
   *   - WIPING_BASE_PCT_PER_SEC    : descent speed at t=0 of the wiping phase.
   *   - WIPING_ACCEL_PCT_PER_SEC2  : LINEAR acceleration. Velocity grows at a
   *                                  constant rate (`v(t) = base + accel·t`), so
   *                                  the speed-up is smooth and continuous — no
   *                                  abrupt jolt at the start.
   *   - DRAIN_DURATION_S           : tween (no spring) so the collapse has no
   *                                  overshoot / extra bounce.
   *   - RELEASE_FADE_DURATION_S    : duration of the gradient opacity dissolve on
   *                                  release. Starts STRICTLY AFTER the drain ends
   *                                  so the gradient never fades while still below
   *                                  the wipe edge (otherwise the grey wipe would
   *                                  peek through prematurely).
   *   - SHAKE_FADE_MS              : per-letter shake fade on release.
   */
  const LONG_PRESS_THRESHOLD_MS = 220;
  const CHARGE_DURATION_MS = 600;
  const SHAKE_PHASE1_TARGET = 0.4;
  const WIPING_BASE_PCT_PER_SEC = 25;
  const WIPING_ACCEL_PCT_PER_SEC2 = 20;
  const DRAIN_DURATION_S = 0.62;
  /**
   * Cubic-bezier ease-in with mild inertia at the head — velocity starts low
   * (the bar still has a hint of "mass" before falling) and accelerates
   * smoothly. Less aggressive than a strong ease-in so the speed-up reads as
   * natural, not as a sudden snap.
   */
  const DRAIN_EASE: [number, number, number, number] = [0.42, 0, 0.72, 0.46];
  const RELEASE_FADE_DURATION_S = 0.32;
  const SHAKE_FADE_MS = 260;

  useEffect(() => {
    if (completingTaskId === null) {
      return;
    }
    const finishedId = completingTaskId;
    const kindAtTrigger = completionKindRef.current;

    const timeoutId = window.setTimeout(() => {
      if (kindAtTrigger === "natural") {
        // Natural expiry: keep the task in the list (same position, same category)
        // but reset its timer to the initial "X min/sec" — so the next time the
        // user comes back to it (Left arrow) it's a fresh run, not stuck at 0.
        // Persist `current_time = task.time` so a reload also starts fresh.
        // After the dissolve we slide to the NEXT task (the user explicitly
        // doesn't want to remain on the just-finished task).
        const tasksNow = tasksRef.current;
        const finishedTask = tasksNow.find((t) => t.id === finishedId);
        if (finishedTask) {
          setTimersByTaskId((prev) => ({
            ...prev,
            [finishedId]: defaultTimerForTask(finishedTask),
          }));
          // Mirror the local reset on the server using the friendly original label
          // (e.g. "1 min" rather than "60 sec").
          persistCurrentTimeRaw(finishedId, finishedTask.time);
        }
        completionKindRef.current = null;
        setCompletingTaskId(null);

        // Slide forward to the next task in the cycle. With >1 task this triggers
        // the AnimatePresence exit/enter (key changes via currentTask.id). With a
        // single task there's nowhere to go — we just stay put.
        if (tasksNow.length > 1) {
          setDirection(1);
          setCurrentIndex((idx) => (idx + 1) % tasksNow.length);
        }
        return;
      }

      // Forced (long-press) completion: persist `done`, drop locally, slide on.
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
      completionKindRef.current = null;

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

      // Snapshot the remaining time of any running task before we switch away.
      // The task keeps ticking silently (we don't pause it), but a save now means
      // a reload while we're elsewhere still gets reasonably-fresh state. Read
      // via ref so we always see the latest tick, not a render-stale closure.
      for (const [idStr, t] of Object.entries(timersByTaskIdRef.current)) {
        if (t.isRunning) {
          persistCurrentTimeSeconds(Number(idStr), liveRemaining(t));
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
    const cancelHoldRaf = () => {
      if (holdRafRef.current !== null) {
        cancelAnimationFrame(holdRafRef.current);
        holdRafRef.current = null;
      }
    };
    const cancelHoldTimeout = () => {
      if (holdTimeoutRef.current !== null) {
        window.clearTimeout(holdTimeoutRef.current);
        holdTimeoutRef.current = null;
      }
    };
    const cancelChargeOpacityAnim = () => {
      if (chargeOpacityAnimRef.current !== null) {
        chargeOpacityAnimRef.current.stop();
        chargeOpacityAnimRef.current = null;
      }
    };
    const cancelChargeShakeAnim = () => {
      if (chargeShakeAnimRef.current !== null) {
        chargeShakeAnimRef.current.stop();
        chargeShakeAnimRef.current = null;
      }
    };
    const cancelFadeOutAnim = () => {
      if (fadeOutAnimRef.current !== null) {
        fadeOutAnimRef.current.stop();
        fadeOutAnimRef.current = null;
      }
    };
    const cancelDrainAnim = () => {
      if (holdDrainAnimRef.current !== null) {
        holdDrainAnimRef.current.stop();
        holdDrainAnimRef.current = null;
      }
    };
    const cancelShakeFade = () => {
      if (shakeFadeAnimRef.current !== null) {
        shakeFadeAnimRef.current.stop();
        shakeFadeAnimRef.current = null;
      }
    };
    const startShakeFade = () => {
      cancelShakeFade();
      const from = shakeIntensityMv.get();
      if (from <= 0) {
        return;
      }
      shakeFadeAnimRef.current = animate(from, 0, {
        duration: SHAKE_FADE_MS / 1000,
        ease: "easeOut",
        onUpdate: (v) => shakeIntensityMv.set(v),
        onComplete: () => {
          shakeIntensityMv.set(0);
          shakeFadeAnimRef.current = null;
        },
      });
    };

    const togglePlayPause = () => {
      const tasksNow = tasksRef.current;
      const idxNow = currentIndexRef.current;
      const completingNow = completingTaskIdRef.current;
      const timersNow = timersByTaskIdRef.current;
      if (tasksNow.length === 0 || completingNow !== null) {
        return;
      }
      const task = tasksNow[idxNow];
      if (!task) {
        return;
      }
      const taskId = task.id;
      const timerBeforeToggle = timersNow[taskId] ?? persistedTimerForTask(task);
      const isStartingOrResuming = !timerBeforeToggle.isRunning;
      const isFirstStart =
        timerBeforeToggle.remainingSeconds >= timerBeforeToggle.animationBaseSeconds;

      setTimersByTaskId((prev) => {
        const current = prev[taskId] ?? persistedTimerForTask(task);
        // PAUSE: snapshot the LIVE remaining (sub-second accurate) into the discrete
        // field, drop the run timestamps. Persist while we're at it.
        if (current.isRunning) {
          const live = liveRemaining(current);
          persistCurrentTimeSeconds(taskId, live);
          return {
            ...prev,
            [taskId]: {
              ...current,
              isRunning: false,
              remainingSeconds: live,
              runStartedAt: null,
              remainingAtRunStart: null,
            },
          };
        }
        // RESUME / START: activate this task; reset other tasks' infill to 100%.
        // For the activated task we capture `performance.now()` and the value we're
        // resuming from — those two together are the time-based source of truth for
        // the wipe. Other tasks have their run timestamps cleared (they're paused).
        const startNow = performance.now();
        const next: Record<number, TaskTimer> = {};
        for (const [id, timer] of Object.entries(prev)) {
          const numId = Number(id);
          if (numId === taskId) {
            next[numId] = {
              ...timer,
              isRunning: true,
              runStartedAt: startNow,
              remainingAtRunStart: timer.remainingSeconds,
            };
          } else {
            next[numId] = {
              ...timer,
              isRunning: false,
              animationBaseSeconds: Math.max(timer.remainingSeconds, 1),
              runStartedAt: null,
              remainingAtRunStart: null,
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

    const forceCompleteCurrentTask = () => {
      const tasksNow = tasksRef.current;
      const idxNow = currentIndexRef.current;
      const completingNow = completingTaskIdRef.current;
      if (tasksNow.length === 0 || completingNow !== null) {
        return;
      }
      const task = tasksNow[idxNow];
      if (!task) {
        return;
      }
      // Stop the timer + force `remainingSeconds` to 0. That second part is what
      // makes the wipe drop to 100% (fully covering the screen) underneath the
      // long-press gradient — so when the gradient fades out during the "done"
      // dissolve, the user sees a fully-grey screen instead of the half-wiped
      // mid-screen line they were complaining about.
      // The label still reads "done" (not "0 sec") because `completionTimerLabel`
      // overrides whatever `remainingSeconds` would format to during completion.
      setTimersByTaskId((prev) => {
        const t = prev[task.id];
        if (!t) {
          return prev;
        }
        return {
          ...prev,
          [task.id]: {
            ...t,
            isRunning: false,
            remainingSeconds: 0,
            runStartedAt: null,
            remainingAtRunStart: null,
          },
        };
      });
      completionKindRef.current = "forced";
      setCompletingTaskId(task.id);
    };

    /**
     * Phase 1: charging. The gradient fades IN over the existing wipe area —
     * `holdExtraMv` stays at 0 (no descent below the wipe yet) so the fill height
     * exactly tracks `wipeBottomMv`. Visually the wipe "transforms" into the
     * gradient as opacity ramps to 1. Letters begin buzzing (shake step 1).
     *
     * On completion of the opacity ramp we automatically advance to wiping. If the
     * user releases mid-charge we go straight to fading (skip drain, since
     * `holdExtraMv` is already 0).
     */
    const enterCharging = () => {
      cancelDrainAnim();
      cancelFadeOutAnim();
      cancelChargeOpacityAnim();
      cancelChargeShakeAnim();
      cancelShakeFade();
      cancelHoldRaf();

      holdStateRef.current = "charging";
      // No extra descent during charging — fill clings to the wipe.
      holdExtraMv.set(0);

      const fromOpacity = holdOpacityMv.get();
      const remainingMs = Math.max(0, (1 - fromOpacity) * CHARGE_DURATION_MS);
      const fromShake = shakeIntensityMv.get();

      if (remainingMs <= 0) {
        // Already fully opaque (e.g. mid-fade re-press). Skip charging.
        holdOpacityMv.set(1);
        if (fromShake < SHAKE_PHASE1_TARGET) {
          shakeIntensityMv.set(SHAKE_PHASE1_TARGET);
        }
        enterWiping();
        return;
      }

      chargeOpacityAnimRef.current = animate(holdOpacityMv, 1, {
        duration: remainingMs / 1000,
        ease: "easeOut",
        onComplete: () => {
          chargeOpacityAnimRef.current = null;
          if (holdStateRef.current === "charging") {
            enterWiping();
          }
        },
      });

      // Shake step 1 — gentle buzz that lands at SHAKE_PHASE1_TARGET right when
      // the charge completes (so step 2 picks up seamlessly).
      const shakeTarget = Math.max(fromShake, SHAKE_PHASE1_TARGET);
      chargeShakeAnimRef.current = animate(shakeIntensityMv, shakeTarget, {
        duration: remainingMs / 1000,
        ease: "easeOut",
        onComplete: () => {
          chargeShakeAnimRef.current = null;
        },
      });
    };

    /**
     * Phase 2: wiping. Once charged, `holdExtraMv` grows under a constant LINEAR
     * acceleration: `velocity(t) = base + accel·t`. da/dt is constant so the
     * speed-up is smooth and continuous — no abrupt jolt at any instant. When
     * `wipeBottomMv + holdExtraMv` reaches 100 %, trigger completion.
     *
     * Letters intensify here — shake step 2, ramping from `SHAKE_PHASE1_TARGET`
     * up to 1.0 as the fill nears the bottom of the screen.
     */
    const enterWiping = () => {
      if (completingTaskIdRef.current !== null) {
        return;
      }
      holdStateRef.current = "wiping";
      holdOpacityMv.set(1);
      const now0 = performance.now();
      wipingLastTickRef.current = now0;
      wipingPhaseStartRef.current = now0;

      const tick = () => {
        if (holdStateRef.current !== "wiping") {
          return;
        }
        const now = performance.now();
        const dt = (now - wipingLastTickRef.current) / 1000;
        wipingLastTickRef.current = now;

        const tSec = (now - wipingPhaseStartRef.current) / 1000;
        const rate =
          WIPING_BASE_PCT_PER_SEC + WIPING_ACCEL_PCT_PER_SEC2 * tSec;
        const nextExtra = holdExtraMv.get() + rate * dt;
        holdExtraMv.set(nextExtra);

        const fillBottom = wipeBottomMv.get() + nextExtra;
        // Shake step 2 — interpolate from SHAKE_PHASE1_TARGET to 1.0 based on
        // how close the fill bottom is to the screen bottom.
        const phase2Progress = Math.max(
          0,
          Math.min(1, fillBottom / 100)
        );
        shakeIntensityMv.set(
          SHAKE_PHASE1_TARGET + phase2Progress * (1 - SHAKE_PHASE1_TARGET)
        );

        if (fillBottom >= 100) {
          holdStateRef.current = "idle";
          holdExtraMv.set(0);
          holdOpacityMv.set(0);
          shakeIntensityMv.set(0);
          forceCompleteCurrentTask();
          return;
        }
        holdRafRef.current = requestAnimationFrame(tick);
      };
      holdRafRef.current = requestAnimationFrame(tick);
    };

    /**
     * Release path. Strictly SEQUENTIAL: drain first (extra → 0, fully glued to
     * the wipe edge), only then fade (opacity → 0). Overlapping the two would
     * let the underlying grey wipe peek through the gradient while the bottom
     * edge is still below the wipe line — visually wrong.
     *
     * If the user releases during charging (`holdExtraMv` is still ~0) we skip
     * the drain entirely and just fade out.
     *
     * Runs in parallel with a per-letter shake fade.
     */
    const startReleaseSequence = () => {
      const state = holdStateRef.current;
      if (state === "idle" || state === "draining" || state === "fading") {
        return;
      }
      cancelHoldRaf();
      cancelChargeOpacityAnim();
      cancelChargeShakeAnim();
      cancelDrainAnim();
      cancelFadeOutAnim();
      startShakeFade();

      const extra = holdExtraMv.get();
      if (extra <= 0.05) {
        // Released during charging — no descent below wipe yet, just fade.
        enterFading();
        return;
      }

      holdStateRef.current = "draining";

      holdDrainAnimRef.current = animate(holdExtraMv, 0, {
        type: "tween",
        duration: DRAIN_DURATION_S,
        ease: DRAIN_EASE,
        onComplete: () => {
          holdDrainAnimRef.current = null;
          holdExtraMv.set(0);
          if (holdStateRef.current === "draining") {
            enterFading();
          }
        },
      });
    };

    const enterFading = () => {
      cancelFadeOutAnim();
      holdStateRef.current = "fading";
      holdExtraMv.set(0);

      const fromOpacity = holdOpacityMv.get();
      if (fromOpacity <= 0) {
        holdStateRef.current = "idle";
        holdOpacityMv.set(0);
        return;
      }

      fadeOutAnimRef.current = animate(holdOpacityMv, 0, {
        type: "tween",
        duration: (fromOpacity / 1) * RELEASE_FADE_DURATION_S,
        ease: "easeOut",
        onComplete: () => {
          fadeOutAnimRef.current = null;
          holdOpacityMv.set(0);
          if (holdStateRef.current === "fading") {
            holdStateRef.current = "idle";
          }
        },
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }
      event.preventDefault();
      // Browser auto-repeat fires keydown over and over while held — ignore everything
      // except the very first one.
      if (event.repeat) {
        return;
      }
      if (tasksRef.current.length === 0) {
        return;
      }
      if (completingTaskIdRef.current !== null) {
        return;
      }

      isPressingRef.current = true;
      cancelHoldTimeout();

      // Schedule charging to begin only AFTER the threshold. Short taps never
      // reach this point because keyup will clear the timeout and fire
      // togglePlayPause instead.
      holdTimeoutRef.current = window.setTimeout(() => {
        holdTimeoutRef.current = null;
        if (!isPressingRef.current) {
          return;
        }
        if (completingTaskIdRef.current !== null) {
          return;
        }
        enterCharging();
      }, LONG_PRESS_THRESHOLD_MS);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }
      // The threshold timeout still pending = this was a quick tap (toggle play/pause).
      const wasShortTap = holdTimeoutRef.current !== null;
      isPressingRef.current = false;

      if (wasShortTap) {
        cancelHoldTimeout();
        togglePlayPause();
        return;
      }

      // Past the threshold: drain (if needed) then dissolve back to the grey wipe.
      startReleaseSequence();
    };

    // If the user alt-tabs / clicks away mid-hold the OS may swallow the keyup. Treat a
    // window blur the same as a release so we don't leave the bar stuck on screen.
    const handleWindowBlur = () => {
      if (!isPressingRef.current && holdStateRef.current === "idle") {
        return;
      }
      isPressingRef.current = false;
      cancelHoldTimeout();
      startReleaseSequence();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      cancelHoldTimeout();
      cancelHoldRaf();
      cancelShakeFade();
      cancelDrainAnim();
      cancelChargeOpacityAnim();
      cancelChargeShakeAnim();
      cancelFadeOutAnim();
    };
  }, []);

  /**
   * Cancel any in-flight hold animation if (a) the user navigates to a different task or
   * (b) something else triggers the completion animation (e.g. timer hits zero on its own).
   * Otherwise the rising bar would stay on screen and possibly force-complete the wrong task.
   */
  useEffect(() => {
    const hasInflight =
      holdStateRef.current !== "idle" ||
      holdTimeoutRef.current !== null ||
      holdExtraMv.get() > 0 ||
      holdOpacityMv.get() > 0 ||
      shakeIntensityMv.get() > 0 ||
      shakeFadeAnimRef.current !== null ||
      holdDrainAnimRef.current !== null ||
      chargeOpacityAnimRef.current !== null ||
      chargeShakeAnimRef.current !== null ||
      fadeOutAnimRef.current !== null;
    if (!hasInflight) {
      return;
    }
    if (holdRafRef.current !== null) {
      cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
    if (holdTimeoutRef.current !== null) {
      window.clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (chargeOpacityAnimRef.current !== null) {
      chargeOpacityAnimRef.current.stop();
      chargeOpacityAnimRef.current = null;
    }
    if (chargeShakeAnimRef.current !== null) {
      chargeShakeAnimRef.current.stop();
      chargeShakeAnimRef.current = null;
    }
    if (fadeOutAnimRef.current !== null) {
      fadeOutAnimRef.current.stop();
      fadeOutAnimRef.current = null;
    }
    if (shakeFadeAnimRef.current !== null) {
      shakeFadeAnimRef.current.stop();
      shakeFadeAnimRef.current = null;
    }
    if (holdDrainAnimRef.current !== null) {
      holdDrainAnimRef.current.stop();
      holdDrainAnimRef.current = null;
    }
    holdStateRef.current = "idle";
    holdExtraMv.set(0);
    holdOpacityMv.set(0);
    shakeIntensityMv.set(0);
    isPressingRef.current = false;
  }, [
    currentIndex,
    completingTaskId,
    holdExtraMv,
    holdOpacityMv,
    shakeIntensityMv,
  ]);

  useEffect(() => {
    if (spaceFeedback === null) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setSpaceFeedback((prev) => (prev?.id === spaceFeedback.id ? null : prev));
    }, 2250);
    return () => window.clearTimeout(timeoutId);
  }, [spaceFeedback]);

  /**
   * Save the running task's remaining time when the tab is being hidden / closed.
   * Covers the "user closes the browser" case that pause / navigation persistence
   * misses. `pagehide` fires on actual unloads (incl. mobile safari), and
   * `visibilitychange → hidden` fires on tab swaps and minimize.
   */
  useEffect(() => {
    const flushRunning = () => {
      for (const [idStr, t] of Object.entries(timersByTaskIdRef.current)) {
        if (t.isRunning) {
          persistCurrentTimeSeconds(Number(idStr), liveRemaining(t));
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushRunning();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flushRunning);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flushRunning);
    };
  }, []);

  const currentTask = tasks[currentIndex];
  const currentTaskColor = currentTask?.color ?? "#EDEBD7";
  const isLongText = currentTask ? currentTask.text.length > 55 : false;

  const currentTimer =
    currentTask && timersByTaskId[currentTask.id] !== undefined
      ? timersByTaskId[currentTask.id]
      : currentTask
        ? persistedTimerForTask(currentTask)
        : null;

  const displayedTimeLabel = currentTimer
    ? formatRemainingAsMinutesLabel(currentTimer.remainingSeconds)
    : "";

  /**
   * On task change (incl. after long-press removes a row) or when the list
   * empties, hard-reset the wipe to this task's progress. The RAF loop below
   * would catch up on the next frame, but seeding the value synchronously here
   * avoids one frame of stale wipe (e.g. previous task's full grey flashing in)
   * when the new task slides into place.
   */
  useLayoutEffect(() => {
    if (tasks.length === 0) {
      wipeBottomMv.set(0);
      return;
    }
    if (currentTask === undefined) {
      return;
    }
    const t =
      timersByTaskId[currentTask.id] ?? persistedTimerForTask(currentTask);
    const live = liveRemaining(t);
    const fp = t.animationBaseSeconds > 0
      ? (live / t.animationBaseSeconds) * 100
      : 100;
    wipeBottomMv.set(Math.min(100, Math.max(0, 100 - fp)));
  }, [currentTask?.id, tasks.length, currentTask, timersByTaskId, wipeBottomMv]);

  /**
   * Wipe driver — continuous, time-based, exact. Every frame we read the current
   * task's timer, ask `liveRemaining()` what's *really* left right now (down to
   * the millisecond), and write the corresponding wipe target straight into
   * `wipeBottomMv`. The visible fill is therefore always current — no waiting
   * for the next interval tick, no `animate(target, 1s)` chains drifting
   * behind reality, no rate variance after pause/resume.
   *
   * When the task is paused, `liveRemaining` just returns the snapshotted
   * `remainingSeconds`, which doesn't change between frames, so the wipe sits
   * still. When the user hits Space the wipe starts moving on the very next
   * frame (~16 ms), not on the next 1-second tick boundary.
   */
  useEffect(() => {
    let rafId: number | null = null;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const tasksNow = tasksRef.current;
      const idx = currentIndexRef.current;
      const cur = tasksNow[idx];
      if (!cur) {
        return;
      }
      const t = timersByTaskIdRef.current[cur.id];
      if (!t) {
        return;
      }
      const live = liveRemaining(t);
      const fp = t.animationBaseSeconds > 0
        ? (live / t.animationBaseSeconds) * 100
        : 100;
      const target = Math.min(100, Math.max(0, 100 - fp));
      wipeBottomMv.set(target);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [wipeBottomMv]);

  /**
   * Long-press fill geometry. The fill is top-anchored at 0 (same as the wipe)
   * and its height = `wipeBottomMv + holdExtraMv`, clamped to 100. So during
   * charging/fading (extra=0) it sits exactly on top of the wipe; during wiping
   * it dips below by `holdExtraMv`; during draining it shrinks back to the wipe
   * edge. Opacity is driven by `holdOpacityMv` for the dissolve in/out.
   */
  const wipeHeightStr = useMotionTemplate`${wipeBottomMv}%`;
  const holdHeightPct = useTransform(
    [wipeBottomMv, holdExtraMv],
    (latest) => {
      const [w, e] = latest as [number, number];
      return Math.min(100, Math.max(0, w + e));
    }
  );
  const holdHeightStr = useMotionTemplate`${holdHeightPct}%`;

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
  const completionTimerLabel =
    completionKindRef.current === "natural"
      ? formatRemainingAsMinutesLabel(0)
      : "done";

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-mandu-bg text-mandu-white">

      {/* Full-screen color wipe — drains downward as time passes. Height is driven
          off the shared `wipeBottomMv` motion value, which is itself updated every
          frame from `liveRemaining(currentTimer)` by the RAF effect above. The
          long-press fill's top reads the same value so the two stay pixel-aligned. */}
      {tasks.length > 0 && isTimerActive && (
        <motion.div
          className="pointer-events-none absolute inset-x-0 top-0 z-0"
          style={{
            height: wipeHeightStr,
            backgroundColor: "#EDEBD7",
            opacity: 0.08,
          }}
        />
      )}

      {/* Hold-to-complete: top-anchored gradient overlay sharing the wipe's exact
          area. Two-phase animation:
            - Charging  : opacity ramps 0→1 IN-PLACE over the wipe (extra=0).
                          Visually the grey wipe "transforms" into the gradient.
            - Wiping    : extra grows below the wipe so the bright bottom edge
                          descends faster than the natural wipe rate.
            - Draining  : extra eases back to 0 (no spring bounce) on release.
            - Fading    : opacity ramps back to 0, revealing the regular grey wipe.
          Height = `wipeBottomMv + holdExtraMv` (clamped 100), so it ALWAYS follows
          the wipe pixel-perfect in every phase. Square corners; the leading edge
          is in the gradient itself. */}
      {tasks.length > 0 && (
        <motion.div
          className="pointer-events-none absolute inset-x-0 top-0 z-0"
          style={{
            height: holdHeightStr,
            opacity: holdOpacityMv,
            /* Stops are fully opaque (no see-through to the base timer wipe).
               Top stop (#3E3D3B) is the EXACT pre-mix of `bg-mandu-bg #2F2E2D`
               with the wipe overlay `#EDEBD7 @ 8%`, so the joint between the
               regular wipe area and the charged gradient at top is invisible.
               background-size 100%×100vh + no-repeat anchors the gradient to the
               viewport so it does NOT stretch as the fill height grows — the div
               just reveals more of a fixed 100vh image (so the color you see at
               the leading edge naturally brightens as the fill descends). */
            background:
              "linear-gradient(to bottom, " +
              "#3E3D3B 0%, " +
              "#564730 8%, " +
              "#856836 18%, " +
              "#AE863B 30%, " +
              "#CE9D3D 44%, " +
              "#E3B23C 60%, " +
              "#F0C14F 74%, " +
              "#F8DA80 86%, " +
              "#FFF0C8 95%, " +
              "#FFFFFF 100%)",
            backgroundSize: "100% 100vh",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "top left",
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
                /*
                 * Tween, NOT a spring. Springs (especially overdamped ones) approach
                 * the target asymptotically — Framer settles them when below
                 * `restDelta`/`restSpeed` thresholds and SNAPS the value to the
                 * exact target on completion. Visually that read as "the slide
                 * stops early and then jerks the last pixels into the centre",
                 * which the user noticed. A tween of fixed duration / cubic ease
                 * lands precisely at `x: 0` every time, no last-frame correction.
                 */
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
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
                        {isCurrentTaskCompleting
                          ? completionTimerLabel
                          : displayedTimeLabel}
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
                  {/*
                    * Parent stays inline and only animates color / opacity / textShadow
                    * for the completion dissolve — those properties inherit through CSS
                    * down to every per-letter `ShakingLetter`, so all letters fade and
                    * glow in sync without us repeating the keyframes 30+ times. The
                    * shake itself is per-letter (each letter has its own phased motion
                    * values), giving the chaotic "letras a vibrar separadamente" look
                    * the user asked for.
                    *
                    * Layout strategy: split the text on whitespace, wrap each word in
                    * an `inline-block` + `whiteSpace: nowrap` span (so word integrity
                    * is preserved at line breaks, but adjacent letters inside a word
                    * never break apart), and render each character as a `ShakingLetter`
                    * inline-block (mandatory for transforms to apply).
                    */}
                  <motion.span
                    className="break-words font-black"
                    style={{
                      color: currentTaskColor,
                    }}
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
                    {(() => {
                      const segments = currentTask.text.split(/(\s+)/);
                      let letterCounter = 0;
                      return segments.map((seg, sIdx) => {
                        if (seg === "") {
                          return null;
                        }
                        if (/^\s+$/.test(seg)) {
                          return (
                            <span key={`s-${sIdx}`}>{seg}</span>
                          );
                        }
                        return (
                          <span
                            key={`w-${sIdx}`}
                            style={{
                              display: "inline-block",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {Array.from(seg).map((char, cIdx) => {
                              const idx = letterCounter++;
                              return (
                                <ShakingLetter
                                  key={cIdx}
                                  char={char}
                                  letterIndex={idx}
                                  time={time}
                                  shakeIntensityMv={shakeIntensityMv}
                                  taskColor={currentTaskColor}
                                  isCompleting={isCurrentTaskCompleting}
                                  completionDurationMs={COMPLETION_DISSOLVE_MS}
                                />
                              );
                            })}
                          </span>
                        );
                      });
                    })()}
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

      {/* One-shot start/resume feedback: instant full opacity, then fade out only. */}
      <AnimatePresence>
        {!isCurrentTaskCompleting && tasks.length > 0 && spaceFeedback && (
          <motion.div
            key={`space-feedback-${spaceFeedback.id}`}
            className="absolute bottom-12 left-1/2 z-30 -translate-x-1/2 select-none text-lg font-thin tracking-wide text-mandu-white/80"
            initial={{ opacity: 1 }}
            animate={{ opacity: [1, 1, 0] }}
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
