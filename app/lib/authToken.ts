// Deterministic, NON-REVERSIBLE token derived from the password via
// HMAC-SHA256 (Web Crypto, so it works in both Edge middleware and Node
// routes). Hex output = alphanumeric only, so it's always cookie-safe.
// Previously this was btoa("wingos:" + pw) which leaked the password to
// anyone who read the cookie; the HMAC keeps the same "deterministic token
// from OS_PASSWORD" behavior without being decodable.
export async function authToken(): Promise<string> {
  const pw = process.env.OS_PASSWORD ?? "";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("wingos-legacy-auth:" + pw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("wingos"));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
