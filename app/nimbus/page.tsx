// The desktop hotkey window: Nimbus alone, no OS shell behind him.
//
// The assistant itself is the global <JarvisButton /> in the root layout, which
// switches to its solo layout on this route: no floating button, the panel
// fills the window, and a small "Open the OS" link sits bottom right.
//
// This page renders only the ground the panel sits on, so there is never a
// flash of the OS behind it.
export const metadata = { title: "Nimbus" };

export default function NimbusWindow() {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "#0d1117",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span style={{ color: "#2b3550", fontSize: 12, fontFamily: "Inter, sans-serif" }}>Nimbus</span>
    </main>
  );
}
