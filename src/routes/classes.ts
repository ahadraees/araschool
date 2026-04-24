import { Router } from "express";
import { db, classesTable, teachersTable, usersTable, studentsTable, teacherClassesTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const schoolId = req.query.schoolId ? Number(req.query.schoolId) : req.user!.schoolId;
  if (!schoolId) { res.status(400).json({ error: "schoolId required" }); return; }

  // ── If teacher, only return their assigned classes ────────────────────────
  let teacherClassIds: number[] | null = null;
  if (req.user!.role === "teacher") {
    const teacherRecord = await db
      .select({ id: teachersTable.id })
      .from(teachersTable)
      .where(and(eq(teachersTable.userId, req.user!.id), eq(teachersTable.schoolId, schoolId)));

    if (teacherRecord[0]) {
      const tid = teacherRecord[0].id;
      // Classes where teacher is assigned as class teacher
      const primaryClasses = await db
        .select({ classId: classesTable.id })
        .from(classesTable)
        .where(and(eq(classesTable.schoolId, schoolId), eq(classesTable.teacherId, tid)));

      // Classes assigned via teacher_classes join table
      const extraClasses = await db
        .select({ classId: teacherClassesTable.classId })
        .from(teacherClassesTable)
        .where(eq(teacherClassesTable.teacherId, tid));

      const ids = [
        ...primaryClasses.map(r => r.classId),
        ...extraClasses.map(r => r.classId),
      ];
      // Unique IDs
      teacherClassIds = [...new Set(ids)];
    } else {
      // Teacher record not found — return empty
      res.json([]);
      return;
    }
  }

  // ── Build where clause ────────────────────────────────────────────────────
  const whereClause = teacherClassIds !== null && teacherClassIds.length > 0
    ? and(eq(classesTable.schoolId, schoolId), inArray(classesTable.id, teacherClassIds))
    : teacherClassIds !== null && teacherClassIds.length === 0
      ? sql`1=0` // no classes assigned
      : eq(classesTable.schoolId, schoolId);

  const classes = await db
    .select({
      id: classesTable.id,
      schoolId: classesTable.schoolId,
      name: classesTable.name,
      section: classesTable.section,
      batch: classesTable.batch,
      teacherId: classesTable.teacherId,
      teacherName: usersTable.name,
      createdAt: classesTable.createdAt,
    })
    .from(classesTable)
    .leftJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(whereClause);

  if (classes.length === 0) { res.json([]); return; }

  // ── Fetch student counts in one query (avoids N+1) ────────────────────────
  const classIds = classes.map(c => c.id);
  const counts = await db
    .select({
      classId: studentsTable.classId,
      count: sql<number>`count(*)`,
    })
    .from(studentsTable)
    .where(and(inArray(studentsTable.classId, classIds), eq(studentsTable.isActive, true)))
    .groupBy(studentsTable.classId);

  const countMap = new Map(counts.map(r => [r.classId, Number(r.count)]));

  res.json(classes.map(c => ({ ...c, studentCount: countMap.get(c.id) ?? 0 })));
});

router.get("/:classId", requireAuth, async (req, res) => {
  const classes = await db
    .select({
      id: classesTable.id,
      schoolId: classesTable.schoolId,
      name: classesTable.name,
      section: classesTable.section,
      batch: classesTable.batch,
      teacherId: classesTable.teacherId,
      teacherName: usersTable.name,
      createdAt: classesTable.createdAt,
    })
    .from(classesTable)
    .leftJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(classesTable.id, Number(req.params.classId)));

  if (!classes[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(classes[0]);
});

router.post("/", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const { schoolId, name, section, batch, teacherId } = req.body;
  const [cls] = await db.insert(classesTable).values({
    schoolId: schoolId || req.user!.schoolId!,
    name,
    section,
    batch,
    teacherId,
  }).returning();
  res.status(201).json(cls);
});

router.put("/:classId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const { name, section, batch, teacherId } = req.body;
  const [updated] = await db.update(classesTable)
    .set({ name, section, batch, teacherId, updatedAt: new Date() })
    .where(eq(classesTable.id, Number(req.params.classId)))
    .returning();
  res.json(updated);
});

router.delete("/:classId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  await db.delete(classesTable).where(eq(classesTable.id, Number(req.params.classId)));
  res.json({ success: true, message: "Class deleted" });
});

export default router;
