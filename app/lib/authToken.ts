// Deterministic token from the password -- no special chars in the cookie
// (raw "!!" broke cookie parsing). Works in both Edge middleware and Node routes.
export function authToken(): string {
  const pw = process.env.OS_PASSWORD ?? "";
  return btoa("wingos:" + pw).replace(/[^a-zA-Z0-9]/g, "");
}
