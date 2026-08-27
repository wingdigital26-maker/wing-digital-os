// Copy text to the clipboard, honestly.
//
// The pattern this replaces was `navigator.clipboard?.writeText(s).then(...)`,
// which fails silently in two different ways:
//
//   1. When `navigator.clipboard` is undefined (any non-secure context, and
//      some in-app/PWA webviews), the optional chain yields `undefined` and the
//      following `.then()` throws a TypeError before any `.catch()` attaches.
//      The button does nothing at all and the error never surfaces.
//   2. When writeText rejects (document not focused, permission denied), the
//      trailing `.catch(() => {})` swallows it, so the UI simply never confirms.
//
// Either way the user clicks Copy, nothing lands on the clipboard, and nothing
// says so. This helper tries the async API, falls back to a hidden textarea +
// execCommand for older or non-secure contexts, and RETURNS whether it worked
// so the caller can show a real failure instead of pretending.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path below
  }

  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    // Keep it off-screen but still selectable; `display:none` cannot be copied.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length); // iOS needs the explicit range
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
