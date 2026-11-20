import { useEffect, useRef, useState } from "react";
import { advanceFocus, pauseFocus, resumeFocus, setFocusAuto, setFocusStudy, startFocus, stopFocus } from "@/lib/atlas/server";

type Course = { id: string; name: string };
type Assignment = { id: string; title: string; subject: string; done: boolean };

export type FocusActive = {
  id: string;
  preset: string;
  focusMin: number;
  breakMin: number;
  courseId: string | null;
  assignmentId: string | null;
  objective: string;
  label: string;
  phase: "focus" | "break";
  status: "running" | "paused";
  phaseEndsAt: number | null;
  remainingMs: number | null;
  focusMs: number;
  autoBreak: boolean;
  goal: string;
  tried: boolean;
  gap: boolean;
  again: boolean;
};

export type FocusRecent = {
  id: string;
  label: string;
  subject: string;
  focusMs: number;
  status: string;
  preset: string;
  startedAt: string | null;
  endedAt: string | null;
  goal: string;
};

const PRESETS = [
  { id: "short", label: "Short", focus: 15, brk: 3 },
  { id: "classic", label: "Classic", focus: 25, brk: 5 },
  { id: "deep", label: "Deep work", focus: 50, brk: 10 },
  { id: "extended", label: "Extended", focus: 90, brk: 15 },
  { id: "custom", label: "Custom", focus: 25, brk: 5 },
] as const;

function readFlag(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  const value = localStorage.getItem(key);
  if (value === "1") return true;
  if (value === "0") return false;
  return fallback;
}

function clock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const PRESET_LABEL: Record<string, string> = {
  short: "Short",
  classic: "Classic",
  deep: "Deep work",
  extended: "Extended",
  custom: "Custom",
};

function stamp(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

function statusWord(status: string) {
  if (status === "interrupted") return "stopped early";
  if (status === "cancelled") return "cancelled";
  return "finished";
}

export function formatFocus(ms: number) {
  if (ms < 1000) return "0s";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  return `${minutes} min`;
}

function remainingOf(active: FocusActive, now: number) {
  if (active.status === "paused") return Math.max(0, active.remainingMs ?? 0);
  return Math.max(0, (active.phaseEndsAt ?? now) - now);
}

export function FocusDock({
  courses,
  assignments,
  active,
  recent,
  onChange,
}: {
  courses: Course[];
  assignments: Assignment[];
  active: FocusActive | null;
  recent: FocusRecent[];
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("classic");
  const [focusMin, setFocusMin] = useState(25);
  const [breakMin, setBreakMin] = useState(5);
  const [courseId, setCourseId] = useState("");
  const [assignmentId, setAssignmentId] = useState("");
  const [objective, setObjective] = useState("");
  const [goal, setGoal] = useState("");
  const [tried, setTried] = useState(false);
  const [gap, setGap] = useState(false);
  const [again, setAgain] = useState(false);
  const [autoBreak, setAutoBreak] = useState(true);
  const [notify, setNotify] = useState(false);
  const [ambient, setAmbient] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const onChangeRef = useRef(onChange);
  const advancing = useRef(false);
  const audioStop = useRef<(() => void) | null>(null);
  onChangeRef.current = onChange;

  useEffect(() => {
    setAutoBreak(readFlag("atlas-focus-auto", true));
    setNotify(readFlag("atlas-focus-notify", false));
    setAmbient(readFlag("atlas-focus-ambient", false));
    setQuiet(readFlag("atlas-focus-quiet", false));
  }, []);

  useEffect(() => {
    if (active) setAutoBreak(active.autoBreak);
  }, [active]);

  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (!active) {
      if (synced.current) {
        setTried(false);
        setGap(false);
        setAgain(false);
      }
      synced.current = null;
      return;
    }
    if (synced.current === active.id) return;
    synced.current = active.id;
    setGoal(active.goal);
    setTried(active.tried);
    setGap(active.gap);
    setAgain(active.again);
  }, [active]);

  const running = active?.status === "running";
  useEffect(() => {
    if (!running) return;
    let id = 0;
    const tick = () => {
      setNow(Date.now());
      id = window.setTimeout(tick, 200);
    };
    id = window.setTimeout(tick, 200);
    const wake = () => setNow(Date.now());
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [running, active?.id, active?.phaseEndsAt]);

  useEffect(() => {
    if (!active || active.status !== "running" || (active.phaseEndsAt ?? 0) > Date.now()) return;
    if (advancing.current) return;
    advancing.current = true;
    advanceFocus()
      .then((result) => {
        if (
          result.notice &&
          readFlag("atlas-focus-notify", false) &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification(result.notice);
        }
        onChangeRef.current();
      })
      .catch(() => undefined)
      .finally(() => {
        advancing.current = false;
      });
  }, [active, now]);

  useEffect(() => {
    audioStop.current?.();
    audioStop.current = null;
    if (!ambient || !active || active.status !== "running" || active.phase !== "focus") return;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 110;
    gain.gain.value = 0.012;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    audioStop.current = () => {
      oscillator.stop();
      void context.close();
    };
    return () => {
      audioStop.current?.();
      audioStop.current = null;
    };
  }, [ambient, active?.id, active?.status, active?.phase]);

  function saveFlag(key: string, value: boolean) {
    localStorage.setItem(key, value ? "1" : "0");
  }

  function saveStudy(next: { goal: string; tried: boolean; gap: boolean; again: boolean }) {
    if (!active) return;
    void run(() => setFocusStudy({ data: next }));
  }

  async function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError("");
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error || "Could not update the timer.");
        return;
      }
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the timer.");
    }
  }

  const remaining = active ? remainingOf(active, now) : 0;
  const namedCourses = courses.filter((row) => row.name.trim());
  const openAssignments = assignments.filter((row) => !row.done && row.title.trim() && row.title !== "New assignment");
  const quietScreen = Boolean(quiet && active && active.phase === "focus" && active.status === "running");
  const study = { goal, tried, gap, again };

  const studyList = (
    <div className="space-y-1 border-t border-border pt-3">
      <div className="text-xs tracking-[0.16em] text-muted uppercase">Self-test</div>
      <label className="block text-xs tracking-[0.14em] text-muted uppercase">
        Able to
        <input
          className="mt-2 w-full border-0 border-b border-border bg-transparent py-2 text-base text-fg outline-none"
          value={goal}
          placeholder="One specific thing."
          onChange={(event) => setGoal(event.target.value)}
          onBlur={() => saveStudy(study)}
        />
      </label>
      {(
        [
          ["Tried it before looking", tried, setTried, "tried"],
          ["Opened notes only for what I could not do", gap, setGap, "gap"],
          ["Tested it a second way", again, setAgain, "again"],
        ] as const
      ).map(([label, checked, setChecked, key]) => (
        <label key={key} className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => {
              const next = event.target.checked;
              setChecked(next);
              saveStudy({ ...study, [key]: next });
            }}
          />
          {label}
        </label>
      ))}
    </div>
  );

  const body = (
    <div className="space-y-4">
      {active ? (
        <>
          <div>
            <div className="text-xs tracking-[0.16em] text-muted uppercase">{active.phase === "break" ? "Break" : "Focus"}</div>
            <div className="mt-2 text-5xl font-medium tabular-nums tracking-tight">{clock(remaining)}</div>
            <div className={`mt-3 ${active.status === "running" && active.phase === "focus" ? "focus-line" : "h-px bg-border"}`} />
            <p className="mt-3 text-sm">{active.label}</p>
            {active.status === "paused" ? <p className="text-sm text-muted">Paused.</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {active.status === "running" ? (
              <button type="button" className="min-h-11 border border-fg px-4 text-xs tracking-[0.14em] uppercase" onClick={() => run(pauseFocus)}>
                Pause
              </button>
            ) : (
              <button type="button" className="min-h-11 bg-fg px-4 text-xs tracking-[0.14em] text-bg uppercase" onClick={() => run(resumeFocus)}>
                Resume
              </button>
            )}
            <button type="button" className="min-h-11 border border-border px-4 text-xs tracking-[0.14em] uppercase" onClick={() => run(stopFocus)}>
              Stop
            </button>
          </div>
          {studyList}
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPreset(item.id)}
                className={`min-h-11 border px-3 text-xs tracking-[0.12em] uppercase ${preset === item.id ? "border-fg text-fg" : "border-border text-muted"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted">
            {preset === "custom"
              ? "Set both lengths."
              : `${PRESETS.find((item) => item.id === preset)?.focus} min focus, ${PRESETS.find((item) => item.id === preset)?.brk} min break.`}
          </p>
          {preset === "custom" ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs tracking-[0.14em] text-muted uppercase">
                Focus
                <input className="mt-2 w-full border-0 border-b border-border bg-transparent py-2 text-base text-fg outline-none" type="number" min={1} max={180} value={focusMin} onChange={(event) => setFocusMin(Number(event.target.value))} />
              </label>
              <label className="block text-xs tracking-[0.14em] text-muted uppercase">
                Break
                <input className="mt-2 w-full border-0 border-b border-border bg-transparent py-2 text-base text-fg outline-none" type="number" min={1} max={60} value={breakMin} onChange={(event) => setBreakMin(Number(event.target.value))} />
              </label>
            </div>
          ) : null}
          <label className="block text-xs tracking-[0.14em] text-muted uppercase">
            Course
            <select className="mt-2 w-full border-0 border-b border-border bg-transparent py-2 text-base text-fg outline-none" value={courseId} onChange={(event) => setCourseId(event.target.value)}>
              <option value="">None</option>
              {namedCourses.map((row) => (
                <option key={row.id} value={row.id}>{row.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs tracking-[0.14em] text-muted uppercase">
            Assignment
            <select className="mt-2 w-full border-0 border-b border-border bg-transparent py-2 text-base text-fg outline-none" value={assignmentId} onChange={(event) => setAssignmentId(event.target.value)}>
              <option value="">None</option>
              {openAssignments.map((row) => (
                <option key={row.id} value={row.id}>{row.title}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs tracking-[0.14em] text-muted uppercase">
            Topic
            <input className="mt-2 w-full border-0 border-b border-border bg-transparent py-2 text-base text-fg outline-none" value={objective} placeholder="Optional. A topic or an objective." onChange={(event) => setObjective(event.target.value)} />
          </label>
          {recent[0] ? (
            <button
              type="button"
              className="text-left text-sm text-muted"
              onClick={() => setObjective(recent[0].label)}
            >
              Last recorded · {recent[0].label}
            </button>
          ) : null}
          {studyList}
          <button
            type="button"
            className="min-h-11 bg-fg px-4 text-xs tracking-[0.14em] text-bg uppercase"
            onClick={() =>
              run(async () => {
                const result = await startFocus({
                  data: { preset, focusMin, breakMin, courseId, assignmentId, objective, autoBreak, goal, tried, gap, again },
                });
                if (result.ok) setOpen(true);
                return result;
              })
            }
          >
            Start
          </button>
        </>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoBreak}
          onChange={(event) => {
            const next = event.target.checked;
            setAutoBreak(next);
            saveFlag("atlas-focus-auto", next);
            if (active) void run(() => setFocusAuto({ data: next }));
          }}
        />
        Start the break when focus ends
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={notify}
          onChange={(event) => {
            const next = event.target.checked;
            setNotify(next);
            saveFlag("atlas-focus-notify", next);
            if (next && typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
          }}
        />
        Notify when a phase ends
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={ambient}
          onChange={(event) => {
            setAmbient(event.target.checked);
            saveFlag("atlas-focus-ambient", event.target.checked);
          }}
        />
        Quiet tone during focus
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={quiet}
          onChange={(event) => {
            setQuiet(event.target.checked);
            saveFlag("atlas-focus-quiet", event.target.checked);
          }}
        />
        Hide the board during focus
      </label>
      {error ? <p className="text-sm">{error}</p> : null}
      {recent.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-3">
          {recent.slice(0, 6).map((row) => {
            const start = stamp(row.startedAt);
            const end = stamp(row.endedAt);
            const when = start && end ? `${start}–${end}` : start || end;
            return (
              <p key={row.id} className="text-sm text-muted">
                {when ? `${when} · ` : ""}
                {PRESET_LABEL[row.preset] ?? row.preset} · {row.subject && row.subject !== row.label ? `${row.subject} · ` : ""}
                {row.label} · {formatFocus(row.focusMs)} · {statusWord(row.status)}
                {row.goal ? <span className="block">{row.goal}</span> : null}
              </p>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  if (quietScreen && active) {
    return (
      <div className="fixed inset-0 z-30 flex flex-col justify-between bg-bg px-6 py-6 text-fg">
        <div className="flex items-center justify-between text-xs tracking-[0.22em] text-muted uppercase">
          <span>Focus</span>
          <button type="button" className="min-h-11 text-fg" onClick={() => { setQuiet(false); saveFlag("atlas-focus-quiet", false); }}>
            Board
          </button>
        </div>
        <div className="mx-auto w-full max-w-xl">
          <div className="text-7xl font-medium tabular-nums tracking-tight">{clock(remaining)}</div>
          <div className="focus-line mt-4" />
          <p className="mt-4 text-lg">{active.label}</p>
          <div className="mt-6 flex gap-2">
            <button type="button" className="min-h-11 border border-fg px-4 text-xs tracking-[0.14em] uppercase" onClick={() => run(pauseFocus)}>Pause</button>
            <button type="button" className="min-h-11 border border-border px-4 text-xs tracking-[0.14em] uppercase" onClick={() => run(stopFocus)}>Stop</button>
          </div>
          <div className="mt-8">{studyList}</div>
        </div>
        <div />
      </div>
    );
  }

  return (
    <div className="fixed right-4 bottom-4 z-40 w-[min(22rem,calc(100%-2rem))]">
      {open ? (
        <div className="no-bar max-h-[min(34rem,calc(100dvh-5rem))] overflow-y-auto overscroll-contain border border-border bg-bg p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs tracking-[0.16em] uppercase">Focus</div>
            <button type="button" className="min-h-11 text-xs tracking-[0.14em] text-muted uppercase" onClick={() => setOpen(false)}>
              Hide
            </button>
          </div>
          {body}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-11 border border-border bg-bg px-4 text-xs tracking-[0.16em] uppercase"
        >
          {active ? `${active.phase === "break" ? "Break" : "Focus"} ${clock(remaining)}` : "Focus"}
        </button>
      )}
    </div>
  );
}
