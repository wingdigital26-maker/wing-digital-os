"use client";
import { useEffect } from "react";

// Registers the PWA service worker once per page load.
export default function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.warn("[Wing OS] SW registration failed", e);
    });
  }, []);
  return null;
}
