import { useEffect, useState } from "react";
import { signOut } from "@/lib/auth/client";
import {
  createInvite,
  listAdmin,
  removeCadet,
  resetCadetPassword,
  revokeInvite,
  saveSharedAi,
  setCadetDisabled,
} from "@/lib/atlas/server";
import { Card, GhostButton, Notice, PrimaryButton, inputClass } from "./ui";

type Invite = {
  id: string;
  code: string;
  revoked: boolean;
  used_name: string | null;
  used_at: string | null;
};
type Cadet = {
  user_id: string;
  username: string;
  display_name: string;
  disabled: boolean;
};
type Panel = "invites" | "cadets" | "key";

export function AdminApp() {
  const [panel, setPanel] = useState<Panel>("invites");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [cadets, setCadets] = useState<Cadet[]>([]);
  const [endpoint, setEndpoint] = useState("https://openrouter.ai/api/v1");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [freshCode, setFreshCode] = useState("");
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  async function refresh() {
    const data = await listAdmin();
    setInvites(data.invites);
    setCadets(data.cadets);
    setEndpoint(data.shared.endpoint);
    setModel(data.shared.model);
    setConfigured(data.shared.configured);
    setHint(data.shared.hint);
  }

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load"));
  }, []);

  async function run(action: () => Promise<void>) {
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
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <div className="text-sm font-medium tracking-[0.28em]">ATLAS</div>
            <div className="mt-1 text-xs tracking-[0.16em] text-muted uppercase">Admin</div>
          </div>
          <button
            type="button"
            onClick={() => signOut("/admin")}
            className="min-h-11 px-1 text-xs tracking-[0.16em] uppercase"
          >
            Sign out
          </button>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
          {(
            [
              ["invites", "Invites"],
              ["cadets", "Cadets"],
              ["key", "Shared key"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPanel(id)}
              className={`min-h-11 border-b px-3 text-xs tracking-[0.16em] uppercase ${
                panel === id ? "border-fg text-fg" : "border-transparent text-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        {error ? <Notice>{error}</Notice> : null}
        <p className="text-sm text-muted">
          This login cannot open anyone’s timetable, grades, notes, or chats. Your own cadet account stays in the app.
        </p>

        {panel === "invites" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-4xl font-medium tracking-tight">Invite codes</h1>
              <PrimaryButton
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const created = await createInvite();
                    setFreshCode(created.code);
                    await refresh();
                  })
                }
              >
                Generate code
              </PrimaryButton>
            </div>
            {freshCode ? (
              <Card>
                <div className="text-xs tracking-[0.16em] text-muted uppercase">New code</div>
                <p className="mt-2 text-4xl font-medium tracking-[0.18em] text-fg">{freshCode}</p>
                <GhostButton
                  onClick={() => {
                    void navigator.clipboard?.writeText(freshCode);
                  }}
                >
                  Copy
                </GhostButton>
              </Card>
            ) : null}
            {invites.length === 0 ? <p className="text-sm text-muted">No codes yet.</p> : null}
            {invites.map((invite) => (
              <Card key={invite.id} className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-2xl font-medium tracking-[0.16em]">{invite.code}</div>
                  <p className="text-sm text-muted">
                    {invite.used_name
                      ? `Used by ${invite.used_name}`
                      : invite.revoked
                        ? "Revoked"
                        : "Unused"}
                  </p>
                </div>
                {!invite.used_name && !invite.revoked ? (
                  <GhostButton
                    tone="accent"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await revokeInvite({ data: invite.id });
                        await refresh();
                      })
                    }
                  >
                    Revoke
                  </GhostButton>
                ) : null}
              </Card>
            ))}
          </div>
        ) : null}

        {panel === "cadets" ? (
          <div className="space-y-4">
            <h1 className="text-4xl font-medium tracking-tight">Cadets</h1>
            {cadets.length === 0 ? <p className="text-sm text-muted">Nobody has signed up yet.</p> : null}
            {cadets.map((cadet) => (
              <Card key={cadet.user_id} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-lg text-fg">{cadet.display_name}</div>
                    <p className="text-sm text-muted">{cadet.disabled ? "Disabled" : "Active"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <GhostButton
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await setCadetDisabled({
                            data: { userId: cadet.user_id, disabled: !cadet.disabled },
                          });
                          await refresh();
                        })
                      }
                    >
                      {cadet.disabled ? "Enable" : "Disable"}
                    </GhostButton>
                    <GhostButton
                      onClick={() => {
                        setResetFor(resetFor === cadet.user_id ? null : cadet.user_id);
                        setPassword("");
                        setConfirm("");
                      }}
                    >
                      Set password
                    </GhostButton>
                    <GhostButton
                      tone="accent"
                      onClick={() =>
                        run(async () => {
                          if (pendingRemove !== cadet.user_id) {
                            setPendingRemove(cadet.user_id);
                            return;
                          }
                          const result = await removeCadet({ data: cadet.user_id });
                          if (!result.ok) {
                            setError(result.error);
                            return;
                          }
                          setPendingRemove(null);
                          await refresh();
                        })
                      }
                    >
                      {pendingRemove === cadet.user_id ? "Confirm remove" : "Remove"}
                    </GhostButton>
                  </div>
                </div>
                {resetFor === cadet.user_id ? (
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <input
                      className={inputClass}
                      type="password"
                      placeholder="New password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <input
                      className={inputClass}
                      type="password"
                      placeholder="Re-enter password"
                      value={confirm}
                      onChange={(event) => setConfirm(event.target.value)}
                    />
                    <PrimaryButton
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const result = await resetCadetPassword({
                            data: { userId: cadet.user_id, password, confirm },
                          });
                          if (!result.ok) {
                            setError(result.error);
                            return;
                          }
                          setResetFor(null);
                          setPassword("");
                          setConfirm("");
                        })
                      }
                    >
                      Save
                    </PrimaryButton>
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        ) : null}

        {panel === "key" ? (
          <Card className="max-w-xl space-y-3">
            <h1 className="text-4xl font-medium tracking-tight">Shared key</h1>
            <p className="text-sm text-muted">
              Cadets never see this key. It is used only when they have not saved their own.
              {configured && hint ? ` Current key ends in ${hint}.` : " No shared key yet."}
            </p>
            <input className={inputClass} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
            <input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} />
            <input
              className={inputClass}
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={configured ? "Paste a new key to replace it" : "OpenRouter key"}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />
              Clear the shared key
            </label>
            <PrimaryButton
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await saveSharedAi({
                    data: { endpoint, model, apiKey, clearKey },
                  });
                  if (!result.ok) return;
                  setConfigured(result.configured);
                  setHint(result.hint);
                  setApiKey("");
                  setClearKey(false);
                })
              }
            >
              Save
            </PrimaryButton>
          </Card>
        ) : null}
      </main>
    </div>
  );
}
