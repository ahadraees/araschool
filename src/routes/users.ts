import { Router } from "express";
import { db, usersTable, studentsTable, teachersTable } from "@workspace/db";
import { eq, and, or, ilike, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { hashPassword } from "../lib/auth.js";

const router = Router();

const MANAGEABLE_ROLES = ["accountant", "sub_admin"];

// ── GET /users — list users (admin sees all, sub_admin sees accountants only) ──
router.get("/", requireAuth, async (req, res) => {
  const { role: callerRole, schoolId } = req.user!;
  const roleFilter = req.query.role as string | undefined;
  const search     = req.query.search as string | undefined;

  if (!["super_admin", "admin", "sub_admin"].includes(callerRole)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // sub_admin can only query accountant (not admin/sub_admin/teacher/etc.)
  if (callerRole === "sub_admin") {
    if (roleFilter && roleFilter !== "accountant") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  const conditions = [eq(usersTable.isActive, true)];
  if (schoolId) conditions.push(eq(usersTable.schoolId, schoolId));
  if (roleFilter) conditions.push(eq(usersTable.role, roleFilter));

  let users = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      username: usersTable.username,
      role: usersTable.role,
      schoolId: usersTable.schoolId,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(and(...conditions))
    .orderBy(usersTable.role, usersTable.name);

  if (search) {
    const q = search.toLowerCase();
    users = users.filter(u =>
      u.name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.username?.toLowerCase().includes(q)
    );
  }

  res.json(users);
});

// ── POST /users — create accountant or sub_admin (admin / sub_admin only) ────
router.post("/", requireAuth, async (req, res) => {
  const { role: callerRole, schoolId } = req.user!;

  if (!["super_admin", "admin", "sub_admin"].includes(callerRole)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { name, email, password, role: newRole, permissions: rawPerms } = req.body;

  if (!name || !email || !password || !newRole) {
    res.status(400).json({ error: "name, email, password, and role are required" });
    return;
  }

  // sub_admin can only create accountants
  if (callerRole === "sub_admin" && newRole !== "accountant") {
    res.status(403).json({ error: "sub_admin can only create accountant users" });
    return;
  }

  // admin/super_admin can create accountant or sub_admin
  if (callerRole === "admin" && !MANAGEABLE_ROLES.includes(newRole)) {
    res.status(403).json({ error: "Admin can only create accountant or sub_admin users" });
    return;
  }

  // Check email uniqueness
  const [existing] = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "Email already taken" });
    return;
  }

  // For sub_admin, store permissions as JSON string; others get empty array
  const permissionsJson = newRole === "sub_admin" && Array.isArray(rawPerms)
    ? JSON.stringify(rawPerms)
    : "[]";

  const [created] = await db.insert(usersTable).values({
    name,
    email,
    username: email.split("@")[0],
    passwordHash: await hashPassword(password),
    role: newRole,
    permissions: permissionsJson,
    schoolId: schoolId ?? null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning({
    id: usersTable.id,
    name: usersTable.name,
    email: usersTable.email,
    username: usersTable.username,
    role: usersTable.role,
  });

  res.status(201).json({ success: true, user: created });
});

// ── PUT /users/:userId/credentials — update login credentials ────────────────
router.put("/:userId/credentials", requireAuth, async (req, res) => {
  const { role: callerRole, schoolId: adminSchool } = req.user!;

  if (!["super_admin", "admin", "sub_admin"].includes(callerRole)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const userId = Number(req.params.userId);
  const { username, password, email } = req.body;

  if (!username && !password && !email) {
    res.status(400).json({ error: "Provide at least one of: username, password, email" });
    return;
  }

  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role, schoolId: usersTable.schoolId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!target) { res.status(404).json({ error: "User not found" }); return; }

  if (adminSchool && target.schoolId !== adminSchool) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // super_admin can edit anyone; admin can edit non-admin roles; sub_admin can only edit accountants
  if (callerRole === "sub_admin" && target.role !== "accountant") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (callerRole === "admin" && ["super_admin", "admin"].includes(target.role)) {
    res.status(403).json({ error: "Cannot modify admin credentials" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (username) updates.username     = username;
  if (email)    updates.email        = email;
  if (password) updates.passwordHash = await hashPassword(password);

  if (username) {
    const conflict = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.username, username), sql`${usersTable.id} != ${userId}`));
    if (conflict[0]) { res.status(409).json({ error: "Username already taken" }); return; }
  }
  if (email) {
    const conflict = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.email, email), sql`${usersTable.id} != ${userId}`));
    if (conflict[0]) { res.status(409).json({ error: "Email already taken" }); return; }
  }

  const [updated] = await db.update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning({ id: usersTable.id, name: usersTable.name, email: usersTable.email, username: usersTable.username, role: usersTable.role });

  res.json({ success: true, user: updated });
});

export default router;
