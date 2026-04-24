import { Router } from "express";
import { db, notificationsTable, studentsTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();

// GET notifications for the current user (role-aware filter)
router.get("/", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId;
  const userId   = req.user!.id;
  const role     = req.user!.role;

  const rows = await db
    .select()
    .from(notificationsTable)
    .where(schoolId ? eq(notificationsTable.schoolId, schoolId) : undefined)
    .orderBy(desc(notificationsTable.createdAt))
    .limit(100);

  // Admins and super_admins see every notification in their school (sent or received)
  if (role === "super_admin" || role === "admin" || role === "teacher") {
    return res.json(rows);
  }

  // Other roles (student, parent, accountant): only show what's meant for them
  const relevant = rows.filter(n => {
    // Direct personal message — only show to the exact recipient
    if (n.recipientUserId != null) return n.recipientUserId === userId;
    // Role-targeted — only show if the role matches
    if (n.targetRole != null) return n.targetRole === role;
    // Broadcast (no targeting) — show to everyone
    return true;
  });

  res.json(relevant);
});

// GET all targetable users grouped by role
router.get("/users", requireAuth, requireRole("super_admin", "admin", "teacher"), async (req, res) => {
  const schoolId = req.user!.schoolId;

  const users = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(
      and(
        schoolId ? eq(usersTable.schoolId, schoolId) : undefined,
        eq(usersTable.isActive, true),
      )
    )
    .orderBy(usersTable.name);

  const grouped = {
    teachers:    users.filter(u => u.role === "teacher"),
    students:    users.filter(u => u.role === "student"),
    parents:     users.filter(u => u.role === "parent"),
    accountants: users.filter(u => u.role === "accountant"),
  };

  res.json(grouped);
});

// GET students list (legacy compat)
router.get("/students", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const schoolId = req.user!.schoolId;
  const students = await db.select({
    id: studentsTable.id,
    name: studentsTable.name,
    rollNumber: studentsTable.rollNumber,
    classId: studentsTable.classId,
  })
    .from(studentsTable)
    .where(schoolId ? and(eq(studentsTable.schoolId, schoolId), eq(studentsTable.isActive, true)) : eq(studentsTable.isActive, true));
  res.json(students);
});

// POST create notification — admin/teacher can target by role, group, or specific person
router.post("/", requireAuth, requireRole("super_admin", "admin", "teacher"), async (req, res) => {
  const { schoolId, title, message, type, targetRole, userId, targetStudentId, recipientUserId } = req.body;

  const [notif] = await db.insert(notificationsTable).values({
    schoolId: schoolId || req.user!.schoolId!,
    title,
    message,
    type: type || "info",
    targetRole: targetRole || null,
    userId: userId || null,
    targetStudentId: targetStudentId ? Number(targetStudentId) : null,
    recipientUserId: recipientUserId ? Number(recipientUserId) : null,
  }).returning();

  res.status(201).json(notif);
});

// PUT mark as read
router.put("/:notificationId/read", requireAuth, async (req, res) => {
  await db.update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.id, Number(req.params.notificationId)));
  res.json({ success: true, message: "Marked as read" });
});

export default router;
