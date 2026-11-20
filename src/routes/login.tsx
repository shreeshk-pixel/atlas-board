import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { authClient, rememberSessionToken } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { loginEnabled } from "@/lib/atlas/gate";
import { getAccess, registerCadet, resolveLogin } from "@/lib/atlas/server";
import { Field, Mark, Notice, PrimaryButton, inputClass } from "@/components/atlas/ui";

export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    if (!loginEnabled) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const { user, isPending } = useCurrentUserState();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "create">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isPending || !user) return;
    getAccess()
      .then((access) => {
        if (access.kind === "cadet") void navigate({ to: "/" });
        if (access.kind === "admin") void navigate({ to: "/admin" });
      })
      .catch(() => undefined);
  }, [isPending, user, navigate]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "create") {
        const created = await registerCadet({ data: { name, password, confirm, invite } });
        if (!created.ok) {
          setError(created.error);
          return;
        }
        const signed = await authClient.signIn.email({ email: created.email, password });
        if (signed.error) {
          setError(signed.error.message || "Account created, but sign-in failed.");
          return;
        }
        rememberSessionToken(signed.data?.token);
      } else {
        const found = await resolveLogin({ data: { name, portal: "cadet" } });
        if (!found.ok) {
          setError(found.error);
          return;
        }
        const signed = await authClient.signIn.email({ email: found.email, password });
        if (signed.error) {
          setError(signed.error.message || "Wrong password.");
          return;
        }
        rememberSessionToken(signed.data?.token);
      }
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid-bg grid min-h-screen place-items-center px-4 py-10">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-5 border border-border bg-surface p-6">
        <Mark kicker="Cadet access" title="ATLAS" />
        <div className="flex gap-2">
          {(["login", "create"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setMode(item);
                setError("");
              }}
              className={`min-h-11 flex-1 border text-xs tracking-[0.16em] uppercase ${
                mode === item ? "border-fg text-fg" : "border-border text-muted"
              }`}
            >
              {item === "login" ? "Log in" : "Create account"}
            </button>
          ))}
        </div>
        {error ? <Notice>{error}</Notice> : null}
        <Field label="Your name">
          <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} autoComplete="username" required />
        </Field>
        <Field label={mode === "create" ? "Create a password" : "Password"}>
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "create" ? "new-password" : "current-password"}
            required
          />
        </Field>
        {mode === "create" ? (
          <>
            <Field label="Re-enter your password">
              <input
                className={inputClass}
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="Invite code">
              <input
                className={inputClass}
                value={invite}
                onChange={(event) => setInvite(event.target.value.toUpperCase())}
                autoComplete="off"
                required
              />
            </Field>
          </>
        ) : null}
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Working" : mode === "create" ? "Create account" : "Log in"}
        </PrimaryButton>
        <p className="text-sm text-muted">
          Admin?{" "}
          <Link to="/admin" className="text-fg underline underline-offset-4">
            Open the admin site
          </Link>
        </p>
      </form>
    </main>
  );
}
