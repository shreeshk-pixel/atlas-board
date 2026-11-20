import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { hashPassword } from "better-auth/crypto";
import { auth } from "@/lib/auth/server";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { loginEnabled } from "./gate";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const GRADES = ["S", "A", "B", "C", "D", "E", "F"] as const;
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

type Role = "cadet" | "admin";

function fail(error: string) {
  return { ok: false as const, error };
}

function normalizeName(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function displayNameOf(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

function validName(raw: string) {
  const display = displayNameOf(raw);
  if (display.length < 2 || display.length > 40) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(display)) return null;
  return display;
}

function validPassword(password: string) {
  return password.length >= 8 && password.length <= 72;
}

function internalEmail(username: string) {
  const local = Buffer.from(username, "utf8").toString("base64url").toLowerCase();
  return `${local}@cadet.atlas.app`;
}

function on(value: unknown) {
  return value === true || value === 1 || value === "t" || value === "true";
}

function cleanEndpoint(raw: string) {
  const endpoint = raw.trim().replace(/\/$/, "");
  if (!endpoint.startsWith("https://") || endpoint.length > 200) return null;
  return endpoint;
}

function cleanModel(raw: string) {
  const model = raw.trim();
  if (!model || model.length > 80) return null;
  return model;
}

function hint(key: string | null | undefined) {
  if (!key) return null;
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

function kolkataDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function cleanAsk(input: { refKey?: string; label?: string; tab?: string }) {
  const refKey = (input.refKey ?? "").trim().slice(0, 80);
  const label = (input.label ?? "").trim().slice(0, 120);
  const tab = input.tab ?? "";
  if (!refKey || !label) return null;
  if (tab !== "timetable" && tab !== "assignments" && tab !== "academics") return null;
  return { refKey, label, tab };
}

function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function remember(
  sql: Sql,
  userId: string,
  kind: "assignment_done" | "grade_set" | "focus",
  refId: string,
  label: string,
  subject: string,
) {
  const clean = label.trim().slice(0, 120);
  if (!clean || clean === "New assignment") return;
  await sql`
    insert into pulse_events (id, user_id, kind, ref_id, label, subject)
    values (${crypto.randomUUID()}, ${userId}, ${kind}, ${refId}, ${clean}, ${subject.trim().slice(0, 80)})
    on conflict (user_id, kind, ref_id) do update
    set label = excluded.label, subject = excluded.subject
  `;
}

function iso(value: unknown) {
  const ms = epoch(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function epoch(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type Study = { goal: string; tried: boolean; gap: boolean; again: boolean };

function parseStudy(raw: unknown): Study {
  const empty = { goal: "", tried: false, gap: false, again: false };
  if (typeof raw !== "string" || !raw) return empty;
  try {
    const value = JSON.parse(raw) as Partial<Study>;
    return {
      goal: String(value.goal ?? "").slice(0, 160),
      tried: value.tried === true,
      gap: value.gap === true,
      again: value.again === true,
    };
  } catch {
    return empty;
  }
}

function packStudy(study: Study) {
  return JSON.stringify({
    goal: study.goal.trim().slice(0, 160),
    tried: study.tried === true,
    gap: study.gap === true,
    again: study.again === true,
  });
}

type FocusRow = {
  id: string;
  preset: string;
  focus_min: number;
  break_min: number;
  course_id: string | null;
  assignment_id: string | null;
  objective: string;
  label: string;
  subject_key: string;
  phase: string;
  status: string;
  phase_ends_at: unknown;
  remaining_ms: number | null;
  focus_ms: number;
  auto_break: boolean;
  study: string;
};

function mapActive(row: FocusRow | undefined) {
  if (!row || (row.status !== "running" && row.status !== "paused")) return null;
  return {
    id: row.id,
    preset: row.preset,
    focusMin: Number(row.focus_min),
    breakMin: Number(row.break_min),
    courseId: row.course_id,
    assignmentId: row.assignment_id,
    objective: row.objective,
    label: row.label,
    phase: row.phase === "break" ? ("break" as const) : ("focus" as const),
    status: row.status === "paused" ? ("paused" as const) : ("running" as const),
    phaseEndsAt: epoch(row.phase_ends_at),
    remainingMs: row.remaining_ms == null ? null : Number(row.remaining_ms),
    focusMs: Number(row.focus_ms),
    autoBreak: on(row.auto_break),
    ...parseStudy(row.study),
  };
}

async function activeFocus(sql: Sql, userId: string) {
  const rows = await sql<FocusRow>`
    select id, preset, focus_min, break_min, course_id, assignment_id, objective, label, subject_key,
           phase, status, phase_ends_at, remaining_ms, focus_ms, auto_break, study
    from focus_sessions
    where user_id = ${userId} and status in ('running', 'paused')
    limit 1
  `;
  return rows[0] ?? null;
}

async function settleFocus(sql: Sql, userId: string) {
  const row = await activeFocus(sql, userId);
  if (!row || row.status !== "running") return row;
  const ends = epoch(row.phase_ends_at);
  if (ends == null || ends > Date.now()) return row;
  const now = Date.now();
  if (row.phase === "focus") {
    const focusMs = Number(row.focus_ms) + Number(row.focus_min) * 60000;
    await remember(sql, userId, "focus", row.id, row.label || "Focus", row.subject_key || row.label);
    if (!on(row.auto_break)) {
      await sql`
        update focus_sessions
        set focus_ms = ${focusMs}, phase = 'break', status = 'paused',
            remaining_ms = ${Number(row.break_min) * 60000}, phase_ends_at = null
        where id = ${row.id}
      `;
      return activeFocus(sql, userId);
    }
    const breakEnds = ends + Number(row.break_min) * 60000;
    if (breakEnds <= now) {
      await sql`
        update focus_sessions
        set focus_ms = ${focusMs}, status = 'completed', phase = 'break',
            phase_ends_at = null, remaining_ms = null, ended_at = ${new Date(breakEnds).toISOString()}
        where id = ${row.id}
      `;
      return null;
    }
    await sql`
      update focus_sessions
      set focus_ms = ${focusMs}, phase = 'break', status = 'running', remaining_ms = null,
          phase_ends_at = ${new Date(breakEnds).toISOString()}
      where id = ${row.id}
    `;
    return activeFocus(sql, userId);
  }
  await sql`
    update focus_sessions
    set status = 'completed', phase_ends_at = null, remaining_ms = null,
        ended_at = ${new Date(ends).toISOString()}
    where id = ${row.id}
  `;
  return null;
}

async function focusBundle(sql: Sql, userId: string) {
  const active = mapActive((await settleFocus(sql, userId)) ?? undefined);
  const recent = await sql<{
    id: string;
    label: string;
    subject_key: string;
    focus_ms: number;
    status: string;
    preset: string;
    started_at: unknown;
    ended_at: unknown;
    study: string;
  }>`
    select id, label, subject_key, focus_ms, status, preset, started_at, ended_at, study
    from focus_sessions
    where user_id = ${userId} and status in ('completed', 'interrupted', 'cancelled')
    order by ended_at desc nulls last
    limit 12
  `;
  const totals = await sql<{ label: string; focus_ms: number }>`
    select subject_key as label, sum(focus_ms) as focus_ms
    from focus_sessions
    where user_id = ${userId} and focus_ms > 0 and subject_key <> ''
    group by subject_key
    order by sum(focus_ms) desc
    limit 6
  `;
  return {
    active,
    recent: recent.map((row) => ({
      id: row.id,
      label: row.label,
      subject: row.subject_key,
      focusMs: Number(row.focus_ms),
      status: row.status,
      preset: row.preset,
      startedAt: iso(row.started_at),
      endedAt: iso(row.ended_at),
      goal: parseStudy(row.study).goal,
    })),
    totals: totals.map((row) => ({ label: row.label, focusMs: Number(row.focus_ms) })),
  };
}

async function profileOf(sql: Sql, userId: string) {
  const rows = await sql<{
    role: string;
    disabled: boolean;
    display_name: string;
    username: string;
  }>`select role, disabled, display_name, username from profiles where user_id = ${userId}`;
  return rows[0] ?? null;
}

const LOCAL_CADET_ID = "local-cadet";

async function ensureLocalCadet() {
  const sql = await getSql();
  await sql`
    insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    values (${LOCAL_CADET_ID}, 'Local', 'local@cadet.atlas.app', true, now(), now())
    on conflict ("id") do nothing
  `;
  await sql`
    insert into profiles (user_id, username, display_name, role)
    values (${LOCAL_CADET_ID}, 'local-board', 'Local', 'cadet')
    on conflict (user_id) do nothing
  `;
  return LOCAL_CADET_ID;
}

const cadetGate = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    let bearerToken: string | undefined;
    if (loginEnabled) {
      const { getBearerToken } = await import("@/lib/auth/client");
      bearerToken = getBearerToken() ?? undefined;
    }
    return next({ sendContext: { bearerToken } });
  })
  .server(async ({ next, context }) => {
    if (!loginEnabled) {
      return next({ context: { userId: await ensureLocalCadet() } });
    }
    const { assertSameSiteRequest } = await import("@/lib/auth/isolation.server");
    const { requireUserId } = await import("@/lib/auth/verify.server");
    assertSameSiteRequest();
    return next({ context: { userId: await requireUserId(context.bearerToken) } });
  });

async function requireRole(userId: string, role: Role) {
  const sql = await getSql();
  const profile = await profileOf(sql, userId);
  if (!profile || profile.role !== role || on(profile.disabled)) {
    throw new Error("Unauthorized");
  }
  return { sql, profile };
}

export const adminExists = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await getSql();
  const rows = await sql<{ n: number }>`select count(*) as n from profiles where role = 'admin'`;
  return { exists: Number(rows[0]?.n ?? 0) > 0 };
});

export const getAccess = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const profile = await profileOf(sql, context.userId);
    if (!profile) return { kind: "unlisted" as const };
    if (on(profile.disabled)) {
      return { kind: "disabled" as const, displayName: profile.display_name };
    }
    if (profile.role === "admin") {
      return {
        kind: "admin" as const,
        displayName: profile.display_name,
        username: profile.username,
      };
    }
    return {
      kind: "cadet" as const,
      displayName: profile.display_name,
      username: profile.username,
    };
  });

export const resolveLogin = createServerFn({ method: "POST" })
  .validator((input: { name: string; portal: "cadet" | "admin" }) => input)
  .handler(async ({ data }) => {
    const display = validName(data?.name ?? "");
    if (!display) return fail("Enter the name you signed up with.");
    const username = normalizeName(display);
    const portal = data.portal === "admin" ? "admin" : "cadet";
    const sql = await getSql();
    const rows = await sql<{ role: string; disabled: boolean; email: string }>`
      select p.role, p.disabled, u.email
      from profiles p
      join "user" u on u.id = p.user_id
      where p.username = ${username}
    `;
    const row = rows[0];
    if (!row) return fail("No account with that name.");
    if (on(row.disabled)) return fail("This account is disabled.");
    if (portal === "cadet" && row.role !== "cadet") {
      return fail("That login is for the admin site, not the app.");
    }
    if (portal === "admin" && row.role !== "admin") {
      return fail("Normal accounts stay in the app. This site is admin only.");
    }
    return { ok: true as const, email: row.email };
  });

export const registerCadet = createServerFn({ method: "POST" })
  .validator(
    (input: { name: string; password: string; confirm: string; invite: string }) => input,
  )
  .handler(async ({ data }) => {
    const display = validName(data?.name ?? "");
    if (!display) return fail("Name needs 2–40 letters, and can include spaces.");
    if (!validPassword(data?.password ?? "")) return fail("Password needs 8 to 72 characters.");
    if (data.password !== data.confirm) return fail("Passwords do not match.");
    const code = (data.invite ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6,16}$/.test(code)) return fail("Enter the invite code from the admin.");
    const username = normalizeName(display);
    const sql = await getSql();
    const taken = await sql<{ user_id: string }>`select user_id from profiles where username = ${username}`;
    if (taken[0]) return fail("That name is already taken.");
    const invites = await sql<{ id: string }>`
      select id from invites
      where code = ${code} and used_by is null and revoked = false
    `;
    const invite = invites[0];
    if (!invite) return fail("That invite code is used, revoked, or not real.");

    let userId = "";
    try {
      const created = await auth.api.signUpEmail({
        body: { email: internalEmail(username), password: data.password, name: display },
      });
      userId = created?.user?.id ?? "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/exist/i.test(message)) return fail("That name is already taken.");
      return fail("Could not create the account. Try a different name.");
    }
    if (!userId) return fail("Could not create the account.");

    try {
      await sql`
        insert into profiles (user_id, username, display_name, role)
        values (${userId}, ${username}, ${display}, 'cadet')
      `;
      const claimed = await sql<{ id: string }>`
        update invites
        set used_by = ${userId}, used_name = ${display}, used_at = now()
        where id = ${invite.id} and used_by is null and revoked = false
        returning id
      `;
      if (!claimed[0]) {
        await sql`delete from "user" where id = ${userId}`;
        return fail("That invite was just used. Ask the admin for another.");
      }
    } catch {
      await sql`delete from "user" where id = ${userId}`;
      return fail("Could not finish signup. The invite was not used.");
    }
    return { ok: true as const, email: internalEmail(username) };
  });

export const createAdmin = createServerFn({ method: "POST" })
  .validator((input: { name: string; password: string; confirm: string }) => input)
  .handler(async ({ data }) => {
    const display = validName(data?.name ?? "");
    if (!display) return fail("Name needs 2–40 letters.");
    if (!validPassword(data?.password ?? "")) return fail("Password needs 8 to 72 characters.");
    if (data.password !== data.confirm) return fail("Passwords do not match.");
    const username = normalizeName(display);
    const sql = await getSql();
    const existing = await sql<{ n: number }>`select count(*) as n from profiles where role = 'admin'`;
    if (Number(existing[0]?.n ?? 0) > 0) return fail("An admin login already exists.");
    const taken = await sql`select user_id from profiles where username = ${username}`;
    if (taken[0]) return fail("That name is already taken.");

    let userId = "";
    try {
      const created = await auth.api.signUpEmail({
        body: { email: internalEmail(username), password: data.password, name: display },
      });
      userId = created?.user?.id ?? "";
    } catch {
      return fail("Could not create the admin login.");
    }
    if (!userId) return fail("Could not create the admin login.");
    try {
      await sql`
        insert into profiles (user_id, username, display_name, role)
        values (${userId}, ${username}, ${display}, 'admin')
      `;
    } catch {
      await sql`delete from "user" where id = ${userId}`;
      return fail("An admin login already exists.");
    }
    return { ok: true as const, email: internalEmail(username) };
  });

export const loadBoard = createServerFn({ method: "GET" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const classes = await sql<{
      id: string;
      day: string;
      time: string;
      subject: string;
      room: string;
    }>`
      select id, day, time, subject, room from classes
      where user_id = ${context.userId}
      order by case day
        when 'Mon' then 1 when 'Tue' then 2 when 'Wed' then 3
        when 'Thu' then 4 when 'Fri' then 5 when 'Sat' then 6 else 7 end,
        time, position
    `;
    const assignments = await sql<{
      id: string;
      title: string;
      subject: string;
      due: string;
      done: boolean;
    }>`
      select id, title, subject, due, done from assignments
      where user_id = ${context.userId}
      order by done, due
    `;
    const courses = await sql<{
      id: string;
      name: string;
      credits: number;
      grade: string;
    }>`
      select id, name, credits, grade from courses
      where user_id = ${context.userId}
      order by name
    `;
    const chat = await sql<{ id: string; role: string; content: string }>`
      select id, role, content from chats
      where user_id = ${context.userId}
      order by created_at
      limit 80
    `;
    const prefs = await sql<{ endpoint: string; model: string; api_key: string | null }>`
      select endpoint, model, api_key from ai_prefs where user_id = ${context.userId}
    `;
    const shared = await sql<{ api_key: string | null }>`
      select api_key from shared_ai where id = 'shared'
    `;
    const today = kolkataDay();
    const skipped = await sql<{ day: string; label: string; tab: string }>`
      select day, label, tab from asks
      where user_id = ${context.userId} and opened = false and day < ${today}
      order by day desc
      limit 1
    `;
    for (const row of assignments) {
      if (!on(row.done)) continue;
      await remember(sql, context.userId, "assignment_done", row.id, row.title, row.subject);
    }
    for (const row of courses) {
      if (!row.name.trim() || !GRADES.includes(row.grade as (typeof GRADES)[number])) continue;
      await remember(sql, context.userId, "grade_set", row.id, row.name, row.name);
    }
    const events = await sql<{ kind: string; ref_id: string; label: string }>`
      select kind, ref_id, label from pulse_events
      where user_id = ${context.userId}
      order by at asc
    `;
    const doneIds = new Set(assignments.filter((row) => on(row.done)).map((row) => row.id));
    const courseIds = new Set(
      courses
        .filter((row) => row.name.trim() && GRADES.includes(row.grade as (typeof GRADES)[number]))
        .map((row) => row.id),
    );
    const pref = await sql<{ enabled: boolean }>`
      select enabled from pulse_prefs where user_id = ${context.userId}
    `;
    return {
      classes,
      assignments: assignments.map((row) => ({ ...row, done: on(row.done) })),
      courses: courses.map((row) => ({ ...row, credits: Number(row.credits) })),
      chat: chat.filter((row) => row.role === "user" || row.role === "assistant"),
      skipped: skipped[0] ? { ...skipped[0], opened: false } : null,
      pulse: {
        enabled: pref[0] ? on(pref[0].enabled) : true,
        marks: events
          .filter((row) =>
            row.kind === "focus" ||
            (row.kind === "assignment_done" ? doneIds.has(row.ref_id) : row.kind === "grade_set" && courseIds.has(row.ref_id)),
          )
          .map((row) => ({ refId: row.ref_id, kind: row.kind, label: row.label })),
      },
      ai: {
        endpoint: prefs[0]?.endpoint ?? DEFAULT_ENDPOINT,
        model: prefs[0]?.model ?? DEFAULT_MODEL,
        hasPersonal: Boolean(prefs[0]?.api_key),
        personalHint: hint(prefs[0]?.api_key),
        sharedAvailable: Boolean(shared[0]?.api_key),
      },
      focus: await focusBundle(sql, context.userId),
    };
  });

export const noteAsk = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((input: { refKey: string; label: string; tab: string }) => input)
  .handler(async ({ context, data }) => {
    const ask = cleanAsk(data ?? {});
    if (!ask) return { ok: false as const };
    const { sql } = await requireRole(context.userId, "cadet");
    const day = kolkataDay();
    await sql`
      insert into asks (user_id, day, ref_key, label, tab, opened)
      values (${context.userId}, ${day}, ${ask.refKey}, ${ask.label}, ${ask.tab}, false)
      on conflict (user_id, day) do update
      set ref_key = excluded.ref_key, label = excluded.label, tab = excluded.tab
      where asks.opened = false
    `;
    return { ok: true as const };
  });

export const markAskOpened = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((input: { tab: string }) => input)
  .handler(async ({ context, data }) => {
    const tab = data?.tab ?? "";
    if (tab !== "timetable" && tab !== "assignments" && tab !== "academics") return { ok: true as const };
    const { sql } = await requireRole(context.userId, "cadet");
    await sql`
      update asks set opened = true
      where user_id = ${context.userId} and opened = false and tab = ${tab}
    `;
    return { ok: true as const };
  });

export const setPulseEnabled = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((enabled: boolean) => enabled === true)
  .handler(async ({ context, data: enabled }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    await sql`
      insert into pulse_prefs (user_id, enabled)
      values (${context.userId}, ${enabled})
      on conflict (user_id) do update set enabled = ${enabled}
    `;
    return { ok: true as const };
  });

export const addClass = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const id = crypto.randomUUID();
    await sql`
      insert into classes (id, user_id, day, time, subject, room, position)
      values (${id}, ${context.userId}, 'Mon', '09:00', '', '', 0)
    `;
    return { id };
  });

export const updateClass = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator(
    (input: { id: string; day: string; time: string; subject: string; room: string }) => input,
  )
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const day = DAYS.includes(data.day as (typeof DAYS)[number]) ? data.day : "Mon";
    const time = /^\d{2}:\d{2}$/.test(data.time) ? data.time : "09:00";
    const subject = (data.subject ?? "").slice(0, 80);
    const room = (data.room ?? "").slice(0, 40);
    await sql`
      update classes
      set day = ${day}, time = ${time}, subject = ${subject}, room = ${room}
      where id = ${data.id} and user_id = ${context.userId}
    `;
    return { ok: true as const };
  });

export const deleteClass = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    await sql`delete from classes where id = ${id} and user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const replaceClasses = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator(
    (input: {
      mode: "replace" | "append";
      rows: { day: string; time: string; subject: string; room: string }[];
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const rows = (data.rows ?? [])
      .map((row) => ({
        day: DAYS.includes(row.day as (typeof DAYS)[number]) ? row.day : "Mon",
        time: /^\d{2}:\d{2}$/.test(row.time) ? row.time : "09:00",
        subject: (row.subject ?? "").trim().slice(0, 80),
        room: (row.room ?? "").trim().slice(0, 40),
      }))
      .filter((row) => row.subject);
    if (data.mode === "replace") {
      await sql`delete from classes where user_id = ${context.userId}`;
    }
    for (const [index, row] of rows.entries()) {
      await sql`
        insert into classes (id, user_id, day, time, subject, room, position)
        values (${crypto.randomUUID()}, ${context.userId}, ${row.day}, ${row.time}, ${row.subject}, ${row.room}, ${index})
      `;
    }
    return { ok: true as const, count: rows.length };
  });

export const addAssignment = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const id = crypto.randomUUID();
    const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    await sql`
      insert into assignments (id, user_id, title, subject, due, done)
      values (${id}, ${context.userId}, 'New assignment', '', ${due}, false)
    `;
    return { id, due };
  });

export const updateAssignment = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator(
    (input: { id: string; title: string; subject: string; due: string; done: boolean }) => input,
  )
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const due = /^\d{4}-\d{2}-\d{2}$/.test(data.due) ? data.due : new Date().toISOString().slice(0, 10);
    await sql`
      update assignments
      set title = ${(data.title ?? "").slice(0, 120)},
          subject = ${(data.subject ?? "").slice(0, 80)},
          due = ${due},
          done = ${Boolean(data.done)}
      where id = ${data.id} and user_id = ${context.userId}
    `;
    if (data.done) {
      await remember(sql, context.userId, "assignment_done", data.id, data.title ?? "", data.subject ?? "");
    }
    return { ok: true as const };
  });

export const deleteAssignment = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    await sql`delete from assignments where id = ${id} and user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const addCourse = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const id = crypto.randomUUID();
    await sql`
      insert into courses (id, user_id, name, credits, grade)
      values (${id}, ${context.userId}, '', 4, 'A')
    `;
    return { id };
  });

export const updateCourse = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((input: { id: string; name: string; credits: number; grade: string }) => input)
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const credits = Math.min(8, Math.max(1, Math.round(Number(data.credits) || 1)));
    const grade = data.grade === "" ? "" : GRADES.includes(data.grade as (typeof GRADES)[number]) ? data.grade : "A";
    await sql`
      update courses
      set name = ${(data.name ?? "").slice(0, 80)}, credits = ${credits}, grade = ${grade}
      where id = ${data.id} and user_id = ${context.userId}
    `;
    if ((data.name ?? "").trim() && grade) {
      await remember(sql, context.userId, "grade_set", data.id, data.name ?? "", data.name ?? "");
    }
    return { ok: true as const };
  });

export const deleteCourse = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    await sql`delete from courses where id = ${id} and user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const saveAiPrefs = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator(
    (input: { endpoint: string; model: string; apiKey: string; clearKey: boolean }) => input,
  )
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const endpoint = cleanEndpoint(data.endpoint) ?? DEFAULT_ENDPOINT;
    const model = cleanModel(data.model) ?? DEFAULT_MODEL;
    const current = await sql<{ api_key: string | null }>`
      select api_key from ai_prefs where user_id = ${context.userId}
    `;
    let apiKey = current[0]?.api_key ?? null;
    if (data.clearKey) apiKey = null;
    else if ((data.apiKey ?? "").trim()) apiKey = data.apiKey.trim();
    await sql`
      insert into ai_prefs (user_id, endpoint, model, api_key)
      values (${context.userId}, ${endpoint}, ${model}, ${apiKey})
      on conflict (user_id) do update
      set endpoint = excluded.endpoint, model = excluded.model, api_key = excluded.api_key
    `;
    return { ok: true as const, hasPersonal: Boolean(apiKey), personalHint: hint(apiKey) };
  });

async function resolveCreds(sql: Sql, userId: string) {
  const prefs = await sql<{ endpoint: string; model: string; api_key: string | null }>`
    select endpoint, model, api_key from ai_prefs where user_id = ${userId}
  `;
  if (prefs[0]?.api_key) {
    return {
      endpoint: prefs[0].endpoint,
      model: prefs[0].model,
      apiKey: prefs[0].api_key,
      source: "personal" as const,
    };
  }
  const shared = await sql<{ endpoint: string; model: string; api_key: string | null }>`
    select endpoint, model, api_key from shared_ai where id = 'shared'
  `;
  if (shared[0]?.api_key) {
    return {
      endpoint: shared[0].endpoint,
      model: shared[0].model,
      apiKey: shared[0].api_key,
      source: "shared" as const,
    };
  }
  return null;
}

async function callLLM(
  sql: Sql,
  userId: string,
  messages: { role: string; content: unknown }[],
  temperature: number,
  maxTokens: number,
) {
  const creds = await resolveCreds(sql, userId);
  if (!creds) {
    return fail("No AI key. Add yours in Settings, or ask the admin to set the shared key.");
  }
  let response: Response;
  try {
    response = await fetch(`${creds.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
        "HTTP-Referer": "https://atlas.app",
        "X-Title": "ATLAS",
      },
      body: JSON.stringify({
        model: creds.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });
  } catch {
    return fail("Could not reach the AI provider.");
  }
  if (!response.ok) {
    const text = await response.text();
    return fail(`AI error: ${text.slice(0, 240)}`);
  }
  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) return fail("The model returned nothing.");
  return { ok: true as const, text: String(text), source: creds.source };
}

export const askAtlas = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((input: { prompt: string }) => input)
  .handler(async ({ context, data }) => {
    const prompt = (data.prompt ?? "").trim();
    if (!prompt) return fail("Type a question first.");
    if (prompt.length > 4000) return fail("That question is too long.");
    const { sql } = await requireRole(context.userId, "cadet");
    const history = await sql<{ role: string; content: string }>`
      select role, content from chats
      where user_id = ${context.userId}
      order by created_at desc
      limit 20
    `;
    const userId = crypto.randomUUID();
    await sql`
      insert into chats (id, user_id, role, content)
      values (${userId}, ${context.userId}, 'user', ${prompt})
    `;
    const result = await callLLM(
      sql,
      context.userId,
      [
        {
          role: "system",
          content:
            "You are ATLAS, mission control for an Information Science & Engineering student. Answer clearly, with examples and short exam tips when they help. Be direct.",
        },
        ...history.reverse().map((row) => ({ role: row.role, content: row.content })),
        { role: "user", content: prompt },
      ],
      0.4,
      800,
    );
    if (!result.ok) {
      await sql`delete from chats where id = ${userId} and user_id = ${context.userId}`;
      return result;
    }
    const assistantId = crypto.randomUUID();
    await sql`
      insert into chats (id, user_id, role, content)
      values (${assistantId}, ${context.userId}, 'assistant', ${result.text})
    `;
    return { ok: true as const, reply: result.text, source: result.source };
  });

export const clearChat = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    await sql`delete from chats where user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const summarizeNotes = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((notes: string) => notes)
  .handler(async ({ context, data: notes }) => {
    const text = (notes ?? "").trim();
    if (!text) return fail("Paste some notes first.");
    if (text.length > 12000) return fail("Those notes are too long. Split them.");
    const { sql } = await requireRole(context.userId, "cadet");
    const result = await callLLM(
      sql,
      context.userId,
      [
        {
          role: "system",
          content:
            "Summarize engineering lecture notes into key points, formulas, and exam-relevant concepts. Use short sections. No fluff.",
        },
        { role: "user", content: text },
      ],
      0.3,
      800,
    );
    if (!result.ok) return result;
    return { ok: true as const, text: result.text, source: result.source };
  });

export const makeStudyPlan = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((goal: string) => goal)
  .handler(async ({ context, data: goal }) => {
    const text = (goal ?? "").trim();
    if (!text) return fail("Say what you need to finish.");
    const { sql } = await requireRole(context.userId, "cadet");
    const subjects = await sql<{ subject: string }>`
      select subject from classes where user_id = ${context.userId} and subject <> ''
    `;
    const names = [...new Set(subjects.map((row) => row.subject))].slice(0, 12);
    const result = await callLLM(
      sql,
      context.userId,
      [
        {
          role: "system",
          content:
            "Write a realistic 7-day study plan for an ISE student. Daily targets, specific topics, one revision slot. Tight and actionable.",
        },
        {
          role: "user",
          content: `Goal: ${text.slice(0, 500)}. Subjects on the timetable: ${names.join(", ") || "not set yet"}.`,
        },
      ],
      0.4,
      900,
    );
    if (!result.ok) return result;
    return { ok: true as const, text: result.text, source: result.source };
  });

function normalizeDay(raw: string) {
  const s = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    mon: "Mon",
    monday: "Mon",
    tue: "Tue",
    tues: "Tue",
    tuesday: "Tue",
    wed: "Wed",
    wednesday: "Wed",
    thu: "Thu",
    thur: "Thu",
    thurs: "Thu",
    thursday: "Thu",
    fri: "Fri",
    friday: "Fri",
    sat: "Sat",
    saturday: "Sat",
  };
  return map[s] || map[s.slice(0, 3)] || "Mon";
}

function normalizeTime(raw: string) {
  const s = raw.trim().toLowerCase();
  const ranged = s.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/);
  if (ranged) {
    let h = parseInt(ranged[1], 10);
    const min = ranged[2];
    if (ranged[3] === "pm" && h < 12) h += 12;
    if (ranged[3] === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${min}`;
  }
  const hourOnly = s.match(/(\d{1,2})\s*(am|pm)/);
  if (hourOnly) {
    let h = parseInt(hourOnly[1], 10);
    if (hourOnly[2] === "pm" && h < 12) h += 12;
    if (hourOnly[2] === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:00`;
  }
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  return "09:00";
}

export const importTimetable = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((input: { text: string; image: string | null; mode: "replace" | "append" }) => input)
  .handler(async ({ context, data }) => {
    const text = (data.text ?? "").trim();
    const image = data.image ?? null;
    if (!text && !image) return fail("Paste the timetable or upload a photo.");
    if (text.length > 20000) return fail("That text is too long.");
    if (image && image.length > 2_000_000) return fail("That photo is too large. Crop it and try again.");
    if (image && !image.startsWith("data:image/")) return fail("Upload a photo, not another file.");
    const { sql } = await requireRole(context.userId, "cadet");
    const instruction = `Extract every scheduled class from this college timetable.
Return ONLY a JSON array. No markdown.
Schema: [{"day":"Mon","time":"09:00","subject":"DBMS","room":"LH-01"}]
day must be Mon, Tue, Wed, Thu, Fri, or Sat.
time is the start time in 24-hour HH:MM.
Skip lunch, break, free, and empty slots.
If room is missing, use an empty string.
Keep the subject name exactly as written.`;
    const content = image
      ? [
          { type: "text", text: instruction + (text ? `\n\nExtra text:\n${text}` : "") },
          { type: "image_url", image_url: { url: image } },
        ]
      : `${instruction}\n\nTimetable text:\n${text}`;
    const result = await callLLM(sql, context.userId, [{ role: "user", content }], 0, 2000);
    if (!result.ok) return result;
    const raw = result.text.replace(/```json|```/g, "").trim();
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end < start) return fail("Could not read classes from the response.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return fail("Could not read classes from the response.");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return fail("No classes found.");
    const rows = parsed
      .map((item) => {
        const row = item as { day?: string; time?: string; subject?: string; room?: string };
        return {
          day: normalizeDay(String(row.day ?? "Mon")),
          time: normalizeTime(String(row.time ?? "09:00")),
          subject: String(row.subject ?? "").trim().slice(0, 80),
          room: String(row.room ?? "").trim().slice(0, 40),
        };
      })
      .filter((row) => row.subject)
      .slice(0, 80);
    if (rows.length === 0) return fail("No named classes found.");
    if (data.mode === "replace") {
      await sql`delete from classes where user_id = ${context.userId}`;
    }
    for (const [index, row] of rows.entries()) {
      await sql`
        insert into classes (id, user_id, day, time, subject, room, position)
        values (${crypto.randomUUID()}, ${context.userId}, ${row.day}, ${row.time}, ${row.subject}, ${row.room}, ${index})
      `;
    }
    return { ok: true as const, count: rows.length, source: result.source };
  });

function letterGrade(raw: string) {
  const value = raw.trim().toUpperCase();
  const map: Record<string, string> = { "10": "S", "9": "A", "8": "B", "7": "C", "6": "D", "5": "E", "4": "F", O: "S" };
  const grade = map[value] || value;
  return GRADES.includes(grade as (typeof GRADES)[number]) ? grade : "";
}

export const importAcademics = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((input: { text: string; image: string | null; mode: "replace" | "append" }) => input)
  .handler(async ({ context, data }) => {
    const text = (data.text ?? "").trim();
    const image = data.image ?? null;
    if (!text && !image) return fail("Paste the mark list or upload a photo.");
    if (text.length > 20000) return fail("That text is too long.");
    if (image && image.length > 2_000_000) return fail("That photo is too large. Crop it and try again.");
    if (image && !image.startsWith("data:image/")) return fail("Upload a photo, not another file.");
    const { sql } = await requireRole(context.userId, "cadet");
    const instruction = `Extract courses from this college mark sheet or subject list.
Return ONLY a JSON array. No markdown.
Schema: [{"name":"Database Management Systems","credits":4,"grade":"A"}]
grade is one of S, A, B, C, D, E, F. S means 10 points. If the sheet shows a number, use 10=S, 9=A, 8=B, 7=C, 6=D, 5=E, below 5=F.
If there is no grade yet, use an empty string. Do not guess a grade.
credits is an integer from 1 to 8. If missing, use 4.
Keep the course name as written. Skip empty rows, totals, SGPA, and CGPA lines.`;
    const content = image
      ? [
          { type: "text", text: instruction + (text ? `\n\nExtra text:\n${text}` : "") },
          { type: "image_url", image_url: { url: image } },
        ]
      : `${instruction}\n\nMark list:\n${text}`;
    const result = await callLLM(sql, context.userId, [{ role: "user", content }], 0, 2000);
    if (!result.ok) return result;
    const raw = result.text.replace(/```json|```/g, "").trim();
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end < start) return fail("Could not read courses from the response.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return fail("Could not read courses from the response.");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return fail("No courses found.");
    const rows = parsed
      .map((item) => {
        const row = item as { name?: string; credits?: number; grade?: string };
        const credits = Math.min(8, Math.max(1, Math.round(Number(row.credits) || 4)));
        return {
          name: String(row.name ?? "").trim().slice(0, 80),
          credits,
          grade: letterGrade(String(row.grade ?? "")),
        };
      })
      .filter((row) => row.name)
      .slice(0, 40);
    if (rows.length === 0) return fail("No named courses found.");
    if (data.mode === "replace") await sql`delete from courses where user_id = ${context.userId}`;
    for (const row of rows) {
      const id = crypto.randomUUID();
      await sql`
        insert into courses (id, user_id, name, credits, grade)
        values (${id}, ${context.userId}, ${row.name}, ${row.credits}, ${row.grade})
      `;
      if (row.grade) await remember(sql, context.userId, "grade_set", id, row.name, row.name);
    }
    return { ok: true as const, count: rows.length, source: result.source };
  });

function clampMinutes(value: number, fallback: number, max: number) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

async function focusLabel(
  sql: Sql,
  userId: string,
  courseId: string,
  assignmentId: string,
  objective: string,
) {
  const typed = objective.trim().slice(0, 120);
  let courseName = "";
  let assignmentTitle = "";
  let assignmentSubject = "";
  if (courseId) {
    const rows = await sql<{ name: string }>`
      select name from courses where id = ${courseId} and user_id = ${userId}
    `;
    courseName = rows[0]?.name?.trim() ?? "";
  }
  if (assignmentId) {
    const rows = await sql<{ title: string; subject: string }>`
      select title, subject from assignments where id = ${assignmentId} and user_id = ${userId}
    `;
    assignmentTitle = rows[0]?.title?.trim() ?? "";
    assignmentSubject = rows[0]?.subject?.trim() ?? "";
  }
  const label = typed || assignmentTitle || courseName || "Focus";
  const subject = courseName || assignmentSubject || typed || label;
  return {
    label: label.slice(0, 120),
    subject: subject.slice(0, 80),
    courseId: courseName ? courseId : "",
    assignmentId: assignmentTitle ? assignmentId : "",
  };
}

export const startFocus = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator(
    (input: {
      preset: string;
      focusMin: number;
      breakMin: number;
      courseId: string;
      assignmentId: string;
      objective: string;
      autoBreak: boolean;
      goal: string;
      tried: boolean;
      gap: boolean;
      again: boolean;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    await settleFocus(sql, context.userId);
    const existing = await activeFocus(sql, context.userId);
    if (existing) return fail("A session is already open.");
    const presets: Record<string, [number, number]> = {
      short: [15, 3],
      classic: [25, 5],
      deep: [50, 10],
      extended: [90, 15],
    };
    const preset = presets[data.preset] ? data.preset : "custom";
    const pair = presets[preset];
    const focusMin = pair ? pair[0] : clampMinutes(data.focusMin, 25, 180);
    const breakMin = pair ? pair[1] : clampMinutes(data.breakMin, 5, 60);
    const named = await focusLabel(sql, context.userId, data.courseId ?? "", data.assignmentId ?? "", data.objective ?? "");
    const study = packStudy({
      goal: data.goal ?? "",
      tried: data.tried === true,
      gap: data.gap === true,
      again: data.again === true,
    });
    const id = crypto.randomUUID();
    const ends = new Date(Date.now() + focusMin * 60000).toISOString();
    await sql`
      insert into focus_sessions (
        id, user_id, preset, focus_min, break_min, course_id, assignment_id, objective, label, subject_key,
        phase, status, phase_ends_at, remaining_ms, focus_ms, auto_break, study
      )
      values (
        ${id}, ${context.userId}, ${preset}, ${focusMin}, ${breakMin},
        ${named.courseId || null}, ${named.assignmentId || null}, ${(data.objective ?? "").trim().slice(0, 120)},
        ${named.label}, ${named.subject}, 'focus', 'running', ${ends}, null, 0, ${Boolean(data.autoBreak)}, ${study}
      )
    `;
    return { ok: true as const, focus: await focusBundle(sql, context.userId) };
  });

export const pauseFocus = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const settled = await settleFocus(sql, context.userId);
    if (settled && settled.status === "running") {
      const ends = epoch(settled.phase_ends_at) ?? Date.now();
      const remaining = Math.max(0, ends - Date.now());
      await sql`
        update focus_sessions
        set status = 'paused', remaining_ms = ${remaining}, phase_ends_at = null
        where id = ${settled.id}
      `;
    }
    return { ok: true as const, focus: await focusBundle(sql, context.userId) };
  });

export const resumeFocus = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const settled = await settleFocus(sql, context.userId);
    if (settled && settled.status === "paused") {
      const remaining = Math.max(1000, Number(settled.remaining_ms ?? 0));
      await sql`
        update focus_sessions
        set status = 'running', phase_ends_at = ${new Date(Date.now() + remaining).toISOString()}, remaining_ms = null
        where id = ${settled.id}
      `;
    }
    return { ok: true as const, focus: await focusBundle(sql, context.userId) };
  });

export const stopFocus = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const settled = await settleFocus(sql, context.userId);
    if (settled) {
      let focusMs = Number(settled.focus_ms);
      let status = "completed";
      if (settled.phase === "focus") {
        const planned = Number(settled.focus_min) * 60000;
        const remaining =
          settled.status === "paused"
            ? Number(settled.remaining_ms ?? planned)
            : Math.max(0, (epoch(settled.phase_ends_at) ?? Date.now()) - Date.now());
        const elapsed = Math.max(0, planned - remaining);
        focusMs += elapsed;
        if (elapsed < 8000) status = "cancelled";
        else if (remaining <= 1500) status = "completed";
        else status = "interrupted";
        if (status === "completed") {
          await remember(sql, context.userId, "focus", settled.id, settled.label || "Focus", settled.subject_key || settled.label);
        }
      }
      await sql`
        update focus_sessions
        set status = ${status}, focus_ms = ${focusMs}, phase_ends_at = null, remaining_ms = null,
            ended_at = ${new Date().toISOString()}
        where id = ${settled.id}
      `;
    }
    return { ok: true as const, focus: await focusBundle(sql, context.userId) };
  });

export const advanceFocus = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const before = await activeFocus(sql, context.userId);
    const after = await settleFocus(sql, context.userId);
    let notice: string | null = null;
    if (before && before.status === "running" && epoch(before.phase_ends_at) != null && (epoch(before.phase_ends_at) ?? 0) <= Date.now()) {
      if (!after) notice = "Session finished.";
      else if (after.phase !== before.phase) notice = after.phase === "break" ? "Break." : "Focus.";
    }
    return { ok: true as const, notice, focus: await focusBundle(sql, context.userId) };
  });

export const setFocusStudy = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((input: { goal: string; tried: boolean; gap: boolean; again: boolean }) => input)
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    const study = packStudy({
      goal: data?.goal ?? "",
      tried: data?.tried === true,
      gap: data?.gap === true,
      again: data?.again === true,
    });
    await sql`
      update focus_sessions
      set study = ${study}
      where user_id = ${context.userId} and status in ('running', 'paused')
    `;
    return { ok: true as const };
  });

export const setFocusAuto = createServerFn({ method: "POST" })
  .middleware([cadetGate])
  .validator((enabled: boolean) => enabled === true)
  .handler(async ({ context, data: enabled }) => {
    const { sql } = await requireRole(context.userId, "cadet");
    await sql`
      update focus_sessions
      set auto_break = ${enabled}
      where user_id = ${context.userId} and status in ('running', 'paused')
    `;
    return { ok: true as const };
  });

export const listAdmin = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "admin");
    const invites = await sql<{
      id: string;
      code: string;
      revoked: boolean;
      used_name: string | null;
      used_at: string | null;
      created_at: string;
    }>`
      select id, code, revoked, used_name, used_at::text as used_at, created_at::text as created_at
      from invites
      order by created_at desc
      limit 100
    `;
    const cadets = await sql<{
      user_id: string;
      username: string;
      display_name: string;
      disabled: boolean;
      created_at: string;
    }>`
      select user_id, username, display_name, disabled, created_at::text as created_at
      from profiles
      where role = 'cadet'
      order by created_at desc
    `;
    const shared = await sql<{ endpoint: string; model: string; api_key: string | null }>`
      select endpoint, model, api_key from shared_ai where id = 'shared'
    `;
    return {
      invites: invites.map((row) => ({ ...row, revoked: on(row.revoked) })),
      cadets: cadets.map((row) => ({ ...row, disabled: on(row.disabled) })),
      shared: {
        endpoint: shared[0]?.endpoint ?? DEFAULT_ENDPOINT,
        model: shared[0]?.model ?? DEFAULT_MODEL,
        configured: Boolean(shared[0]?.api_key),
        hint: hint(shared[0]?.api_key),
      },
    };
  });

export const createInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql } = await requireRole(context.userId, "admin");
    const id = crypto.randomUUID();
    const code = inviteCode();
    await sql`
      insert into invites (id, code, created_by) values (${id}, ${code}, ${context.userId})
    `;
    return { ok: true as const, id, code };
  });

export const revokeInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const { sql } = await requireRole(context.userId, "admin");
    await sql`
      update invites set revoked = true
      where id = ${id} and used_by is null and created_by = ${context.userId}
    `;
    return { ok: true as const };
  });

export const setCadetDisabled = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { userId: string; disabled: boolean }) => input)
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "admin");
    await sql`
      update profiles set disabled = ${Boolean(data.disabled)}
      where user_id = ${data.userId} and role = 'cadet'
    `;
    return { ok: true as const };
  });

export const removeCadet = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((userId: string) => userId)
  .handler(async ({ context, data: userId }) => {
    const { sql } = await requireRole(context.userId, "admin");
    const rows = await sql<{ user_id: string }>`
      select user_id from profiles where user_id = ${userId} and role = 'cadet'
    `;
    if (!rows[0]) return fail("That account is not a cadet.");
    await sql`delete from "user" where id = ${userId}`;
    return { ok: true as const };
  });

export const resetCadetPassword = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { userId: string; password: string; confirm: string }) => input)
  .handler(async ({ context, data }) => {
    if (!validPassword(data.password ?? "")) return fail("Password needs 8 to 72 characters.");
    if (data.password !== data.confirm) return fail("Passwords do not match.");
    const { sql } = await requireRole(context.userId, "admin");
    const rows = await sql<{ user_id: string }>`
      select user_id from profiles where user_id = ${data.userId} and role = 'cadet'
    `;
    if (!rows[0]) return fail("That account is not a cadet.");
    const hashed = await hashPassword(data.password);
    const updated = await sql<{ id: string }>`
      update "account"
      set "password" = ${hashed}, "updatedAt" = now()
      where "userId" = ${data.userId} and "providerId" = 'credential'
      returning id
    `;
    if (!updated[0]) return fail("No password is stored for that account.");
    return { ok: true as const };
  });

export const saveSharedAi = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: { endpoint: string; model: string; apiKey: string; clearKey: boolean }) => input,
  )
  .handler(async ({ context, data }) => {
    const { sql } = await requireRole(context.userId, "admin");
    const endpoint = cleanEndpoint(data.endpoint) ?? DEFAULT_ENDPOINT;
    const model = cleanModel(data.model) ?? DEFAULT_MODEL;
    const current = await sql<{ api_key: string | null }>`
      select api_key from shared_ai where id = 'shared'
    `;
    let apiKey = current[0]?.api_key ?? null;
    if (data.clearKey) apiKey = null;
    else if ((data.apiKey ?? "").trim()) apiKey = data.apiKey.trim();
    await sql`
      insert into shared_ai (id, endpoint, model, api_key)
      values ('shared', ${endpoint}, ${model}, ${apiKey})
      on conflict (id) do update
      set endpoint = excluded.endpoint, model = excluded.model, api_key = excluded.api_key
    `;
    return { ok: true as const, configured: Boolean(apiKey), hint: hint(apiKey) };
  });
