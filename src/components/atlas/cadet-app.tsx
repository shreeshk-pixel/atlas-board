import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import { loginEnabled } from "@/lib/atlas/gate";
import {
  addAssignment,
  addClass,
  addCourse,
  askAtlas,
  clearChat,
  deleteAssignment,
  deleteClass,
  deleteCourse,
  importAcademics,
  importTimetable,
  loadBoard,
  makeStudyPlan,
  markAskOpened,
  noteAsk,
  saveAiPrefs,
  setAttendance as saveAttendance,
  setPulseEnabled,
  summarizeNotes,
  updateAssignment,
  updateClass,
  updateCourse,
} from "@/lib/atlas/server";
import { Card, GhostButton, Notice, PrimaryButton, inputClass } from "./ui";
import { FocusDock, formatFocus, type FocusActive, type FocusRecent } from "./focus-dock";

type ClassRow = { id: string; day: string; time: string; subject: string; room: string };
type Assignment = { id: string; title: string; subject: string; due: string; done: boolean };
type Course = { id: string; name: string; credits: number; grade: string };
type Chat = { id: string; role: string; content: string };
type AttendanceMark = { classId: string; day: string; status: "present" | "absent" | "none" };
type PendingFile = {
  id: string;
  name: string;
  kind: "text" | "image" | "file";
  text?: string;
  mime?: string;
  data?: string;
};
type Tab = "overview" | "timetable" | "assignments" | "academics" | "ai" | "settings";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GRADES = ["S", "A", "B", "C", "D", "E", "F"];
const POINTS: Record<string, number> = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };

const FILE_ACCEPT =
  ".pdf,.xls,.xlsx,.xlsm,.ppt,.pptx,.pptm,.doc,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.gif,image/*,application/pdf";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "timetable", label: "Timetable" },
  { id: "assignments", label: "Assignments" },
  { id: "academics", label: "Academics" },
  { id: "ai", label: "AI Ops" },
  { id: "settings", label: "Settings" },
];

function cgpa(courses: Course[]) {
  let points = 0;
  let credits = 0;
  for (const course of courses) {
    if (!course.name.trim() || !(course.grade in POINTS)) continue;
    points += (POINTS[course.grade] ?? 0) * course.credits;
    credits += course.credits;
  }
  if (!credits) return "—";
  return (points / credits).toFixed(2);
}

function isoDay(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function daysUntil(due: string) {
  const [year, month, day] = due.split("-").map(Number);
  const target = new Date(year, (month || 1) - 1, day || 1);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - start.getTime()) / 86400000);
}

function minutesUntil(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const now = new Date();
  return hour * 60 + minute - (now.getHours() * 60 + now.getMinutes());
}

type PulseMark = { refId: string; kind: string; label: string };

function clockMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function ambientLine(rows: ClassRow[], assignments: Assignment[]) {
  const times = rows
    .map((row) => ({ time: row.time, mins: clockMinutes(row.time) }))
    .filter((row): row is { time: string; mins: number } => row.mins !== null)
    .sort((a, b) => a.mins - b.mins);
  const dueSoon = assignments.some((row) => !row.done && row.title.trim() && daysUntil(row.due) <= 0);
  if (times.length >= 4 && dueSoon) return "A full day. Something is also due.";
  for (let index = 0; index < times.length - 1; index++) {
    if (times[index + 1].mins - times[index].mins >= 50) {
      return `Between the ${times[index].time} and the ${times[index + 1].time}.`;
    }
  }
  if (times.length > 0 && times.length <= 2 && !dueSoon) return "A light day.";
  return null;
}

function continuityLine(assignments: Assignment[], thing: string) {
  const open = assignments
    .filter((row) => !row.done && row.title.trim() && row.title !== "New assignment" && row.title !== thing)
    .sort((a, b) => a.due.localeCompare(b.due));
  return open[0] ? `${open[0].title} is still open.` : null;
}

type Brief = { kicker: string; line: string; detail: string; cta: string; tab: Tab; thing: string };

function makeBrief(classes: ClassRow[], assignments: Assignment[], courses: Course[]): Brief {
  const open = assignments
    .filter((row) => !row.done && row.title.trim())
    .slice()
    .sort((a, b) => a.due.localeCompare(b.due));
  const late = open.find((row) => daysUntil(row.due) < 0);
  if (late) {
    const days = Math.abs(daysUntil(late.due));
    return {
      kicker: "Late",
      line: late.title,
      detail: `${days === 1 ? "One day" : `${days} days`} past due. It does not get easier by waiting.`,
      cta: "Open it",
      tab: "assignments",
      thing: late.title,
    };
  }
  const soon = open.find((row) => daysUntil(row.due) <= 1);
  if (soon) {
    const today = daysUntil(soon.due) === 0;
    return {
      kicker: today ? "Due today" : "Due tomorrow",
      line: soon.title,
      detail: today
        ? "This is the work. Start before you open anything else."
        : "Tomorrow is just finishing, if you start now.",
      cta: "Start",
      tab: "assignments",
      thing: soon.title,
    };
  }
  const upcoming = open[0];
  if (upcoming && daysUntil(upcoming.due) <= 4) {
    const days = daysUntil(upcoming.due);
    return {
      kicker: "Coming up",
      line: upcoming.title,
      detail: `${days} days. The gap is smaller than it looks.`,
      cta: "Start",
      tab: "assignments",
      thing: upcoming.title,
    };
  }
  const todayName = new Date().toLocaleDateString("en-US", { weekday: "short" }).slice(0, 3);
  const todayClasses = classes
    .filter((row) => row.day === todayName && row.subject.trim())
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time));
  const nextClass = todayClasses.find((row) => minutesUntil(row.time) >= -20);
  if (nextClass) {
    const mins = minutesUntil(nextClass.time);
    const when = mins > 60 ? `in ${Math.round(mins / 60)} hours` : mins > 0 ? `in ${mins} minutes` : "now";
    return {
      kicker: "Next class",
      line: nextClass.subject,
      detail: `${nextClass.time}, ${when}. Skim what you last left unfinished before you walk in.`,
      cta: "See today",
      tab: "timetable",
      thing: nextClass.subject,
    };
  }
  if (todayClasses.length > 0) {
    const weak = courses
      .filter((row) => row.name.trim())
      .slice()
      .sort((a, b) => (POINTS[a.grade] ?? 0) - (POINTS[b.grade] ?? 0))[0];
    return {
      kicker: "After class",
      line: "The day is not finished.",
      detail: weak
        ? `Put 40 minutes on ${weak.name}. That is the grade moving.`
        : "Put 40 minutes on one subject. Then you can stop.",
      cta: "Open academics",
      tab: "academics",
      thing: weak ? weak.name : "an unfinished day",
    };
  }
  if (open[0]) {
    return {
      kicker: "Still open",
      line: open[0].title,
      detail: "Nothing is on fire. That is when work quietly slips. Do a piece of it.",
      cta: "Start",
      tab: "assignments",
      thing: open[0].title,
    };
  }
  return {
    kicker: "Clear board",
    line: "Nothing is scheduled. That is not a free evening.",
    detail: "Add the next class or the next deadline. A blank board makes drifting easy.",
    cta: "Add a class",
    tab: "timetable",
    thing: "an empty board",
  };
}

function skipSentence(day: string, label: string) {
  const [year, month, date] = day.split("-").map(Number);
  const then = new Date(year, (month || 1) - 1, date || 1);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(1, Math.round((start.getTime() - then.getTime()) / 86400000));
  const when = days === 1 ? "Yesterday" : `${days} days ago`;
  return `${when} this was ${label}. You didn't open it.`;
}

function kolkataToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftIso(iso: string, delta: number) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(Date.UTC(year, (month || 1) - 1, day || 1)).getUTCDay()
  ];
}

function labelIso(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1)).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function visibleChat(content: string) {
  return content.split("\n\n<<atlas-files>>\n")[0];
}

function readUpload(file: File) {
  const name = file.name || "file";
  const ext = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  const id = crypto.randomUUID();
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    return resizeImage(file).then((data) => ({ id, name, kind: "image" as const, mime: "image/jpeg", data }));
  }
  if (file.type.startsWith("text/") || ["txt", "md", "csv", "json", "log"].includes(ext)) {
    return file.text().then((text) => {
      if (text.length > 80000) throw new Error(`${name} is too long. Split it.`);
      return { id, name, kind: "text" as const, text };
    });
  }
  if (file.size > 2_200_000) throw new Error(`${name} is too large. Keep it under 2 MB.`);
  return new Promise<PendingFile>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${name}`));
    reader.onload = () =>
      resolve({
        id,
        name,
        kind: "file",
        mime: file.type || "application/octet-stream",
        data: String(reader.result),
      });
    reader.readAsDataURL(file);
  });
}

function resizeImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that photo"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1400;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Could not read that photo"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = () => reject(new Error("Could not read that photo"));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function CadetApp({ displayName }: { displayName: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [chat, setChat] = useState<Chat[]>([]);
  const [endpoint, setEndpoint] = useState("https://openrouter.ai/api/v1");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [hasPersonal, setHasPersonal] = useState(false);
  const [personalHint, setPersonalHint] = useState<string | null>(null);
  const [sharedAvailable, setSharedAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [summary, setSummary] = useState("");
  const [planDays, setPlanDays] = useState(7);
  const [planUntil, setPlanUntil] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [topicDraft, setTopicDraft] = useState("");
  const [plan, setPlan] = useState("");
  const [question, setQuestion] = useState("");
  const [chatFiles, setChatFiles] = useState<PendingFile[]>([]);
  const [noteFiles, setNoteFiles] = useState<PendingFile[]>([]);
  const [attendance, setAttendanceRows] = useState<AttendanceMark[]>([]);
  const [attendDay, setAttendDay] = useState(kolkataToday);
  const [timetableText, setTimetableText] = useState("");
  const [timetableFiles, setTimetableFiles] = useState<PendingFile[]>([]);
  const [academicsText, setAcademicsText] = useState("");
  const [academicsImage, setAcademicsImage] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ day: string; label: string; tab: string } | null>(null);
  const [pulseOn, setPulseOn] = useState(true);
  const [marks, setMarks] = useState<PulseMark[]>([]);
  const [focusActive, setFocusActive] = useState<FocusActive | null>(null);
  const [focusRecent, setFocusRecent] = useState<FocusRecent[]>([]);
  const [focusTotals, setFocusTotals] = useState<{ label: string; focusMs: number }[]>([]);

  async function refresh() {
    const board = await loadBoard();
    setClasses(board.classes);
    setAssignments(board.assignments);
    setCourses(board.courses);
    setChat(board.chat);
    setEndpoint(board.ai.endpoint);
    setModel(board.ai.model);
    setHasPersonal(board.ai.hasPersonal);
    setPersonalHint(board.ai.personalHint);
    setSharedAvailable(board.ai.sharedAvailable);
    setSkipped(board.skipped);
    setPulseOn(board.pulse.enabled);
    setMarks(board.pulse.marks);
    setFocusActive(board.focus.active);
    setFocusRecent(board.focus.recent);
    setFocusTotals(board.focus.totals);
    setAttendanceRows(board.attendance);
  }

  useEffect(() => {
    refresh()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load"))
      .finally(() => setLoading(false));
  }, []);

  const today = new Date().toLocaleDateString("en-US", { weekday: "short" });
  const todayClasses = classes.filter((row) => row.day === today.slice(0, 3) && row.subject);
  const upcoming = useMemo(
    () =>
      assignments
        .filter((row) => !row.done)
        .slice()
        .sort((a, b) => a.due.localeCompare(b.due))
        .slice(0, 4),
    [assignments],
  );
  const score = cgpa(courses);
  const dateLabel = new Date().toLocaleDateString("en-IN", { month: "short", day: "numeric" });
  const brief = useMemo(() => makeBrief(classes, assignments, courses), [classes, assignments, courses]);
  const ambient = pulseOn ? ambientLine(todayClasses, assignments) : null;
  const continuity = pulseOn ? continuityLine(assignments, brief.thing) : null;
  const focusGap = (() => {
    if (!pulseOn || focusTotals.length < 2) return null;
    const sorted = [...focusTotals].sort((a, b) => a.focusMs - b.focusMs);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    if (low.focusMs * 2 >= high.focusMs) return null;
    return `${low.label} has less recorded time than ${high.label}.`;
  })();
  const attendClasses = classes
    .filter((row) => row.day === weekdayOf(attendDay) && row.subject.trim())
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time));
  const counted = attendance.filter((row) => row.status === "present" || row.status === "absent");
  const presentCount = counted.filter((row) => row.status === "present").length;
  const dayMarks = attendance.filter((row) => row.day === attendDay);
  const dayPresent = dayMarks.filter((row) => row.status === "present").length;
  const dayAbsent = dayMarks.filter((row) => row.status === "absent").length;
  const attendLine = [
    dayPresent || dayAbsent ? `${dayPresent} present · ${dayAbsent} absent` : "",
    counted.length ? `${Math.round((100 * presentCount) / counted.length)}% overall` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  function markAttendance(classId: string, status: "present" | "absent" | "none") {
    const current = attendance.find((row) => row.classId === classId && row.day === attendDay)?.status;
    const next = current === status ? "clear" : status;
    setAttendanceRows((rows) => {
      const rest = rows.filter((row) => !(row.classId === classId && row.day === attendDay));
      return next === "clear" ? rest : [...rest, { classId, day: attendDay, status: next }];
    });
    void saveAttendance({ data: { classId, day: attendDay, status: next } })
      .then((result) => {
        if (!result.ok) setError(result.error);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not save attendance"));
  }

  async function addUploads(
    list: FileList | null,
    current: PendingFile[],
    set: (files: PendingFile[]) => void,
  ) {
    if (!list?.length) return;
    const next = [...current];
    for (const file of Array.from(list)) {
      if (next.length >= 4) throw new Error("Attach up to 4 files.");
      next.push(await readUpload(file));
    }
    set(next);
  }

  async function sendChat() {
    const prompt = question.trim();
    const files = chatFiles.map(({ name, kind, text, mime, data }) => ({ name, kind, text, mime, data }));
    if (!prompt && files.length === 0) return;
    setQuestion("");
    setChatFiles([]);
    const result = await askAtlas({ data: { prompt, files } });
    if (!result.ok) {
      setError(result.error);
      setQuestion(prompt);
      setChatFiles(chatFiles);
      return;
    }
    const visible = [prompt, files.length ? `Attached: ${files.map((file) => file.name).join(", ")}` : ""]
      .filter(Boolean)
      .join("\n\n");
    setChat((rows) => [
      ...rows,
      { id: crypto.randomUUID(), role: "user", content: visible },
      { id: crypto.randomUUID(), role: "assistant", content: result.reply },
    ]);
  }

  function addTopic() {
    const topic = topicDraft.trim();
    if (!topic) return;
    setTopics((rows) => (rows.length >= 24 ? rows : [...rows, topic.slice(0, 160)]));
    setTopicDraft("");
  }

  function keepMark(kind: string, refId: string, label: string) {
    const clean = label.trim();
    if (!clean || clean === "New assignment") return;
    setMarks((rows) =>
      rows.some((row) => row.kind === kind && row.refId === refId)
        ? rows.map((row) => (row.kind === kind && row.refId === refId ? { ...row, label: clean } : row))
        : [...rows, { refId, kind, label: clean }],
    );
  }

  useEffect(() => {
    if (loading) return;
    void noteAsk({ data: { refKey: `${brief.tab}:${brief.thing}`, label: brief.thing, tab: brief.tab } });
  }, [loading, brief.tab, brief.thing]);

  useEffect(() => {
    if (loading) return;
    if (tab !== "timetable" && tab !== "assignments" && tab !== "academics") return;
    setSkipped((row) => (row && row.tab === tab ? null : row));
    void markAskOpened({ data: { tab } });
  }, [loading, tab]);

  async function run(action: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-bg">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div>
            <div className="text-sm font-medium tracking-[0.28em]">ATLAS</div>
            {displayName ? <div className="text-xs text-muted">{displayName}</div> : null}
          </div>
          <div className="flex items-center gap-4 text-xs tracking-[0.14em] text-muted uppercase">
            <span className="hidden sm:inline">{dateLabel}</span>
            {loginEnabled ? (
              <button
                type="button"
                onClick={() => signOut("/login")}
                className="inline-flex min-h-11 items-center text-fg"
              >
                Sign out
              </button>
            ) : null}
          </div>
        </div>
        <nav className="no-bar mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex min-h-11 shrink-0 items-center border-b px-3 text-xs tracking-[0.16em] uppercase ${
                tab === id ? "border-fg text-fg" : "border-transparent text-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6 pb-28">
        {error ? <Notice>{error}</Notice> : null}
        {loading ? <p className="text-muted">Pulling your board…</p> : null}

        {!loading && tab === "overview" ? (
          <div className="space-y-4">
            <div>
              {skipped ? (
                <div className="mb-8">
                  <div className="text-xs tracking-[0.2em] text-muted uppercase">Left unopened</div>
                  <h1 className="mt-2 max-w-3xl text-4xl font-medium tracking-tight text-fg sm:text-5xl">
                    {skipSentence(skipped.day, skipped.label)}
                  </h1>
                </div>
              ) : null}
              <div className="text-xs tracking-[0.2em] text-muted uppercase">{brief.kicker}</div>
              <h1 className="mt-2 text-4xl font-medium tracking-tight text-fg sm:text-5xl">{brief.line}</h1>
              <p className="mt-2 max-w-xl text-sm text-muted">{brief.detail}</p>
              {continuity ? <p className="mt-2 text-sm text-muted">{continuity}</p> : null}
              <button
                type="button"
                onClick={() => setTab(brief.tab)}
                className="mt-4 inline-flex min-h-11 items-center bg-fg px-5 text-sm font-medium tracking-[0.14em] text-bg uppercase"
              >
                {brief.cta}
              </button>
            </div>
            {pulseOn && marks.length > 0 ? (
              <div>
                <div className="text-xs tracking-[0.2em] text-muted uppercase">Semester</div>
                <div className="mt-4 flex h-14 items-end gap-1 overflow-x-auto border-b border-border">
                  {marks.map((mark) => (
                    <div
                      key={`${mark.kind}:${mark.refId}`}
                      title={mark.label}
                      className={
                        mark.kind === "assignment_done"
                          ? "h-10 w-px shrink-0 bg-fg"
                          : mark.kind === "grade_set"
                            ? "h-5 w-px shrink-0 bg-muted"
                            : "h-3 w-px shrink-0 bg-muted"
                      }
                    />
                  ))}
                </div>
                <p className="mt-2 text-sm text-muted">{marks[marks.length - 1]?.label}</p>
              </div>
            ) : null}
            {pulseOn && focusTotals.length > 0 ? (
              <div className="space-y-1">
                {focusTotals.slice(0, 4).map((row) => (
                  <p key={row.label} className="text-sm text-muted">
                    {row.label} · {formatFocus(row.focusMs)}
                  </p>
                ))}
                {focusGap ? <p className="text-sm text-muted">{focusGap}</p> : null}
              </div>
            ) : null}
            <section className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-xs tracking-[0.2em] text-muted uppercase">Attendance</div>
                  <h2 className="mt-1 text-2xl font-medium tracking-tight">{labelIso(attendDay)}</h2>
                </div>
                <div className="flex gap-2">
                  <GhostButton onClick={() => setAttendDay((day) => shiftIso(day, -1))}>Prev</GhostButton>
                  <GhostButton onClick={() => setAttendDay(kolkataToday())}>Today</GhostButton>
                  <GhostButton onClick={() => setAttendDay((day) => shiftIso(day, 1))}>Next</GhostButton>
                </div>
              </div>
              {attendClasses.length === 0 ? (
                <p className="text-sm text-muted">
                  {classes.some((row) => row.subject.trim())
                    ? "No classes on the timetable for this day."
                    : "Import a timetable first. Attendance uses those classes."}
                </p>
              ) : (
                <div>
                  {attendClasses.map((row) => {
                    const status = attendance.find((mark) => mark.classId === row.id && mark.day === attendDay)?.status;
                    return (
                      <div
                        key={row.id}
                        className="flex flex-col gap-2 border-b border-border py-2 sm:flex-row sm:items-center"
                      >
                        <div className="flex flex-wrap gap-1">
                          {(
                            [
                              ["present", "Present"],
                              ["absent", "Absent"],
                              ["none", "No class"],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => markAttendance(row.id, value)}
                              className={`inline-flex min-h-9 items-center px-2 text-xs tracking-[0.12em] uppercase ${
                                status === value ? "bg-fg text-bg" : "border border-border text-muted"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <p className="text-sm">
                          <span className="tabular-nums text-muted">{row.time}</span> {row.subject}
                          {row.room ? <span className="text-muted"> · {row.room}</span> : null}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
              {attendLine ? <p className="text-sm text-muted">{attendLine}</p> : null}
            </section>
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <div className="text-xs tracking-[0.16em] text-muted uppercase">CGPA</div>
                <div className="mt-1 text-5xl font-medium tabular-nums tracking-tight text-fg">{score}</div>
                <p className="text-sm text-muted">{courses.filter((c) => c.name.trim()).length} courses tracked</p>
              </Card>
              <Card>
                <div className="mb-2 text-xs tracking-[0.16em] text-muted uppercase">Today</div>
                {todayClasses.length === 0 ? (
                  <p className="text-sm text-muted">No classes on the board for today.</p>
                ) : (
                  todayClasses.map((row) => (
                    <p key={row.id} className="border-b border-border py-1.5 text-sm last:border-0">
                      <span className="tabular-nums text-muted">{row.time}</span> {row.subject}
                      {row.room ? <span className="text-muted"> · {row.room}</span> : null}
                    </p>
                  ))
                )}
                {ambient ? <p className="mt-3 text-sm text-muted">{ambient}</p> : null}
                {pulseOn
                  ? todayClasses
                      .map((row) => focusTotals.find((item) => item.label.toLowerCase() === row.subject.toLowerCase()))
                      .filter((row): row is { label: string; focusMs: number } => Boolean(row))
                      .slice(0, 1)
                      .map((row) => (
                        <p key={row.label} className="mt-3 text-sm text-muted">
                          {row.label} · {formatFocus(row.focusMs)} recorded
                        </p>
                      ))
                  : null}
              </Card>
              <Card>
                <div className="mb-2 text-xs tracking-[0.16em] text-muted uppercase">Due next</div>
                {upcoming.length === 0 ? (
                  <p className="text-sm text-muted">Nothing open.</p>
                ) : (
                  upcoming.map((row) => {
                    const recorded = pulseOn
                      ? focusTotals.find((item) => {
                          const key = item.label.trim().toLowerCase();
                          return key === row.subject.trim().toLowerCase() || key === row.title.trim().toLowerCase();
                        })
                      : null;
                    return (
                      <p key={row.id} className="flex justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0">
                        <span>
                          {row.title}
                          {recorded ? (
                            <span className="text-muted">
                              {" "}
                              · {recorded.label.toLowerCase() === row.title.trim().toLowerCase() ? "" : `${recorded.label} `}
                              {formatFocus(recorded.focusMs)}
                            </span>
                          ) : null}
                        </span>
                        <span className="tabular-nums text-muted">{row.due}</span>
                      </p>
                    );
                  })
                )}
              </Card>
            </div>
          </div>
        ) : null}

        {!loading && tab === "timetable" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-3xl font-medium tracking-tight">Timetable</h2>
              <PrimaryButton
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const created = await addClass();
                    setClasses((rows) => [
                      ...rows,
                      { id: created.id, day: "Mon", time: "09:00", subject: "", room: "" },
                    ]);
                  })
                }
              >
                <Plus className="mr-1 size-4" /> Add class
              </PrimaryButton>
            </div>
            <Card className="space-y-3">
              <div className="text-xs tracking-[0.16em] text-muted uppercase">Import</div>
              <textarea
                className={`${inputClass} min-h-24 py-2`}
                placeholder="Paste the timetable, or upload a PDF, Excel, Word file, or a photo."
                value={timetableText}
                onChange={(event) => setTimetableText(event.target.value)}
              />
              {timetableFiles.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {timetableFiles.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      className="inline-flex min-h-9 items-center gap-2 border border-border px-2 text-xs text-muted"
                      onClick={() => setTimetableFiles((rows) => rows.filter((item) => item.id !== file.id))}
                    >
                      {file.name}
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                type="file"
                multiple
                accept={FILE_ACCEPT}
                className="block w-full text-sm text-muted"
                onChange={(event) => {
                  const list = event.target.files;
                  event.target.value = "";
                  void run(() => addUploads(list, timetableFiles, setTimetableFiles));
                }}
              />
              <div className="flex flex-wrap gap-2">
                <PrimaryButton
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const result = await importTimetable({
                        data: {
                          text: timetableText,
                          image: null,
                          files: timetableFiles.map(({ name, kind, text, mime, data }) => ({
                            name,
                            kind,
                            text,
                            mime,
                            data,
                          })),
                          mode: "replace",
                        },
                      });
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      await refresh();
                      setTimetableText("");
                      setTimetableFiles([]);
                    })
                  }
                >
                  Extract and replace
                </PrimaryButton>
                <GhostButton
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const result = await importTimetable({
                        data: {
                          text: timetableText,
                          image: null,
                          files: timetableFiles.map(({ name, kind, text, mime, data }) => ({
                            name,
                            kind,
                            text,
                            mime,
                            data,
                          })),
                          mode: "append",
                        },
                      });
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      await refresh();
                      setTimetableFiles([]);
                    })
                  }
                >
                  Extract and add
                </GhostButton>
                {timetableFiles.length > 0 ? (
                  <GhostButton onClick={() => setTimetableFiles([])}>Clear files</GhostButton>
                ) : null}
              </div>
            </Card>
            <div className="space-y-3">
              {classes.length === 0 ? <p className="text-sm text-muted">No classes yet.</p> : null}
              {classes.map((row) => (
                <Card key={row.id} className="grid gap-2 sm:grid-cols-[7rem_7rem_1fr_8rem_auto] sm:items-center">
                  <select
                    className={inputClass}
                    value={row.day}
                    onChange={(event) => {
                      const day = event.target.value;
                      setClasses((rows) => rows.map((item) => (item.id === row.id ? { ...item, day } : item)));
                      void updateClass({ data: { ...row, day } });
                    }}
                  >
                    {DAYS.map((day) => (
                      <option key={day}>{day}</option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    type="time"
                    value={row.time}
                    onChange={(event) => {
                      const time = event.target.value;
                      setClasses((rows) => rows.map((item) => (item.id === row.id ? { ...item, time } : item)));
                    }}
                    onBlur={(event) => void updateClass({ data: { ...row, time: event.target.value } })}
                  />
                  <input
                    className={inputClass}
                    placeholder="Subject"
                    value={row.subject}
                    onChange={(event) => {
                      const subject = event.target.value;
                      setClasses((rows) => rows.map((item) => (item.id === row.id ? { ...item, subject } : item)));
                    }}
                    onBlur={(event) => void updateClass({ data: { ...row, subject: event.target.value } })}
                  />
                  <input
                    className={inputClass}
                    placeholder="Room"
                    value={row.room}
                    onChange={(event) => {
                      const room = event.target.value;
                      setClasses((rows) => rows.map((item) => (item.id === row.id ? { ...item, room } : item)));
                    }}
                    onBlur={(event) => void updateClass({ data: { ...row, room: event.target.value } })}
                  />
                  <button
                    type="button"
                    aria-label="Delete class"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted hover:text-fg"
                    onClick={() =>
                      run(async () => {
                        await deleteClass({ data: row.id });
                        setClasses((rows) => rows.filter((item) => item.id !== row.id));
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </button>
                </Card>
              ))}
            </div>
          </div>
        ) : null}

        {!loading && tab === "assignments" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-3xl font-medium tracking-tight">Assignments</h2>
              <PrimaryButton
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const created = await addAssignment();
                    setAssignments((rows) => [
                      {
                        id: created.id,
                        title: "New assignment",
                        subject: "",
                        due: created.due,
                        done: false,
                      },
                      ...rows,
                    ]);
                  })
                }
              >
                <Plus className="mr-1 size-4" /> Add
              </PrimaryButton>
            </div>
            {assignments.length === 0 ? <p className="text-sm text-muted">Nothing assigned.</p> : null}
            {assignments.map((row) => (
              <Card
                key={row.id}
                className={`grid gap-2 sm:grid-cols-[auto_1fr_9rem_9rem_auto] sm:items-center ${pulseOn && row.done ? "opacity-60" : ""}`}
              >
                <button
                  type="button"
                  aria-label={row.done ? "Mark open" : "Mark done"}
                  onClick={() => {
                    const done = !row.done;
                    const next = { ...row, done };
                    setAssignments((rows) => rows.map((item) => (item.id === row.id ? next : item)));
                    if (done) keepMark("assignment_done", next.id, next.title);
                    else setMarks((rows) => rows.filter((item) => !(item.kind === "assignment_done" && item.refId === next.id)));
                    void updateAssignment({ data: next });
                  }}
                  className={`inline-flex size-11 items-center justify-center border ${
                    row.done ? "border-fg bg-fg text-bg" : "border-border text-transparent"
                  }`}
                >
                  ✓
                </button>
                <input
                  className={inputClass}
                  value={row.title}
                  onChange={(event) => {
                    const title = event.target.value;
                    setAssignments((rows) => rows.map((item) => (item.id === row.id ? { ...item, title } : item)));
                  }}
                  onBlur={(event) => void updateAssignment({ data: { ...row, title: event.target.value } })}
                />
                <input
                  className={inputClass}
                  placeholder="Subject"
                  value={row.subject}
                  onChange={(event) => {
                    const subject = event.target.value;
                    setAssignments((rows) => rows.map((item) => (item.id === row.id ? { ...item, subject } : item)));
                  }}
                  onBlur={(event) => void updateAssignment({ data: { ...row, subject: event.target.value } })}
                />
                <input
                  className={inputClass}
                  type="date"
                  value={row.due}
                  onChange={(event) => {
                    const due = event.target.value;
                    const next = { ...row, due };
                    setAssignments((rows) => rows.map((item) => (item.id === row.id ? next : item)));
                    void updateAssignment({ data: next });
                  }}
                />
                <button
                  type="button"
                  aria-label="Delete assignment"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted hover:text-fg"
                  onClick={() =>
                    run(async () => {
                      await deleteAssignment({ data: row.id });
                      setAssignments((rows) => rows.filter((item) => item.id !== row.id));
                    })
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              </Card>
            ))}
          </div>
        ) : null}

        {!loading && tab === "academics" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-3xl font-medium tracking-tight">Academics</h2>
                <p className="text-sm text-muted">VTU points. S is 10, then 9 down to F at 0.</p>
              </div>
              <div className="text-right">
                <div className="text-xs tracking-[0.16em] text-muted uppercase">CGPA</div>
                <div className="text-4xl font-medium tabular-nums tracking-tight">{score}</div>
              </div>
            </div>
            <Card className="space-y-3">
              <div className="text-xs tracking-[0.16em] text-muted uppercase">Import</div>
              <textarea
                className={`${inputClass} min-h-24 py-2`}
                placeholder="Paste a mark sheet or subject list, or upload a photo."
                value={academicsText}
                onChange={(event) => setAcademicsText(event.target.value)}
              />
              <input
                type="file"
                accept="image/*"
                className="block w-full text-sm text-muted"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  resizeImage(file)
                    .then(setAcademicsImage)
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : "Photo failed"));
                }}
              />
              {academicsImage ? <p className="text-sm text-muted">Photo ready.</p> : null}
              <div className="flex flex-wrap gap-2">
                <PrimaryButton
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const result = await importAcademics({
                        data: { text: academicsText, image: academicsImage, mode: "replace" },
                      });
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      await refresh();
                      setAcademicsText("");
                      setAcademicsImage(null);
                    })
                  }
                >
                  Extract and replace
                </PrimaryButton>
                <GhostButton
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const result = await importAcademics({
                        data: { text: academicsText, image: academicsImage, mode: "append" },
                      });
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      await refresh();
                    })
                  }
                >
                  Extract and add
                </GhostButton>
                {academicsImage ? <GhostButton onClick={() => setAcademicsImage(null)}>Clear photo</GhostButton> : null}
              </div>
            </Card>
            <PrimaryButton
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const created = await addCourse();
                  setCourses((rows) => [...rows, { id: created.id, name: "", credits: 4, grade: "A" }]);
                })
              }
            >
              <Plus className="mr-1 size-4" /> Add course
            </PrimaryButton>
            {courses.map((row) => (
              <Card key={row.id} className="grid gap-2 sm:grid-cols-[1fr_6rem_6rem_auto] sm:items-center">
                <input
                  className={inputClass}
                  placeholder="Course"
                  value={row.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setCourses((rows) => rows.map((item) => (item.id === row.id ? { ...item, name } : item)));
                  }}
                  onBlur={(event) => {
                    const name = event.target.value;
                    if (name.trim()) keepMark("grade_set", row.id, name);
                    void updateCourse({ data: { ...row, name } });
                  }}
                />
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  max={8}
                  value={row.credits}
                  onChange={(event) => {
                    const credits = Number(event.target.value);
                    setCourses((rows) => rows.map((item) => (item.id === row.id ? { ...item, credits } : item)));
                  }}
                  onBlur={(event) =>
                    void updateCourse({ data: { ...row, credits: Number(event.target.value) } })
                  }
                />
                <select
                  className={inputClass}
                  value={row.grade}
                  onChange={(event) => {
                    const grade = event.target.value;
                    const next = { ...row, grade };
                    setCourses((rows) => rows.map((item) => (item.id === row.id ? next : item)));
                    if (next.name.trim()) keepMark("grade_set", next.id, next.name);
                    void updateCourse({ data: next });
                  }}
                >
                  <option value="">—</option>
                  {GRADES.map((grade) => (
                    <option key={grade}>{grade}</option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Delete course"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted hover:text-fg"
                  onClick={() =>
                    run(async () => {
                      await deleteCourse({ data: row.id });
                      setCourses((rows) => rows.filter((item) => item.id !== row.id));
                    })
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              </Card>
            ))}
          </div>
        ) : null}

        {!loading && tab === "ai" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="space-y-3 lg:col-span-2">
              <div className="text-xs tracking-[0.16em] text-muted uppercase">Ask anything</div>
              <p className="text-sm text-muted">Attach a PDF, PowerPoint, Word file, text, or a photo.</p>
              <div className="h-72 space-y-3 overflow-y-auto border border-border bg-bg p-3 text-sm">
                {chat.length === 0 ? (
                  <p className="pt-16 text-center text-muted">Ask about algorithms, OS, DBMS, networks.</p>
                ) : (
                  chat.map((message) => (
                    <p
                      key={message.id}
                      className={`whitespace-pre-wrap ${message.role === "user" ? "text-muted" : "text-fg"}`}
                    >
                      {message.role === "user" ? "You" : "ATLAS"} — {visibleChat(message.content)}
                    </p>
                  ))
                )}
              </div>
              {chatFiles.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {chatFiles.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      className="inline-flex min-h-9 items-center gap-2 border border-border px-2 text-xs text-muted"
                      onClick={() => setChatFiles((rows) => rows.filter((item) => item.id !== file.id))}
                    >
                      {file.name}
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                type="file"
                multiple
                accept={FILE_ACCEPT}
                className="block w-full text-sm text-muted"
                onChange={(event) => {
                  const list = event.target.files;
                  event.target.value = "";
                  void run(() => addUploads(list, chatFiles, setChatFiles));
                }}
              />
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className={inputClass}
                  placeholder="Ask ATLAS"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void run(sendChat);
                  }}
                />
                <PrimaryButton disabled={busy} onClick={() => void run(sendChat)}>
                  Send
                </PrimaryButton>
                <GhostButton
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await clearChat();
                      setChat([]);
                    })
                  }
                >
                  Clear
                </GhostButton>
              </div>
            </Card>
            <Card className="space-y-3">
              <div className="text-xs tracking-[0.16em] text-muted uppercase">Notes</div>
              <textarea
                className={`${inputClass} min-h-32 py-2`}
                placeholder="Paste lecture notes, or attach the file"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
              {noteFiles.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {noteFiles.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      className="inline-flex min-h-9 items-center gap-2 border border-border px-2 text-xs text-muted"
                      onClick={() => setNoteFiles((rows) => rows.filter((item) => item.id !== file.id))}
                    >
                      {file.name}
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                type="file"
                multiple
                accept={FILE_ACCEPT}
                className="block w-full text-sm text-muted"
                onChange={(event) => {
                  const list = event.target.files;
                  event.target.value = "";
                  void run(() => addUploads(list, noteFiles, setNoteFiles));
                }}
              />
              <PrimaryButton
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const files = noteFiles.map(({ name, kind, text, mime, data }) => ({
                      name,
                      kind,
                      text,
                      mime,
                      data,
                    }));
                    const result = await summarizeNotes({ data: { notes, files } });
                    if (!result.ok) setError(result.error);
                    else setSummary(result.text);
                  })
                }
              >
                Summarize
              </PrimaryButton>
              {summary ? <p className="whitespace-pre-wrap text-sm text-fg">{summary}</p> : null}
            </Card>
            <Card className="space-y-3">
              <div className="text-xs tracking-[0.16em] text-muted uppercase">Study plan</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs tracking-[0.16em] text-muted uppercase">Days</span>
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={90}
                    value={planDays}
                    onChange={(event) => {
                      setPlanUntil("");
                      setPlanDays(Number(event.target.value));
                    }}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs tracking-[0.16em] text-muted uppercase">Or finish by</span>
                  <input
                    className={inputClass}
                    type="date"
                    value={planUntil}
                    onChange={(event) => {
                      const value = event.target.value;
                      setPlanUntil(value);
                      if (!value) return;
                      const left = daysUntil(value);
                      if (left < 1) {
                        setError("That date has already passed.");
                        return;
                      }
                      if (left > 90) {
                        setError("Keep the plan inside 90 days.");
                        return;
                      }
                      setError("");
                      setPlanDays(Math.min(90, left));
                    }}
                  />
                </label>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className={inputClass}
                  placeholder="Add a topic"
                  value={topicDraft}
                  onChange={(event) => setTopicDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addTopic();
                  }}
                />
                <GhostButton onClick={addTopic}>Add</GhostButton>
              </div>
              {topics.length > 0 ? (
                <div className="space-y-1">
                  {topics.map((topic, index) => (
                    <div key={`${topic}-${index}`} className="flex items-center justify-between gap-3 text-sm">
                      <span>
                        {index + 1}. {topic}
                      </span>
                      <button
                        type="button"
                        className="inline-flex min-h-9 items-center text-xs tracking-[0.12em] text-muted uppercase"
                        onClick={() => setTopics((rows) => rows.filter((_, item) => item !== index))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">Add the topics this plan has to cover.</p>
              )}
              <PrimaryButton
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await makeStudyPlan({ data: { days: planDays, until: planUntil, topics } });
                    if (!result.ok) setError(result.error);
                    else setPlan(result.text);
                  })
                }
              >
                Plan
              </PrimaryButton>
              {plan ? <p className="whitespace-pre-wrap text-sm text-fg">{plan}</p> : null}
            </Card>
          </div>
        ) : null}

        {!loading && tab === "settings" ? (
          <div className="max-w-xl space-y-4">
          <Card className="space-y-3">
            <h2 className="text-3xl font-medium tracking-tight">Your AI key</h2>
            <p className="text-sm text-muted">
              If you save a key, your chats bill that key. Clear it and ATLAS uses the shared key
              {sharedAvailable ? ", which is set." : ", which is not set yet."}
              {hasPersonal && personalHint ? ` Your key ends in ${personalHint}.` : ""}
            </p>
            <input
              className={inputClass}
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://openrouter.ai/api/v1"
            />
            <input
              className={inputClass}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="openai/gpt-4o-mini"
            />
            <input
              className={inputClass}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={hasPersonal ? "Paste a new key to replace it" : "Paste your key"}
              autoComplete="off"
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(event) => setClearKey(event.target.checked)}
              />
              Clear my key and use the shared one
            </label>
            <PrimaryButton
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await saveAiPrefs({
                    data: { endpoint, model, apiKey, clearKey },
                  });
                  if (!result.ok) return;
                  setHasPersonal(result.hasPersonal);
                  setPersonalHint(result.personalHint);
                  setApiKey("");
                  setClearKey(false);
                })
              }
            >
              Save
            </PrimaryButton>
          </Card>
          <Card className="space-y-3">
            <h2 className="text-3xl font-medium tracking-tight">PULSE</h2>
            <p className="text-sm text-muted">
              A quiet record of finished work, recorded focus, and anything still unfinished. Turning it off only hides that layer.
            </p>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={pulseOn}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setPulseOn(enabled);
                  void setPulseEnabled({ data: enabled });
                }}
              />
              Show PULSE
            </label>
          </Card>
          </div>
        ) : null}
      </main>
      <FocusDock
        courses={courses}
        assignments={assignments}
        active={focusActive}
        recent={focusRecent}
        onChange={() => {
          refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load"));
        }}
      />
    </div>
  );
}
