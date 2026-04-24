import { Router } from "express";
import { db, schoolsTable, usersTable, studentsTable, teachersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { hashPassword } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const schools = await db.select().from(schoolsTable).orderBy(schoolsTable.name);
  const enriched = await Promise.all(schools.map(async (school) => {
    const [studentCount] = await db.select({ count: sql<number>`count(*)` })
      .from(studentsTable).where(eq(studentsTable.schoolId, school.id));
    const [teacherCount] = await db.select({ count: sql<number>`count(*)` })
      .from(teachersTable).where(eq(teachersTable.schoolId, school.id));
    return { ...school, studentCount: Number(studentCount.count), teacherCount: Number(teacherCount.count) };
  }));
  res.json(enriched);
});

router.get("/:schoolId", requireAuth, async (req, res) => {
  const school = await db.query.schoolsTable.findFirst({
    where: eq(schoolsTable.id, Number(req.params.schoolId)),
  });
  if (!school) { res.status(404).json({ error: "Not found" }); return; }
  res.json(school);
});

router.post("/", requireAuth, requireRole("super_admin"), async (req, res) => {
  const { name, code, address, phone, email, logo, adminName, adminEmail, adminPassword } = req.body;
  if (!name || !code || !adminName || !adminEmail || !adminPassword) {
    res.status(400).json({ error: "Bad Request", message: "Missing required fields" });
    return;
  }

  const [school] = await db.insert(schoolsTable).values({ name, code, address, phone, email, ...(logo ? { logo } : {}) }).returning();

  await db.insert(usersTable).values({
    schoolId: school.id,
    email: adminEmail.toLowerCase(),
    passwordHash: await hashPassword(adminPassword),
    name: adminName,
    role: "admin",
  });

  res.status(201).json(school);
});

router.put("/:schoolId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const { name, code, address, phone, email, logo, themeColor, allowSelfFaceEnrollment } = req.body;
  const [updated] = await db.update(schoolsTable)
    .set({
      name, code, address, phone, email,
      ...(logo !== undefined ? { logo } : {}),
      ...(themeColor !== undefined ? { themeColor } : {}),
      ...(allowSelfFaceEnrollment !== undefined ? { allowSelfFaceEnrollment } : {}),
      updatedAt: new Date()
    })
    .where(eq(schoolsTable.id, Number(req.params.schoolId)))
    .returning();
  res.json(updated);
});

export default router;
