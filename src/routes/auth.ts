import { Router, Request, Response, NextFunction } from "express";
import { db, usersTable, schoolsTable, studentsTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import { hashPassword, verifyPassword, createSession, deleteSession } from "../lib/auth.js";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

// ── In-memory rate limit + brute force protection ─────────────────────────────
// Maps: IP → { count, firstAttempt }  and  email → { count, lockedUntil }
const ipAttempts   = new Map<string, { count: number; firstAttempt: number }>();
const acctAttempts = new Map<string, { count: number; lockedUntil: number }>();

const IP_WINDOW_MS   = 15 * 60 * 1000; // 15 min
const IP_MAX         = 20;              // max 20 attempts per IP per 15 min
const ACCT_MAX       = 5;              // max 5 failures per account
const ACCT_LOCK_MS   = 15 * 60 * 1000; // 15 min account lockout

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > IP_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  entry.count++;
  return entry.count <= IP_MAX;
}

function checkAccountLock(loginId: string): { locked: boolean; remainingSec?: number } {
  const entry = acctAttempts.get(loginId.toLowerCase());
  if (!entry) return { locked: false };
  if (entry.count < ACCT_MAX) return { locked: false };
  const remaining = entry.lockedUntil - Date.now();
  if (remaining <= 0) {
    acctAttempts.delete(loginId.toLowerCase());
    return { locked: false };
  }
  return { locked: true, remainingSec: Math.ceil(remaining / 1000) };
}

function recordFailedAttempt(loginId: string) {
  const key = loginId.toLowerCase();
  const entry = acctAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= ACCT_MAX) {
    entry.lockedUntil = Date.now() + ACCT_LOCK_MS;
  }
  acctAttempts.set(key, entry);
}

function clearFailedAttempts(loginId: string) {
  acctAttempts.delete(loginId.toLowerCase());
}

// ── Sanitize input ────────────────────────────────────────────────────────────
function sanitizeInput(val: unknown, maxLen = 254): string {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

// ── Login ─────────────────────────────────────────────────────────────────────
router.post("/login", async (req: Request, res: Response) => {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim()
    ?? req.socket.remoteAddress
    ?? "unknown";

  // IP rate limit
  if (!checkIpRateLimit(ip)) {
    res.status(429).json({
      error: "Too Many Requests",
      message: "Too many login attempts from this network. Please wait 15 minutes and try again.",
    });
    return;
  }

  const loginId  = sanitizeInput(req.body?.identifier ?? req.body?.email);
  const password = sanitizeInput(req.body?.password, 128);

  if (!loginId || !password) {
    res.status(400).json({ error: "Bad Request", message: "Username/email and password required" });
    return;
  }

  // Account lock check
  const lockStatus = checkAccountLock(loginId);
  if (lockStatus.locked) {
    const mins = Math.ceil((lockStatus.remainingSec ?? 900) / 60);
    res.status(429).json({
      error: "Account Locked",
      message: `Account temporarily locked due to too many failed attempts. Try again in ${mins} minute${mins !== 1 ? "s" : ""}.`,
      remainingSec: lockStatus.remainingSec,
    });
    return;
  }

  // Constant-time: always query DB even if we'll fail, to avoid user enumeration timing attacks
  const user = await db.query.usersTable.findFirst({
    where: or(
      eq(usersTable.email, loginId.toLowerCase()),
      eq(usersTable.username, loginId)
    ),
  });

  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !passwordOk || !user.isActive) {
    recordFailedAttempt(loginId);
    // Generic message — don't reveal which field was wrong
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials. Please check your username and password." });
    return;
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  clearFailedAttempts(loginId);

  // Transparently upgrade legacy SHA-256 passwords to bcrypt
  if (!user.passwordHash.startsWith("$2")) {
    const newHash = await hashPassword(password);
    await db.update(usersTable).set({ passwordHash: newHash }).where(eq(usersTable.id, user.id));
  }

  await db.update(usersTable).set({ lastLogin: new Date() }).where(eq(usersTable.id, user.id));

  const token = await createSession(user.id);

  let school = null;
  if (user.schoolId) {
    school = await db.query.schoolsTable.findFirst({
      where: eq(schoolsTable.id, user.schoolId),
    });
  }

  res.cookie("sms_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  let permissions: string[] = [];
  try { permissions = JSON.parse(user.permissions || "[]"); } catch { permissions = []; }

  // Return { user, school } to match API client schema
  res.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
      schoolId: user.schoolId,
      isActive: user.isActive,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      permissions,
    },
    school,
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post("/logout", async (req: Request, res: Response) => {
  const token = req.cookies?.["sms_session"];
  if (token) {
    await deleteSession(token);
    res.clearCookie("sms_session", { path: "/" });
  }
  res.json({ success: true });
});

// ── Me ────────────────────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  let school = null;
  if (req.user!.schoolId) {
    school = await db.query.schoolsTable.findFirst({
      where: eq(schoolsTable.id, req.user!.schoolId),
    });
  }

  let studentId: number | null = null;
  if (req.user!.role === "student") {
    const student = await db.select({ id: studentsTable.id })
      .from(studentsTable).where(eq(studentsTable.userId, req.user!.id)).limit(1);
    studentId = student[0]?.id ?? null;
  }

  // Strip passwordHash from response
  const { passwordHash: _ph, ...safeUser } = req.user as any;
  res.json({ ...safeUser, studentId, school });
});

export default router;
