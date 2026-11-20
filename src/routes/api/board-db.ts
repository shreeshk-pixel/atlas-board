import { createFileRoute } from "@tanstack/react-router";
import { dbSource } from "@/lib/db";

export const Route = createFileRoute("/api/board-db")({
  server: {
    handlers: {
      GET: () => Response.json({ db: dbSource }),
    },
  },
});
