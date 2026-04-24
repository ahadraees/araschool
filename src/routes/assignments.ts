import { Router } from "express";
import { db, assignmentsTable, teachersTable, classesTable, notificationsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function selectFields(includeFiles = false) {
  const base = {
    id: assignmentsTable.id,
    schoolId: assignmentsTable.schoolId,
    classId: assignmentsTable.classId,
    teacherId: assignmentsTable.teacherId,
    title: assignmentsTable.title,
    description: assignmentsTable.description,
    content: assignmentsTable.content,
    fileName: assignmentsTable.fileName,
    fileType: assignmentsTable.fileType,
    filesJson: assignmentsTable.filesJson,
    progressJson: assignmentsTable.progressJson,
    type: assignmentsTable.type,
    dueDate: assignmentsTable.dueDate,
    isPublished: assignmentsTable.isPublished,
    createdAt: assignmentsTable.createdAt,
    updatedAt: assignmentsTable.updatedAt,
  };
  if (includeFiles) return { ...base, fileBase64: assignmentsTable.fileBase64 };
  return base;
}

// ── List assignments ──────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  const { classId } = req.query;
  const schoolId = req.user!.schoolId;

  const conditions: any[] = [];
  if (schoolId) conditions.push(eq(assignmentsTable.schoolId, schoolId));
  if (classId)  conditions.push(eq(assignmentsTable.classId, Number(classId)));

  if (req.user!.role === "teacher") {
    const teacher = await db.query.teachersTable.findFirst({
      where: eq(teachersTable.userId, req.user!.id),
    });
    if (teacher) conditions.push(eq(assignmentsTable.teacherId, teacher.id));
  }

  const raw = await db.select(selectFields())
    .from(assignmentsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(assignmentsTable.createdAt));

  const assignments = raw.map(a => ({
    ...a,
    files: parseJson<any[]>(a.filesJson, []),
    progress: parseJson<any[]>(a.progressJson, []),
  }));

  res.json(assignments);
});

// ── Get single assignment (with file data) ────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const a = await db.query.assignmentsTable.findFirst({
    where: eq(assignmentsTable.id, Number(req.params.id)),
  });
  if (!a) { res.status(404).json({ error: "Not Found", message: "Assignment not found" }); return; }
  res.json({
    ...a,
    files: parseJson<any[]>(a.filesJson, []),
    progress: parseJson<any[]>(a.progressJson, []),
  });
});

// ── Create assignment ─────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
  const { classId, title, description, content, fileBase64, fileName, fileType, files, type, dueDate } = req.body;
  const schoolId = req.user!.schoolId!;

  let teacherId: number | null = null;
  if (req.user!.role === "teacher") {
    const teacher = await db.query.teachersTable.findFirst({
      where: eq(teachersTable.userId, req.user!.id),
    });
    if (!teacher) { res.status(400).json({ error: "Bad Request", message: "Teacher profile not found" }); return; }
    teacherId = teacher.id;
  } else {
    // Admin / super_admin: use provided teacherId or leave null (teacher_id is nullable)
    teacherId = req.body.teacherId ? Number(req.body.teacherId) : null;
  }

  // Support both old single-file and new multi-file upload
  const filesArr = Array.isArray(files) && files.length > 0 ? files : (fileBase64 ? [{ base64: fileBase64, name: fileName, type: fileType }] : []);

  const [assignment] = await db.insert(assignmentsTable).values({
    schoolId,
    classId: Number(classId),
    teacherId: teacherId ?? undefined,
    title,
    description,
    content,
    fileBase64: filesArr[0]?.base64 || null,
    fileName:   filesArr[0]?.name   || null,
    fileType:   filesArr[0]?.type   || null,
    filesJson:  filesArr.length > 0 ? JSON.stringify(filesArr) : null,
    type: type || "assignment",
    dueDate: dueDate || null,
    isPublished: true,
  }).returning();

  // Notify all students + parents (non-blocking)
  res.status(201).json({
    ...assignment,
    files: parseJson<any[]>(assignment.filesJson, []),
    progress: parseJson<any[]>(assignment.progressJson, []),
  });
});

// ── Add progress update ───────────────────────────────────────────────────────
router.post("/:id/progress", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
  const { message, files } = req.body;
  if (!message?.trim()) { res.status(400).json({ error: "Bad Request", message: "Message is required" }); return; }

  const a = await db.query.assignmentsTable.findFirst({
    where: eq(assignmentsTable.id, Number(req.params.id)),
  });
  if (!a) { res.status(404).json({ error: "Not Found", message: "Assignment not found" }); return; }

  const existing = parseJson<any[]>(a.progressJson, []);
  const newEntry = {
    message: message.trim(),
    files: Array.isArray(files) ? files : [],
    createdAt: new Date().toISOString(),
  };
  const updated = [newEntry, ...existing];

  const [result] = await db.update(assignmentsTable)
    .set({ progressJson: JSON.stringify(updated), updatedAt: new Date() })
    .where(eq(assignmentsTable.id, Number(req.params.id)))
    .returning();

  // Notify students about the progress update (non-blocking, best-effort)
  try {
    await db.insert(notificationsTable).values({
      schoolId: a.schoolId,
      title: `Assignment Update: ${a.title}`,
      message: message.trim(),
      type: "info",
      targetRole: "student",
    });
    await db.insert(notificationsTable).values({
      schoolId: a.schoolId,
      title: `Assignment Update: ${a.title}`,
      message: message.trim(),
      type: "info",
      targetRole: "parent",
    });
  } catch {}

  res.json({
    ...result,
    files: parseJson<any[]>(result.filesJson, []),
    progress: parseJson<any[]>(result.progressJson, []),
  });
});

// ── Update assignment ─────────────────────────────────────────────────────────
router.put("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
  const { title, description, content, fileBase64, fileName, fileType, files, type, dueDate, isPublished } = req.body;
  const filesArr = Array.isArray(files) && files.length > 0 ? files : (fileBase64 ? [{ base64: fileBase64, name: fileName, type: fileType }] : []);

  const [updated] = await db.update(assignmentsTable)
    .set({
      title, description, content,
      fileBase64: filesArr[0]?.base64 || null,
      fileName:   filesArr[0]?.name   || null,
      fileType:   filesArr[0]?.type   || null,
      filesJson:  filesArr.length > 0 ? JSON.stringify(filesArr) : null,
      type, dueDate, isPublished,
      updatedAt: new Date(),
    })
    .where(eq(assignmentsTable.id, Number(req.params.id)))
    .returning();

  res.json({ ...updated, files: parseJson<any[]>(updated.filesJson, []), progress: parseJson<any[]>(updated.progressJson, []) });
});

// ── Delete assignment ─────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
  await db.delete(assignmentsTable).where(eq(assignmentsTable.id, Number(req.params.id)));
  res.json({ success: true, message: "Assignment deleted" });
});

export default router;
