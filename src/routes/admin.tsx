import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient, rememberSessionToken, signOut } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { loginEnabled } from "@/lib/atlas/gate";
import { adminExists, createAdmin, getAccess, resolveLogin } from "@/lib/atlas/server";
import { AdminApp } from "@/components/atlas/admin-app";
import { Field, GhostButton, Mark, Notice, PrimaryButton, inputClass } from "@/components/atlas/ui";

export const Route = createFileRoute("/admin")({
  beforeLoad: () => {
    if (!loginEnabled) throw redirect({ to: "/" });
  },
  component: AdminPage,
});

function AdminPage() {
  const { user, isPending } = useCurrentUserState();
  const [access, setAccess] = useState<Awaited<ReturnType<typeof getAccess>> | "signed-out" | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    if (isPending) return;
    if (!user) {
      adminExists()
        .then((row) => {
          setExists(row.exists);
          setAccess("signed-out");
        })
        .catch(() => {
          setExists(true);
          setAccess("signed-out");
        });
      return;
    }
    getAccess()
      .then(setAccess)
      .catch(() => setAccess({ kind: "unlisted" }));
  }, [isPending, user]);

  if (isPending || access === null) {
    return (
      <main className="grid min-h-screen place-items-center">
        <p className="text-muted">Checking admin clearance…</p>
      </main>
    );
  }
  if (access === "signed-out") {
    return <AdminGate setup={exists === false} />;
  }
  if (access.kind !== "admin") {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <div className="max-w-md space-y-4 border border-border bg-surface p-6">
          <Mark kicker="Admin site" title="Wrong login" />
          <p className="text-sm text-muted">
            {access.kind === "cadet"
              ? "That is a normal account. Admin is a different login, so you cannot change invites or keys from here."
              : "This account cannot open the admin site."}
          </p>
          <GhostButton onClick={() => signOut("/admin")}>Use a different login</GhostButton>
        </div>
      </main>
    );
  }
  return <AdminApp />;
}

function AdminGate({ setup }: { setup: boolean }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let email = "";
      if (setup) {
        const created = await createAdmin({ data: { name, password, confirm } });
        if (!created.ok) {
          setError(created.error);
          return;
        }
        email = created.email;
      } else {
        const found = await resolveLogin({ data: { name, portal: "admin" } });
        if (!found.ok) {
          setError(found.error);
          return;
        }
        email = found.email;
      }
      const signed = await authClient.signIn.email({ email, password });
      if (signed.error) {
        setError(signed.error.message || "Wrong password.");
        return;
      }
      rememberSessionToken(signed.data?.token);
      window.location.assign("/admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid-bg grid min-h-screen place-items-center px-4 py-10">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-5 border border-border bg-surface p-6">
        <Mark kicker="Separate from the app" title={setup ? "Create admin" : "Admin login"} />
        <p className="text-sm text-muted">
          {setup
            ? "First-time setup. This login only opens the admin site. Use a different name from the one you will use as a cadet."
            : "Name and password. Invite codes are created after you are in."}
        </p>
        {error ? <Notice>{error}</Notice> : null}
        <Field label="Your name">
          <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} autoComplete="username" required />
        </Field>
        <Field label={setup ? "Create a password" : "Password"}>
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={setup ? "new-password" : "current-password"}
            required
          />
        </Field>
        {setup ? (
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
        ) : null}
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Working" : setup ? "Create admin login" : "Log in"}
        </PrimaryButton>
      </form>
    </main>
  );
}
