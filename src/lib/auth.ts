import { db, usersTable, sessionsTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export function hashPasswordLegacy(password: string): string {
  return crypto.createHash("sha256").update(password + "sms-salt-2024").digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("$2")) {
    return bcrypt.compare(password, storedHash);
  }
  return storedHash === hashPasswordLegacy(password);
}

export function generateToken(): string {
  return crypto.randomBytes(48).toString("hex");
}

export async function createSession(userId: number): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(sessionsTable).values({ userId, token, expiresAt });
  return token;
}

export async function getUserFromToken(token: string) {
  const session = await db.query.sessionsTable.findFirst({
    where: and(
      eq(sessionsTable.token, token),
      gt(sessionsTable.expiresAt, new Date())
    ),
  });
  if (!session) return null;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, session.userId),
  });
  return user || null;
}

export async function deleteSession(token: string) {
  await db.delete(sessionsTable).where(eq(sessionsTable.token, token));
}

export async function deleteAllUserSessions(userId: number) {
  const { sessionsTable } = await import("@workspace/db");
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
}
