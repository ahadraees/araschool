import { Router } from "express";
import { db, examsTable, resultsTable, studentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const examId = req.query.examId ? Number(req.query.examId) : undefined;
  const studentId = req.query.studentId ? Number(req.query.studentId) : undefined;
  const classId = req.query.classId ? Number(req.query.classId) : undefined;

  const conditions = [];
  if (examId) conditions.push(eq(resultsTable.examId, examId));
  if (studentId) conditions.push(eq(resultsTable.studentId, studentId));

  const results = await db
    .select({
      id: resultsTable.id,
      examId: resultsTable.examId,
      studentId: resultsTable.studentId,
      marksObtained: resultsTable.marksObtained,
      grade: resultsTable.grade,
      remarks: resultsTable.remarks,
      createdAt: resultsTable.createdAt,
      studentName: studentsTable.name,
      examName: examsTable.name,
      subject: examsTable.subject,
      totalMarks: examsTable.totalMarks,
    })
    .from(resultsTable)
    .leftJoin(studentsTable, eq(resultsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const enriched = results.map(r => ({
    ...r,
    percentage: r.totalMarks ? (parseFloat(r.marksObtained as string) / r.totalMarks) * 100 : 0,
  }));

  if (classId) {
    const classStudents = await db.select({ id: studentsTable.id })
      .from(studentsTable).where(eq(studentsTable.classId, classId));
    const classStudentIds = new Set(classStudents.map(s => s.id));
    return res.json(enriched.filter(r => classStudentIds.has(r.studentId)));
  }

  res.json(enriched);
});

router.post("/", requireAuth, async (req, res) => {
  const { examId, studentId, marksObtained, remarks } = req.body;

  const exam = await db.query.examsTable.findFirst({ where: eq(examsTable.id, examId) });
  if (!exam) { res.status(404).json({ error: "Exam not found" }); return; }

  const percentage = (marksObtained / exam.totalMarks) * 100;
  let grade = "F";
  if (percentage >= 90) grade = "A+";
  else if (percentage >= 80) grade = "A";
  else if (percentage >= 70) grade = "B";
  else if (percentage >= 60) grade = "C";
  else if (percentage >= 50) grade = "D";

  const existing = await db.query.resultsTable.findFirst({
    where: and(eq(resultsTable.examId, examId), eq(resultsTable.studentId, studentId)),
  });

  if (existing) {
    const [updated] = await db.update(resultsTable)
      .set({ marksObtained: marksObtained.toString(), grade, remarks })
      .where(eq(resultsTable.id, existing.id))
      .returning();
    return res.status(201).json({ ...updated, percentage });
  }

  const [result] = await db.insert(resultsTable).values({
    examId,
    studentId,
    marksObtained: marksObtained.toString(),
    grade,
    remarks,
  }).returning();

  res.status(201).json({ ...result, percentage });
});

export default router;
