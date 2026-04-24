import { useEffect, useState } from "react";
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

function parseTimeToSeconds(time: string): number {
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

/** Whole minutes left (ceil); label jumps only when a full minute boundary is crossed. */
function formatRemainingAsMinutesLabel(remainingSeconds: number): string {
  const whole = Math.max(0, Math.floor(remainingSeconds));
  const minutes = Math.ceil(whole / 60);
  return `${minutes} min`;
}

const Index = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [fadeCategoryOut, setFadeCategoryOut] = useState(false);
  const [timersByTaskId, setTimersByTaskId] = useState<Record<number, TaskTimer>>({});

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const response = await fetch("http://localhost:3001/api/tasks");
        if (!response.ok) {
          throw new Error("Failed to fetch tasks");
        }

        const data: Task[] = await response.json();
        setTasks(data);
        setCurrentIndex(0);
      } catch (error) {
        console.error(error);
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

        if (t.remainingSeconds <= 0) {
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

  useEffect(() => {
    const handleArrowNavigation = (event: KeyboardEvent) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
        return;
      }

      event.preventDefault();

      if (tasks.length === 0) {
        return;
      }

      if (event.key === "ArrowRight") {
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
  }, [tasks]);

  useEffect(() => {
    const handleSpace = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }

      event.preventDefault();

      if (tasks.length === 0) {
        return;
      }

      const task = tasks[currentIndex];
      const taskId = task.id;

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
    };

    window.addEventListener("keydown", handleSpace);

    return () => {
      window.removeEventListener("keydown", handleSpace);
    };
  }, [tasks, currentIndex]);

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
  }, [currentIndex, tasks.length]);

  const isTimerActive = currentTimer ? currentTimer.isRunning || currentTimer.remainingSeconds < currentTimer.animationBaseSeconds : false;

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
            transition: "height 1s linear",
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
            Loading universe...
          </h1>
        ) : (
          <div className="flex w-full max-w-[min(100%,min(90rem,98svw))] flex-col items-center px-0.5 pointer-events-auto sm:px-1 md:px-1.5">
            <motion.p
              key={`category-${currentIndex}`}
              layout={false}
              initial={{ opacity: 0 }}
              animate={{ opacity: fadeCategoryOut ? 0 : 1 }}
              transition={{
                opacity: {
                  delay: fadeCategoryOut ? 0 : 0.75,
                  duration: fadeCategoryOut ? 1 : 0.2,
                  ease: fadeCategoryOut ? "easeInOut" : "easeOut",
                },
              }}
              className="mb-2 w-full self-end text-right text-sm font-thin uppercase tracking-widest"
              style={{ color: currentTaskColor }}
            >
              {currentTask.category}
            </motion.p>
            <AnimatePresence custom={direction} mode="popLayout">
              <motion.div
                key={currentIndex}
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
                  <span
                    className="mr-4 font-thin md:mr-6"
                    style={{ color: currentTaskColor, opacity: 0.7 }}
                  >
                    {displayedTimeLabel}
                  </span>
                  <span className="break-words font-black" style={{ color: currentTaskColor }}>
                    {currentTask.text}
                  </span>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* Bottom hint — shows "press ⎵ to start" when idle, "paused" when paused, hidden when running */}
      {currentTimer?.isRunning !== true && (
        <motion.div
          className="absolute bottom-12 left-1/2 z-30 -translate-x-1/2 select-none text-lg font-thin tracking-wide text-mandu-white/80"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 2.2, ease: "easeInOut", repeat: Infinity }}
        >
          {isTimerActive ? "paused" : "press ⎵ to start"}
        </motion.div>
      )}
    </div>
  );
};

export default Index;
