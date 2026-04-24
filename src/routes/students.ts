import { Router } from "express";
import { db, studentsTable, classesTable, usersTable, parentStudentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { hashPassword } from "../lib/auth.js";

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function randomPassword(len = 10) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function padId(n: number) { return String(n).padStart(5, "0"); }

// ── select shape ──────────────────────────────────────────────────────────────

const studentSelect = {
  id: studentsTable.id,
  schoolId: studentsTable.schoolId,
  classId: studentsTable.classId,
  userId: studentsTable.userId,
  rollNumber: studentsTable.rollNumber,
  admissionNumber: studentsTable.admissionNumber,
  name: studentsTable.name,
  fatherName: studentsTable.fatherName,
  dob: studentsTable.dob,
  gender: studentsTable.gender,
  nationality: studentsTable.nationality,
  cnicNumber: studentsTable.cnicNumber,
  address: studentsTable.address,
  phone: studentsTable.phone,
  email: studentsTable.email,
  parentName: studentsTable.parentName,
  parentPhone: studentsTable.parentPhone,
  parentEmail: studentsTable.parentEmail,
  parentCnic: studentsTable.parentCnic,
  previousSchool: studentsTable.previousSchool,
  admissionDate: studentsTable.admissionDate,
  photo: studentsTable.photo,
  bFormImage: studentsTable.bFormImage,
  parentCnicFront: studentsTable.parentCnicFront,
  parentCnicBack: studentsTable.parentCnicBack,
  previousSchoolCertificate: studentsTable.previousSchoolCertificate,
  conveyance: studentsTable.conveyance,
  generatedUsername: studentsTable.generatedUsername,
  generatedPassword: studentsTable.generatedPassword,
  isActive: studentsTable.isActive,
  createdAt: studentsTable.createdAt,
  className: classesTable.name,
  sectionName: classesTable.section,
};

// ── routes ───────────────────────────────────────────────────────────────────

// ── GET /face-descriptors — Must be before /:studentId ───────────────────────
router.get("/face-descriptors", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId;
  const rows = await db
    .select({
      id: studentsTable.id,
      name: studentsTable.name,
      admissionNumber: studentsTable.admissionNumber,
      photo: studentsTable.photo,
      fatherName: studentsTable.fatherName,
      classId: studentsTable.classId,
      faceDescriptor: studentsTable.faceDescriptor,
      className: classesTable.name,
      classSection: classesTable.section,
    })
    .from(studentsTable)
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(
      and(
        eq(studentsTable.isActive, true),
        schoolId ? eq(studentsTable.schoolId, schoolId) : undefined
      )
    );
  res.json(
    rows
      .filter(r => r.faceDescriptor)
      .map(r => ({
        id: r.id,
        name: r.name,
        admissionNumber: r.admissionNumber,
        photo: r.photo,
        fatherName: r.fatherName,
        className: r.className ? `${r.className}${r.classSection ? ` (${r.classSection})` : ""}` : "—",
        descriptor: JSON.parse(r.faceDescriptor!),
      }))
  );
});

router.get("/", requireAuth, async (req, res) => {
  const schoolId = req.query.schoolId ? Number(req.query.schoolId) : req.user!.schoolId;
  if (!schoolId) { res.status(400).json({ error: "schoolId required" }); return; }
  const classId  = req.query.classId ? Number(req.query.classId) : undefined;
  const search   = req.query.search as string | undefined;

  const conditions = [eq(studentsTable.schoolId, schoolId)];
  if (classId) conditions.push(eq(studentsTable.classId, classId));

  const students = await db
    .select(studentSelect)
    .from(studentsTable)
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(and(...conditions));

  const filtered = search
    ? students.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.rollNumber?.toLowerCase().includes(search.toLowerCase()) ||
        s.parentName?.toLowerCase().includes(search.toLowerCase()) ||
        s.admissionNumber?.toLowerCase().includes(search.toLowerCase())
      )
    : students;

  const role = req.user!.role;
  const isTeacher = role === "teacher" || role === "sub_admin";
  const result = filtered.filter(s => s.isActive).map(s => {
    if (!isTeacher) return s;
    const { parentPhone, parentCnic, parentCnicFront, parentCnicBack, generatedPassword, ...rest } = s as any;
    return rest;
  });
  res.json(result);
});

router.get("/:studentId", requireAuth, async (req, res) => {
  const students = await db
    .select(studentSelect)
    .from(studentsTable)
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(studentsTable.id, Number(req.params.studentId)));

  if (!students[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(students[0]);
});

router.post("/", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const {
    schoolId, classId, rollNumber, name, fatherName, dob, gender, nationality,
    cnicNumber, address, phone, email, parentName, parentPhone, parentEmail,
    parentCnic, previousSchool, admissionDate, photo, bFormImage,
    parentCnicFront, parentCnicBack, previousSchoolCertificate, conveyance,
  } = req.body;

  const sid = schoolId || req.user!.schoolId!;
  const year = new Date().getFullYear();

  // --- Insert student first to get the ID ---
  const pwd  = randomPassword();

  const [student] = await db.insert(studentsTable).values({
    schoolId: sid, classId, rollNumber, name, fatherName, dob, gender,
    nationality, cnicNumber, address, phone, email, parentName, parentPhone,
    parentEmail, parentCnic, previousSchool, admissionDate, photo, bFormImage,
    parentCnicFront, parentCnicBack, previousSchoolCertificate, conveyance,
    generatedPassword: pwd,
    admissionNumber: `ADM-${sid}-${year}-${Date.now().toString().slice(-6)}`,
  }).returning();

  // Auto-generate admission number + username using the new ID
  const admNum  = `ADM-${sid}-${year}-${padId(student.id)}`;
  const genUser = `STU${padId(student.id)}`;
  const genEmail = `stu${padId(student.id)}@school.local`;

  // Auto roll number: if classId provided, count existing students in that class
  // so the new student gets the next sequential number (e.g. class has 10 → roll = 11)
  let autoRollNumber: string;
  if (rollNumber) {
    autoRollNumber = rollNumber;
  } else if (classId) {
    const existing = await db.select({ id: studentsTable.id })
      .from(studentsTable)
      .where(and(eq(studentsTable.classId, classId), eq(studentsTable.isActive, true)));
    // Exclude the student we just inserted when counting
    const count = existing.filter(r => r.id !== student.id).length;
    autoRollNumber = String(count + 1);
  } else {
    autoRollNumber = `RN${padId(student.id)}`;
  }

  // Create user account for student portal access — store username so login by username works
  const [user] = await db.insert(usersTable).values({
    schoolId: sid,
    email: genEmail,
    username: genUser,
    passwordHash: await hashPassword(pwd),
    name,
    role: "student",
  }).returning();

  // Update with final admission number, roll number, username, and userId
  const [updated] = await db.update(studentsTable)
    .set({ admissionNumber: admNum, rollNumber: autoRollNumber, generatedUsername: genUser, userId: user.id, updatedAt: new Date() })
    .where(eq(studentsTable.id, student.id))
    .returning();

  // ── Auto-generate parent credentials ─────────────────────────────────────
  let parentCredentials: { username: string; password: string; email: string } | null = null;

  if (parentName || parentEmail || parentPhone) {
    const parentPwd      = randomPassword();
    const parentUsername = `PAR${padId(student.id)}`;
    const parentEmail2   = parentEmail || `par${padId(student.id)}@school.local`;

    // Check if parent email already has an account
    let parentUser: typeof usersTable.$inferSelect | undefined;
    if (parentEmail) {
      const existing = await db.select().from(usersTable)
        .where(and(eq(usersTable.email, parentEmail), eq(usersTable.role, "parent")));
      parentUser = existing[0];
    }

    if (!parentUser) {
      // Create new parent user account
      const [newParentUser] = await db.insert(usersTable).values({
        schoolId: sid,
        email: parentEmail2,
        username: parentUsername,
        passwordHash: await hashPassword(parentPwd),
        name: parentName || "Parent",
        role: "parent",
      }).returning();
      parentUser = newParentUser;
      parentCredentials = { username: parentUsername, password: parentPwd, email: parentEmail2 };
    }

    // Link parent to student (avoid duplicates)
    const existingLink = await db.select().from(parentStudentsTable)
      .where(and(eq(parentStudentsTable.parentUserId, parentUser.id), eq(parentStudentsTable.studentId, student.id)));
    if (!existingLink[0]) {
      await db.insert(parentStudentsTable).values({
        parentUserId: parentUser.id,
        studentId: student.id,
      });
    }
  }

  res.status(201).json({
    ...updated,
    generatedPassword: pwd, // return plaintext once for admin to note
    parentCredentials,      // null if no parent info provided
  });
});

router.put("/:studentId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const {
    classId, rollNumber, name, fatherName, dob, gender, nationality,
    cnicNumber, address, phone, email, parentName, parentPhone, parentEmail,
    parentCnic, previousSchool, admissionDate, photo, bFormImage,
    parentCnicFront, parentCnicBack, previousSchoolCertificate, conveyance,
  } = req.body;

  const [updated] = await db.update(studentsTable)
    .set({
      classId, rollNumber, name, fatherName, dob, gender, nationality,
      cnicNumber, address, phone, email, parentName, parentPhone, parentEmail,
      parentCnic, previousSchool, admissionDate, photo, bFormImage,
      parentCnicFront, parentCnicBack, previousSchoolCertificate, conveyance,
      updatedAt: new Date(),
    })
    .where(eq(studentsTable.id, Number(req.params.studentId)))
    .returning();

  // Also update user name if changed
  if (name && updated.userId) {
    await db.update(usersTable).set({ name, updatedAt: new Date() }).where(eq(usersTable.id, updated.userId));
  }

  res.json(updated);
});

router.delete("/:studentId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  await db.update(studentsTable).set({ isActive: false }).where(eq(studentsTable.id, Number(req.params.studentId)));
  res.json({ success: true, message: "Student deleted" });
});

// ── POST /:studentId/reset-parent-password — Admin resets parent login ────────
router.post("/:studentId/reset-parent-password", requireAuth, requireRole("super_admin", "admin", "sub_admin"), async (req, res) => {
  const id = Number(req.params.studentId);
  const student = await db.query.studentsTable.findFirst({ where: eq(studentsTable.id, id) });
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  // Find the parent linked to this student
  const link = await db.query.parentStudentsTable.findFirst({ where: eq(parentStudentsTable.studentId, id) });
  if (!link) { res.status(404).json({ error: "No parent account linked to this student" }); return; }

  const parentUser = await db.query.usersTable.findFirst({ where: eq(usersTable.id, link.parentUserId) });
  if (!parentUser) { res.status(404).json({ error: "Parent user account not found" }); return; }

  const newPwd = randomPassword();
  await db.update(usersTable)
    .set({ passwordHash: await hashPassword(newPwd), updatedAt: new Date() })
    .where(eq(usersTable.id, parentUser.id));

  res.json({
    success: true,
    parentCredentials: {
      username: parentUser.username,
      email: parentUser.email,
      password: newPwd,
      name: parentUser.name,
    },
  });
});

// ── POST /:studentId/face — Save face descriptor ──────────────────────────────
router.post("/:studentId/face", requireAuth, async (req, res) => {
  const { descriptor } = req.body;
  if (!descriptor || !Array.isArray(descriptor)) {
    res.status(400).json({ error: "descriptor array required" });
    return;
  }
  const id = Number(req.params.studentId);
  const [updated] = await db
    .update(studentsTable)
    .set({ faceDescriptor: JSON.stringify(descriptor), updatedAt: new Date() })
    .where(eq(studentsTable.id, id))
    .returning({ id: studentsTable.id });
  if (!updated) { res.status(404).json({ error: "Student not found" }); return; }
  res.json({ success: true, studentId: id });
});

// ── DELETE /:studentId/face — Clear face descriptor ───────────────────────────
router.delete("/:studentId/face", requireAuth, async (req, res) => {
  const id = Number(req.params.studentId);
  await db.update(studentsTable).set({ faceDescriptor: null, updatedAt: new Date() }).where(eq(studentsTable.id, id));
  res.json({ success: true });
});

// ── POST /bulk-import — CSV import ────────────────────────────────────────────
// Accepts array of student rows, creates user + student for each
router.post("/bulk-import", requireAuth, requireRole("admin", "super_admin", "sub_admin"), async (req, res) => {
  const { user } = req as any;
  const { students } = req.body as { students: any[] };
  if (!Array.isArray(students) || students.length === 0) {
    res.status(400).json({ error: "students[] array required" }); return;
  }

  const results: { row: number; name: string; status: "success" | "error"; message?: string }[] = [];
  let successCount = 0;

  for (let i = 0; i < students.length; i++) {
    const row = students[i];
    try {
      const name = String(row.name || "").trim();
      if (!name) { results.push({ row: i + 1, name: "—", status: "error", message: "Name is required" }); continue; }

      // Generate username + password
      const emailBase = name.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z.]/g, "");
      const tempPwd = randomPassword(8);
      const emailDomain = `@school.local`;

      // Find a unique email
      let email = `${emailBase}${emailDomain}`;
      let attempt = 1;
      while (true) {
        const existing = await db.query.usersTable.findFirst({ where: eq(usersTable.email, email) });
        if (!existing) break;
        email = `${emailBase}${attempt}${emailDomain}`;
        attempt++;
      }

      const [newUser] = await db.insert(usersTable).values({
        schoolId: user.schoolId,
        email,
        username: email.split("@")[0],
        passwordHash: await hashPassword(tempPwd),
        name,
        role: "student",
      }).returning();

      // Get classId if className provided
      let classId: number | undefined;
      if (row.className) {
        const cls = await db.query.classesTable.findFirst({
          where: and(eq(classesTable.schoolId, user.schoolId), eq(classesTable.name, String(row.className).trim())),
        });
        if (cls) classId = cls.id;
      }

      const [newStudent] = await db.insert(studentsTable).values({
        schoolId: user.schoolId,
        userId: newUser.id,
        classId: classId ?? null,
        name,
        fatherName: row.fatherName || row.father_name || null,
        gender: row.gender || null,
        dob: row.dob || null,
        phone: row.phone || null,
        parentPhone: row.parentPhone || row.parent_phone || null,
        parentName: row.parentName || row.parent_name || null,
        address: row.address || null,
        rollNumber: row.rollNumber || row.roll_number || null,
        admissionNumber: row.admissionNumber || row.admission_number || null,
        generatedUsername: email,
        generatedPassword: tempPwd,
        isActive: true,
      }).returning();

      results.push({ row: i + 1, name, status: "success" });
      successCount++;
    } catch (err: any) {
      results.push({ row: i + 1, name: String(row.name || ""), status: "error", message: err.message });
    }
  }

  res.json({ success: true, total: students.length, successCount, failCount: students.length - successCount, results });
});

// ── GET /report-card/:studentId — aggregate report card data ─────────────────
router.get("/report-card/:studentId", requireAuth, async (req, res) => {
  const { user } = req as any;
  const studentId = Number(req.params.studentId);
  const { session, examType } = req.query;

  try {
    const { examsTable, resultsTable } = await import("@workspace/db");
    const { ilike } = await import("drizzle-orm");

    const student = await db.query.studentsTable.findFirst({
      where: and(eq(studentsTable.id, studentId), eq(studentsTable.schoolId, user.schoolId)),
    });
    if (!student) { res.status(404).json({ error: "Student not found" }); return; }

    // Get all exams for student's class
    const examConditions: any[] = [];
    if (student.classId) examConditions.push(eq(examsTable.classId, student.classId));
    if (session) examConditions.push(eq(examsTable.session, String(session)));
    if (examType) examConditions.push(eq(examsTable.examType, String(examType)));
    examConditions.push(eq(examsTable.status, "published"));

    const exams = await db.query.examsTable.findMany({
      where: examConditions.length > 0 ? and(...examConditions) : undefined,
      orderBy: (t, { asc }) => [asc(t.subject), asc(t.examDate)],
    });

    const examIds = exams.map(e => e.id);
    let marks: any[] = [];
    if (examIds.length > 0) {
      const { inArray } = await import("drizzle-orm");
      marks = await db.select().from(resultsTable).where(
        and(eq(resultsTable.studentId, studentId), inArray(resultsTable.examId, examIds))
      );
    }

    const marksMap = new Map(marks.map(m => [m.examId, m]));

    const rows = exams.map(e => {
      const m = marksMap.get(e.id);
      const obtained = m ? parseFloat(m.marksObtained as string) : null;
      const pct = obtained !== null ? (obtained / e.totalMarks) * 100 : null;
      return {
        subject: e.subject,
        examName: e.name,
        examType: e.examType,
        totalMarks: e.totalMarks,
        passingMarks: e.passingMarks,
        marksObtained: obtained,
        grade: m?.grade ?? null,
        percentage: pct ? Math.round(pct * 10) / 10 : null,
        isAbsent: m?.isAbsent ?? false,
        remarks: m?.remarks ?? null,
        examDate: e.examDate,
        status: m ? (obtained !== null && obtained >= e.passingMarks ? "pass" : "fail") : "pending",
      };
    });

    const totalObtained = rows.reduce((s, r) => s + (r.marksObtained ?? 0), 0);
    const totalMax = rows.reduce((s, r) => s + (r.totalMarks ?? 0), 0);
    const overallPct = totalMax > 0 ? Math.round((totalObtained / totalMax) * 1000) / 10 : 0;

    let overallGrade = "F";
    if (overallPct >= 90) overallGrade = "A+";
    else if (overallPct >= 80) overallGrade = "A";
    else if (overallPct >= 70) overallGrade = "B";
    else if (overallPct >= 60) overallGrade = "C";
    else if (overallPct >= 50) overallGrade = "D";

    res.json({
      student: {
        id: student.id,
        name: student.name,
        fatherName: student.fatherName,
        admissionNumber: student.admissionNumber,
        rollNumber: student.rollNumber,
        classId: student.classId,
        photo: student.photo,
      },
      session: session ?? null,
      examType: examType ?? null,
      rows,
      summary: { totalObtained, totalMax, overallPct, overallGrade, passCount: rows.filter(r => r.status === "pass").length, failCount: rows.filter(r => r.status === "fail").length },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
