import type { ReactNode } from "react";

export const inputClass =
  "w-full min-h-11 rounded-none border-0 border-b border-border bg-transparent px-0 text-base text-fg outline-none placeholder:text-muted focus:border-fg";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs tracking-[0.16em] text-muted uppercase">{label}</span>
      {children}
    </label>
  );
}

export function PrimaryButton({
  children,
  type = "button",
  disabled,
  onClick,
}: {
  children: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-11 items-center justify-center bg-fg px-5 text-sm font-medium tracking-[0.14em] text-bg uppercase disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  disabled,
  onClick,
  tone = "default",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  tone?: "default" | "accent";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center justify-center border px-5 text-sm font-medium tracking-[0.14em] uppercase disabled:opacity-40 ${
        tone === "accent"
          ? "border-fg text-fg hover:bg-fg hover:text-bg"
          : "border-border text-fg hover:border-fg"
      }`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`border border-border bg-bg p-5 sm:p-6 ${className}`}>
      {children}
    </section>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="border border-border px-3 py-2 text-sm text-fg">{children}</p>
  );
}

export function Mark({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div>
      <div className="text-xs tracking-[0.22em] text-muted uppercase">{kicker}</div>
      <h1 className="mt-3 text-6xl font-medium leading-none tracking-tight text-fg">{title}</h1>
    </div>
  );
}
