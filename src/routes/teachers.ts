import { Router } from "express";
import { db, teachersTable, usersTable, teacherClassesTable, classesTable, expensesTable } from "@workspace/db";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { hashPassword } from "../lib/auth.js";
import { normalizeSubject } from "../lib/normalize.js";

const router = Router();

function padId(n: number) { return String(n).padStart(5, "0"); }

// ── Helper: auto-create/update current-month salary expense ──────────────────
async function upsertMonthlySalaryExpense(
  teacherId: number,
  teacherName: string,
  teacherCode: string,
  schoolId: number,
  salary: number,
  createdBy?: number
) {
  if (!salary || salary <= 0) return;

  const now    = new Date();
  const year   = now.getFullYear();
  const month  = String(now.getMonth() + 1).padStart(2, "0");
  const firstDay = `${year}-${month}-01`;
  const description = `Monthly Salary — ${teacherCode} | ${now.toLocaleString("en-PK", { month: "long", year: "numeric" })}`;

  // Check if salary expense already exists for this teacher this month
  const existing = await db
    .select({ id: expensesTable.id })
    .from(expensesTable)
    .where(
      and(
        eq(expensesTable.teacherId, teacherId),
        eq(expensesTable.category, "salary"),
        sql`date_trunc('month', ${expensesTable.date}) = date_trunc('month', ${firstDay}::date)`
      )
    )
    .limit(1);

  if (existing[0]) {
    // Update amount if salary changed, but only if still unpaid
    await db
      .update(expensesTable)
      .set({ amount: String(salary), description })
      .where(
        and(
          eq(expensesTable.id, existing[0].id),
          eq(expensesTable.status, "unpaid")
        )
      );
  } else {
    // Create new salary expense for this month
    await db.insert(expensesTable).values({
      schoolId,
      category:      "salary",
      subCategory:   teacherCode,
      amount:        String(salary),
      date:          firstDay,
      description,
      paidTo:        teacherName,
      paymentMethod: "bank",
      status:        "unpaid",
      teacherId,
      createdBy:     createdBy ?? null,
    });
  }
}

// ── select shape ──────────────────────────────────────────────────────────────
const teacherSelect = {
  id:             teachersTable.id,
  userId:         teachersTable.userId,
  schoolId:       teachersTable.schoolId,
  name:           usersTable.name,
  email:          usersTable.email,
  phone:          teachersTable.phone,
  subject:        teachersTable.subject,
  qualification:  teachersTable.qualification,
  joinDate:       teachersTable.joinDate,
  cnic:           teachersTable.cnic,
  dob:            teachersTable.dob,
  address:        teachersTable.address,
  experience:     teachersTable.experience,
  salary:         teachersTable.salary,
  teacherCode:    teachersTable.teacherCode,
  photo:          teachersTable.photo,
  cnicFront:      teachersTable.cnicFront,
  cnicBack:       teachersTable.cnicBack,
  faceDescriptor: teachersTable.faceDescriptor,
  isActive:       teachersTable.isActive,
  createdAt:      teachersTable.createdAt,
};

// ── routes ───────────────────────────────────────────────────────────────────

// Helper: fetch class assignments (class + subject) for a list of teacher IDs
async function fetchTeacherAssignments(teacherIds: number[]) {
  return db
    .select({
      teacherId: teacherClassesTable.teacherId,
      classId:   teacherClassesTable.classId,
      subject:   teacherClassesTable.subject,
      id:        classesTable.id,
      name:      classesTable.name,
      section:   classesTable.section,
    })
    .from(teacherClassesTable)
    .leftJoin(classesTable, eq(teacherClassesTable.classId, classesTable.id))
    .where(inArray(teacherClassesTable.teacherId, teacherIds));
}

router.get("/", requireAuth, async (req, res) => {
  const schoolId = req.query.schoolId ? Number(req.query.schoolId) : req.user!.schoolId;
  if (!schoolId) { res.status(400).json({ error: "schoolId required" }); return; }

  const teachers = await db
    .select(teacherSelect)
    .from(teachersTable)
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(and(eq(teachersTable.schoolId, schoolId), eq(teachersTable.isActive, true)));

  if (teachers.length === 0) { res.json([]); return; }

  const teacherIds = teachers.map(t => t.id);
  const allClasses = await fetchTeacherAssignments(teacherIds);

  const classMap = new Map<number, typeof allClasses>();
  allClasses.forEach(c => {
    if (!classMap.has(c.teacherId)) classMap.set(c.teacherId, []);
    classMap.get(c.teacherId)!.push(c);
  });

  res.json(teachers.map(t => ({ ...t, classes: classMap.get(t.id) ?? [] })));
});

// ── GET /my-assignments — teacher gets their own class+subject assignments ─────
router.get("/my-assignments", requireAuth, async (req, res) => {
  if (req.user!.role !== "teacher") { res.status(403).json({ error: "Forbidden" }); return; }

  const teacher = await db.query.teachersTable.findFirst({
    where: eq(teachersTable.userId, req.user!.id),
  });
  if (!teacher) { res.status(404).json({ error: "Teacher record not found" }); return; }

  const assignments = await db
    .select({
      classId:  teacherClassesTable.classId,
      subject:  teacherClassesTable.subject,
      name:     classesTable.name,
      section:  classesTable.section,
    })
    .from(teacherClassesTable)
    .leftJoin(classesTable, eq(teacherClassesTable.classId, classesTable.id))
    .where(eq(teacherClassesTable.teacherId, teacher.id));

  res.json({ teacherId: teacher.id, subject: teacher.subject, assignments });
});

// ── GET /face-descriptors — return enrolled teacher face data (for kiosk) ─────
router.get("/face-descriptors", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId;
  if (!schoolId) { res.status(400).json({ error: "schoolId required" }); return; }
  const rows = await db
    .select({
      id:             teachersTable.id,
      name:           usersTable.name,
      teacherCode:    teachersTable.teacherCode,
      photo:          teachersTable.photo,
      faceDescriptor: teachersTable.faceDescriptor,
    })
    .from(teachersTable)
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(and(eq(teachersTable.isActive, true), eq(teachersTable.schoolId, schoolId)));

  res.json(
    rows
      .filter(r => r.faceDescriptor)
      .map(r => ({
        id:          r.id,
        name:        r.name,
        teacherCode: r.teacherCode,
        photo:       r.photo,
        descriptor:  JSON.parse(r.faceDescriptor!),
      }))
  );
});

// ── POST /:teacherId/face — save face descriptor for a teacher (admin only) ───
router.post("/:teacherId/face", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const { descriptor } = req.body as { descriptor: number[] };
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    res.status(400).json({ error: "Invalid descriptor — expected 128-element array" });
    return;
  }
  await db
    .update(teachersTable)
    .set({ faceDescriptor: JSON.stringify(descriptor) })
    .where(eq(teachersTable.id, Number(req.params.teacherId)));
  res.json({ ok: true });
});

// ── DELETE /:teacherId/face — remove face descriptor (admin only) ─────────────
router.delete("/:teacherId/face", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  await db
    .update(teachersTable)
    .set({ faceDescriptor: null })
    .where(eq(teachersTable.id, Number(req.params.teacherId)));
  res.json({ ok: true });
});

router.get("/:teacherId", requireAuth, async (req, res) => {
  const teacher = await db
    .select(teacherSelect)
    .from(teachersTable)
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(teachersTable.id, Number(req.params.teacherId)));

  if (!teacher[0]) { res.status(404).json({ error: "Not found" }); return; }

  const classes = await db
    .select({
      id:      classesTable.id,
      name:    classesTable.name,
      section: classesTable.section,
      subject: teacherClassesTable.subject,
    })
    .from(teacherClassesTable)
    .leftJoin(classesTable, eq(teacherClassesTable.classId, classesTable.id))
    .where(eq(teacherClassesTable.teacherId, teacher[0].id));

  res.json({ ...teacher[0], classes });
});

// ── GET /salary-history/:teacherId ────────────────────────────────────────────
router.get("/:teacherId/salary-history", requireAuth, async (req, res) => {
  const teacherId = Number(req.params.teacherId);
  const schoolId  = req.user!.schoolId;

  // Verify teacher belongs to school
  const teacher = await db
    .select({ id: teachersTable.id, salary: teachersTable.salary, teacherCode: teachersTable.teacherCode })
    .from(teachersTable)
    .where(and(
      eq(teachersTable.id, teacherId),
      schoolId ? eq(teachersTable.schoolId, schoolId) : sql`1=1`
    ))
    .limit(1);

  if (!teacher[0]) { res.status(404).json({ error: "Not found" }); return; }

  const salaryRecords = await db
    .select({
      id:            expensesTable.id,
      amount:        expensesTable.amount,
      date:          expensesTable.date,
      description:   expensesTable.description,
      status:        expensesTable.status,
      paymentMethod: expensesTable.paymentMethod,
      createdAt:     expensesTable.createdAt,
    })
    .from(expensesTable)
    .where(
      and(
        eq(expensesTable.teacherId, teacherId),
        eq(expensesTable.category, "salary")
      )
    )
    .orderBy(desc(expensesTable.date))
    .limit(24);

  res.json({
    currentSalary: teacher[0].salary,
    teacherCode:   teacher[0].teacherCode,
    history:       salaryRecords,
  });
});

// ── PATCH /salary-pay/:expenseId — mark salary as paid ───────────────────────
router.patch("/salary-pay/:expenseId", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const expenseId = Number(req.params.expenseId);
  const { paymentMethod } = req.body;
  const schoolId = req.user!.schoolId;

  const [updated] = await db
    .update(expensesTable)
    .set({
      status:        "paid",
      paymentMethod: paymentMethod || "bank",
    })
    .where(
      and(
        eq(expensesTable.id, expenseId),
        eq(expensesTable.category, "salary"),
        schoolId ? eq(expensesTable.schoolId, schoolId) : sql`1=1`
      )
    )
    .returning();

  if (!updated) { res.status(404).json({ error: "Salary record not found" }); return; }
  res.json({ success: true, expense: updated });
});

// ── PATCH /salary-unpay/:expenseId — mark salary as unpaid ───────────────────
router.patch("/salary-unpay/:expenseId", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const expenseId = Number(req.params.expenseId);
  const schoolId  = req.user!.schoolId;

  const [updated] = await db
    .update(expensesTable)
    .set({ status: "unpaid" })
    .where(
      and(
        eq(expensesTable.id, expenseId),
        eq(expensesTable.category, "salary"),
        schoolId ? eq(expensesTable.schoolId, schoolId) : sql`1=1`
      )
    )
    .returning();

  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ success: true, expense: updated });
});

function randomPassword(len = 10) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

router.post("/", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const {
    schoolId, name, email, password,
    phone, subject, qualification, joinDate, classIds, classTeacherId,
    classAssignments,
    cnic, dob, address, experience, salary, photo, cnicFront, cnicBack,
  } = req.body;

  const sid = schoolId || req.user!.schoolId;
  const generatedPassword = password || randomPassword();

  const placeholderEmail = `tch_${Date.now()}_${Math.random().toString(36).slice(2)}@school.local`;

  const [user] = await db.insert(usersTable).values({
    schoolId: sid,
    email:    placeholderEmail,
    passwordHash: await hashPassword(generatedPassword),
    name,
    role: "teacher",
  }).returning();

  const [teacher] = await db.insert(teachersTable).values({
    userId:        user.id,
    schoolId:      sid!,
    phone,
    subject: normalizeSubject(subject),
    qualification,
    joinDate,
    cnic,
    dob,
    address,
    experience,
    salary:    salary ? String(salary) : undefined,
    photo,
    cnicFront,
    cnicBack,
    isActive:  true,
  }).returning();

  const teacherCode = `TCH${padId(teacher.id)}`;
  const genUsername = teacherCode;

  let finalEmail: string;
  if (email) {
    const existing = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase()))
      .limit(1);
    finalEmail = existing.length === 0 ? email.toLowerCase() : `tch${padId(teacher.id)}@school.local`;
  } else {
    finalEmail = `tch${padId(teacher.id)}@school.local`;
  }

  const [updated] = await db.update(teachersTable)
    .set({ teacherCode, updatedAt: new Date() })
    .where(eq(teachersTable.id, teacher.id))
    .returning();

  await db.update(usersTable)
    .set({ email: finalEmail, username: genUsername, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  // classAssignments: [{classId, subject}][] — preferred over classIds
  const assignments: { classId: number; subject?: string }[] = classAssignments && classAssignments.length > 0
    ? classAssignments
    : (classIds && classIds.length > 0 ? classIds.map((cid: number) => ({ classId: cid })) : []);

  if (assignments.length > 0) {
    await db.insert(teacherClassesTable).values(
      assignments.map(a => ({ teacherId: teacher.id, classId: Number(a.classId), subject: normalizeSubject(a.subject) ?? null }))
    );
  }

  if (classTeacherId) {
    await db.update(classesTable)
      .set({ teacherId: teacher.id, updatedAt: new Date() })
      .where(eq(classesTable.id, Number(classTeacherId)));
    const exists = await db.select({ id: teacherClassesTable.id })
      .from(teacherClassesTable)
      .where(and(
        eq(teacherClassesTable.teacherId, teacher.id),
        eq(teacherClassesTable.classId, Number(classTeacherId)),
      ));
    if (!exists[0]) {
      await db.insert(teacherClassesTable).values({ teacherId: teacher.id, classId: Number(classTeacherId), subject: normalizeSubject(subject) ?? null });
    }
  }

  // ── Auto-create current month salary expense ──────────────────────────────
  if (salary && Number(salary) > 0 && sid) {
    await upsertMonthlySalaryExpense(teacher.id, name, teacherCode, sid, Number(salary), req.user!.id);
  }

  res.status(201).json({
    ...updated,
    teacherId: teacher.id,
    name,
    email:             finalEmail,
    teacherCode,
    generatedUsername: genUsername,
    generatedPassword,
    classes:           [],
  });
});

router.put("/:teacherId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const {
    name, phone, subject, qualification, joinDate, classIds,
    classAssignments, classTeacherId,
    cnic, dob, address, experience, salary, photo, cnicFront, cnicBack,
  } = req.body;
  const teacherId = Number(req.params.teacherId);

  const teacher = await db.query.teachersTable.findFirst({ where: eq(teachersTable.id, teacherId) });
  if (!teacher) { res.status(404).json({ error: "Not found" }); return; }

  if (name) {
    await db.update(usersTable).set({ name, updatedAt: new Date() }).where(eq(usersTable.id, teacher.userId));
  }

  const [updated] = await db.update(teachersTable)
    .set({ phone, subject: normalizeSubject(subject), qualification, joinDate, cnic, dob, address, experience, salary: salary ? String(salary) : undefined, photo, cnicFront, cnicBack, updatedAt: new Date() })
    .where(eq(teachersTable.id, teacherId))
    .returning();

  // Support both classAssignments (preferred) and legacy classIds
  if (classAssignments !== undefined) {
    await db.delete(teacherClassesTable).where(eq(teacherClassesTable.teacherId, teacherId));
    if (classAssignments.length > 0) {
      await db.insert(teacherClassesTable).values(
        classAssignments.map((a: { classId: number; subject?: string }) => ({ teacherId, classId: Number(a.classId), subject: normalizeSubject(a.subject) ?? null }))
      );
    }
  } else if (classIds !== undefined) {
    await db.delete(teacherClassesTable).where(eq(teacherClassesTable.teacherId, teacherId));
    if (classIds.length > 0) {
      await db.insert(teacherClassesTable).values(classIds.map((classId: number) => ({ teacherId, classId, subject: normalizeSubject(subject) ?? null })));
    }
  }

  // ── Homeroom class assignment (classTeacherId) ─────────────────────────────
  // classTeacherId: the class where this teacher is THE class/homeroom teacher.
  // First clear any previous homeroom assignment for this teacher, then set new.
  if (classTeacherId !== undefined) {
    // Remove old homeroom assignment (set teacherId=null on classes that had this teacher)
    await db.update(classesTable)
      .set({ teacherId: null as any, updatedAt: new Date() })
      .where(eq(classesTable.teacherId, teacherId));

    if (classTeacherId) {
      // Set the new homeroom class
      await db.update(classesTable)
        .set({ teacherId, updatedAt: new Date() })
        .where(eq(classesTable.id, Number(classTeacherId)));
    }
  }

  // ── Update/create current month salary expense when salary changes ─────────
  if (salary && Number(salary) > 0 && teacher.schoolId) {
    const teacherName = name || teacher.teacherCode || `Teacher ${teacherId}`;
    await upsertMonthlySalaryExpense(
      teacherId, teacherName, teacher.teacherCode || `TCH${padId(teacherId)}`,
      teacher.schoolId, Number(salary), req.user!.id
    );
  }

  res.json({ ...updated, name });
});

router.delete("/:teacherId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const teacherId = Number(req.params.teacherId);
  const teacher = await db.query.teachersTable.findFirst({ where: eq(teachersTable.id, teacherId) });
  if (!teacher) { res.status(404).json({ error: "Not found" }); return; }

  await db.delete(teacherClassesTable).where(eq(teacherClassesTable.teacherId, teacherId));
  await db.update(teachersTable).set({ isActive: false }).where(eq(teachersTable.id, teacherId));
  res.json({ success: true, message: "Teacher deactivated" });
});

export default router;
