// The house shimmer skeleton for the Call Room. Shaped like the card rows that
// will replace it, so a loading list reads as the same object arriving rather
// than a bare "Loading…" line. Uses the global `.skel` class shared with the
// rest of the OS (StormBoard, automations, every CRM board), so the whole
// product speaks one loading language.
export default function CallSkeleton({
  rows = 3,
  height = 76,
}: {
  rows?: number;
  height?: number;
}) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
      aria-label="Loading"
      aria-busy="true"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height, borderRadius: 14 }} />
      ))}
    </div>
  );
}
