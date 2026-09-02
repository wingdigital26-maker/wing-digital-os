// One place to turn a login email into a person's name for display.
// "maddox@wingdigital.co" -> "Maddox". Names come from the data, never a
// hardcoded list. Non-email identities ("shared-login") just get capitalized.
export function displayName(email: string | null | undefined): string {
  if (!email) return "unknown";
  const n = email.split("@")[0] || email;
  return n.charAt(0).toUpperCase() + n.slice(1);
}
