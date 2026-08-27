// Supabase-auth session cookie, signed with AUTH_SESSION_SECRET.
// Minted by /api/login after Supabase verifies email+password; verified by
// middleware on the Edge runtime (jose is Edge-safe). This is ADDITIVE to the
// legacy OS_PASSWORD / wingos_auth path -- both are accepted, so the old login
// never stops working.
import { SignJWT, jwtVerify } from "jose";

// `portal` is the client slug a client-role user belongs to (optional; set at
// login from the client_users mapping) so middleware can send them home
// without a DB lookup on every request.
export type Session = {
  sub: string;
  email: string;
  role: string;
  portal?: string;
};

function secretKey(): Uint8Array | null {
  const s = process.env.AUTH_SESSION_SECRET;
  if (!s) return null;
  return new TextEncoder().encode(s);
}

export async function signSession(s: Session): Promise<string> {
  const key = secretKey();
  if (!key) throw new Error("AUTH_SESSION_SECRET not set");
  return await new SignJWT({
    email: s.email,
    role: s.role,
    ...(s.portal ? { portal: s.portal } : {}),
  })
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
      portal: typeof payload.portal === "string" ? payload.portal : undefined,
    };
  } catch {
    return null;
  }
}
