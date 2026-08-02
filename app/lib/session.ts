// Supabase-auth session cookie, signed with AUTH_SESSION_SECRET.
// Minted by /api/login after Supabase verifies email+password; verified by
// middleware on the Edge runtime (jose is Edge-safe). This is ADDITIVE to the
// legacy OS_PASSWORD / wingos_auth path -- both are accepted, so the old login
// never stops working.
import { SignJWT, jwtVerify } from "jose";

export type Session = { sub: string; email: string; role: string };

function secretKey(): Uint8Array | null {
  const s = process.env.AUTH_SESSION_SECRET;
  if (!s) return null;
  return new TextEncoder().encode(s);
}

export async function signSession(s: Session): Promise<string> {
  const key = secretKey();
  if (!key) throw new Error("AUTH_SESSION_SECRET not set");
  return await new SignJWT({ email: s.email, role: s.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.sub)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

// Returns the session if the token is valid, else null. Never throws -- a bad or
// missing token, or a missing secret, simply means "no session" and the caller
// falls back to the legacy password gate.
export async function verifySession(
  token: string | undefined
): Promise<Session | null> {
  const key = secretKey();
  if (!token || !key) return null;
  try {
    const { payload } = await jwtVerify(token, key);
    return {
      sub: String(payload.sub ?? ""),
      email: String(payload.email ?? ""),
      role: String(payload.role ?? "client"),
    };
  } catch {
    return null;
  }
}
