"use client";
import { useEffect } from "react";

// Registers the PWA service worker and makes new deploys take over
// automatically: when a new worker installs, tell it to activate, and reload
// once when it takes control so the fresh bundle loads without a manual clear.
export default function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    // Dev guard: Next inlines NODE_ENV at build time, so this branch is
    // stripped entirely from the production bundle. In dev the bundle
    // re-hashes on every recompile, which makes a registered SW re-install
    // over and over, firing controllerchange -> reload -> new SW -> reload
    // forever. Skip registering in dev, and proactively unregister any SW
    // a developer already has installed so an existing loop stops too.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((reg) => reg.unregister()))
        .catch(() => {});
      return;
    }

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Check for a newer worker on every load.
        reg.update().catch(() => {});
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            // A new worker is ready and an old one controls the page: activate now.
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              nw.postMessage("SKIP_WAITING");
            }
          });
        });
      })
      .catch((e) => console.warn("[Wing OS] SW registration failed", e));
  }, []);
  return null;
}
