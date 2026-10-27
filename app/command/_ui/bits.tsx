// Small display pieces shared by the Command Center screens. Server-safe.
import type { Health } from "@/lib/command/vault";

const HEALTH_WORD: Record<Health, string> = { green: "Green", yellow: "Yellow", red: "Red", unknown: "No check" };

export function HealthTag({ h }: { h: Health }) {
  return <span className={`cc-tag ${h === "unknown" ? "" : h}`}>{HEALTH_WORD[h]}</span>;
}

/** Shows why data is missing (store not set up, vault unreadable). Never hides it. */
export function Problems({ errors }: { errors: (string | null | undefined)[] }) {
  const list = [...new Set(errors.filter(Boolean))] as string[];
  if (!list.length) return null;
  return (
    <div className="cc-note err">
      {list.map((e) => (
        <div key={e}>{e}</div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="cc-empty">{children}</div>;
}

export function Stat({ n, l, s, href, tone }: { n: React.ReactNode; l: string; s?: React.ReactNode; href?: string; tone?: "bad" | "warn" }) {
  const inner = (
    <>
      <div className="l">{l}</div>
      <div className="n">{n}</div>
      {s ? <div className="s">{s}</div> : null}
    </>
  );
  return href ? (
    <a href={href} className={`cc-card cc-stat ${tone ?? ""}`}>{inner}</a>
  ) : (
    <div className={`cc-card cc-stat ${tone ?? ""}`}>{inner}</div>
  );
}
