import { Router } from "express";
import {
  db,
  teachersTable,
  usersTable,
  teacherClassesTable,
  classesTable,
  schoolsTable,
  staffAttendanceTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();

router.use(requireAuth);

// GET /api/teacher/me — returns full teacher profile + classes + school (for ID card)
router.get("/me", async (req, res) => {
  const teacher = await db.query.teachersTable.findFirst({
    where: eq(teachersTable.userId, req.user!.id),
  });
  if (!teacher) {
    res.status(404).json({ error: "Not Found", message: "Teacher profile not found" });
    return;
  }

  const [classes, homeroomRows, school, user] = await Promise.all([
    db
      .select({ id: classesTable.id, name: classesTable.name, section: classesTable.section })
      .from(teacherClassesTable)
      .leftJoin(classesTable, eq(teacherClassesTable.classId, classesTable.id))
      .where(eq(teacherClassesTable.teacherId, teacher.id)),
    db
      .select({ id: classesTable.id, name: classesTable.name, section: classesTable.section })
      .from(classesTable)
      .where(eq(classesTable.teacherId, teacher.id)),
    db.query.schoolsTable.findFirst({ where: eq(schoolsTable.id, teacher.schoolId) }),
    db.query.usersTable.findFirst({ where: eq(usersTable.id, teacher.userId) }),
  ]);

  const hr = homeroomRows[0];
  const homeroomClass = hr ? `${hr.name}${hr.section ? ` (${hr.section})` : ""}` : undefined;
  const homeroomClassId = hr?.id ?? undefined;

  res.json({
    ...teacher,
    name: user?.name,
    email: user?.email,
    classes,
    homeroomClass,
    homeroomClassId,
    school,
  });
});

// GET /api/teacher/my-attendance — teacher sees own staff attendance with date range
router.get("/my-attendance", async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const userId   = req.user!.id;
  const schoolId = req.user!.schoolId!;

  const conditions: any[] = [
    eq(staffAttendanceTable.userId, userId),
    eq(staffAttendanceTable.schoolId, schoolId),
  ];
  if (from) conditions.push(sql`${staffAttendanceTable.date} >= ${from}::date`);
  if (to)   conditions.push(sql`${staffAttendanceTable.date} <= ${to}::date`);

  const records = await db
    .select({
      id:       staffAttendanceTable.id,
      date:     sql<string>`to_char(${staffAttendanceTable.date}, 'YYYY-MM-DD')`,
      status:   staffAttendanceTable.status,
      scanTime: staffAttendanceTable.scanTime,
      notes:    staffAttendanceTable.notes,
    })
    .from(staffAttendanceTable)
    .where(and(...conditions))
    .orderBy(desc(staffAttendanceTable.date))
    .limit(400);

  const present = records.filter(r => r.status === "present").length;
  const late    = records.filter(r => r.status === "late").length;
  const absent  = records.filter(r => r.status === "absent").length;
  const leave   = records.filter(r => r.status === "leave").length;
  const total   = present + late + absent + leave;
  const pct     = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

  res.json({ records, summary: { present, late, absent, leave, total, pct } });
});

// ── POST /api/teacher/face — Teacher self-enrolls their own face ──────────────
router.post("/face", async (req, res) => {
  const { descriptor } = req.body;
  if (!descriptor || !Array.isArray(descriptor)) {
    res.status(400).json({ error: "descriptor array required" });
    return;
  }

  const teacher = await db.query.teachersTable.findFirst({
    where: eq(teachersTable.userId, req.user!.id),
  });
  if (!teacher) {
    res.status(404).json({ error: "Teacher profile not found" });
    return;
  }

  // Check if school allows self-enrollment
  const school = await db.query.schoolsTable.findFirst({ where: eq(schoolsTable.id, teacher.schoolId) });
  if (!school?.allowSelfFaceEnrollment) {
    res.status(403).json({ error: "Self face enrollment is not enabled by admin" });
    return;
  }

  await db.update(teachersTable)
    .set({ faceDescriptor: JSON.stringify(descriptor), updatedAt: new Date() })
    .where(eq(teachersTable.id, teacher.id));

  res.json({ success: true, message: "Face enrolled successfully" });
});

// ── DELETE /api/teacher/face — Teacher removes their own face ─────────────────
router.delete("/face", async (req, res) => {
  const teacher = await db.query.teachersTable.findFirst({
    where: eq(teachersTable.userId, req.user!.id),
  });
  if (!teacher) {
    res.status(404).json({ error: "Teacher profile not found" });
    return;
  }

  await db.update(teachersTable)
    .set({ faceDescriptor: null, updatedAt: new Date() })
    .where(eq(teachersTable.id, teacher.id));

  res.json({ success: true });
});

export default router;
