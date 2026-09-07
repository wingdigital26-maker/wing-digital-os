// The desktop hotkey window: Nimbus alone, no OS shell behind him.
//
// The assistant itself is the global <JarvisButton /> in the root layout, which
// switches to its solo layout on this route: no floating button, the panel
// takes the lower part of the window, and a small "Open the OS" link sits
// bottom right.
//
// This page renders the ambient stage the panel sits on, so there is never a
// flash of the OS behind it.
import NimbusStage from "./NimbusStage";

export const metadata = { title: "Nimbus" };

export default function NimbusWindow() {
  return (
    <main style={{ position: "fixed", inset: 0, background: "#0d1117" }}>
      <NimbusStage />
    </main>
  );
}
