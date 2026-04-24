import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const schoolsTable = pgTable("schools", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  logo: text("logo"),
  themeColor: text("theme_color"),
  allowSelfFaceEnrollment: boolean("allow_self_face_enrollment").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").references(() => schoolsTable.id),
  email: text("email").notNull().unique(),
  username: text("username").unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("admin"), // super_admin, admin, teacher, accountant, parent, sub_admin
  permissions: text("permissions").default("[]"), // JSON array of module keys for sub_admin
  isActive: boolean("is_active").notNull().default(true),
  lastLogin: timestamp("last_login"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSchoolSchema = createInsertSchema(schoolsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true, lastLogin: true });
export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true, createdAt: true });

export type School = typeof schoolsTable.$inferSelect;
export type User = typeof usersTable.$inferSelect;
export type Session = typeof sessionsTable.$inferSelect;
