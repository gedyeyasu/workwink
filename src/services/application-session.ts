import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const APPLICATION_SESSION_COOKIE = "workwink_session";
export const APPLICATION_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type ApplicationSession = {
  sessionHash: string;
  setCookie: string | null;
};

function signature(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`workwink-session-v1:${sessionId}`).digest("base64url");
}

function signedValue(sessionId: string, secret: string): string {
  return `v1.${sessionId}.${signature(sessionId, secret)}`;
}

function cookieValue(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== APPLICATION_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function verify(value: string | undefined, secret: string): string | undefined {
  if (!value) return undefined;
  const match = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return undefined;
  const sessionId = match[1]!;
  const supplied = Buffer.from(match[2]!, "utf8");
  const expected = Buffer.from(signature(sessionId, secret), "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  return sessionId;
}

export function serializeApplicationSessionCookie(value: string, secure: boolean): string {
  return [
    `${APPLICATION_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${APPLICATION_SESSION_MAX_AGE_SECONDS}`,
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

export function resolveApplicationSession(
  cookieHeader: string | undefined,
  secret: string,
  secure: boolean
): ApplicationSession {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("APPLICATION_SESSION_SECRET must be at least 32 bytes.");
  }
  const existing = verify(cookieValue(cookieHeader), secret);
  const sessionId = existing ?? randomBytes(32).toString("base64url");
  return {
    sessionHash: createHash("sha256").update(`workwink-session-hash-v1:${sessionId}`).digest("hex"),
    setCookie: existing ? null : serializeApplicationSessionCookie(signedValue(sessionId, secret), secure)
  };
}

