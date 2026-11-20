import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CadetApp } from "@/components/atlas/cadet-app";
import { loginEnabled } from "@/lib/atlas/gate";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getAccess } from "@/lib/atlas/server";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  if (!loginEnabled) return <CadetApp displayName="" />;
  return <GuardedBoard />;
}

function GuardedBoard() {
  const { user, isPending } = useCurrentUserState();
  const navigate = useNavigate();
  const [name, setName] = useState<string | null>(null);
  const [blocked, setBlocked] = useState("");

  useEffect(() => {
    if (isPending) return;
    if (!user) {
      void navigate({ to: "/login" });
      return;
    }
    getAccess()
      .then((access) => {
        if (access.kind === "admin") {
          void navigate({ to: "/admin" });
          return;
        }
        if (access.kind !== "cadet") {
          setBlocked(access.kind === "disabled" ? "This account is disabled." : "This login is not on the board.");
          return;
        }
        setName(access.displayName);
      })
      .catch(() => setBlocked("Could not open the board."));
  }, [isPending, user, navigate]);

  if (blocked) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <p className="text-sm">{blocked}</p>
      </main>
    );
  }
  if (!name) return <main className="grid min-h-screen place-items-center"><p className="text-sm text-muted">Checking the login.</p></main>;
  return <CadetApp displayName={name} />;
}
