import { pgTable, serial, text, integer, boolean, timestamp, date, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { schoolsTable, usersTable } from "./users";

export const classesTable = pgTable("classes", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  name: text("name").notNull(),
  section: text("section"),
  batch: text("batch"),
  teacherId: integer("teacher_id").references(() => teachersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const teachersTable = pgTable("teachers", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  phone: text("phone"),
  subject: text("subject"),
  qualification: text("qualification"),
  joinDate: date("join_date"),
  cnic: text("cnic"),
  dob: date("dob"),
  address: text("address"),
  experience: text("experience"),
  teacherCode: text("teacher_code"),
  photo: text("photo"),
  cnicFront: text("cnic_front"),
  cnicBack: text("cnic_back"),
  salary: numeric("salary", { precision: 10, scale: 2 }),
  skillTags: text("skill_tags"), // JSON array of tag strings
  faceDescriptor: text("face_descriptor"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const teacherClassesTable = pgTable("teacher_classes", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id),
  classId: integer("class_id").notNull().references(() => classesTable.id),
  subject: text("subject"),
});

// Feature 1: Teacher Responsibilities
export const teacherResponsibilitiesTable = pgTable("teacher_responsibilities", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  classId: integer("class_id").references(() => classesTable.id),
  subjects: text("subjects"), // JSON array of subject strings
  periodsPerDay: integer("periods_per_day").default(0),
  examDuty: boolean("exam_duty").notNull().default(false),
  eventDuty: boolean("event_duty").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Feature 3: Teacher Duty Calendar
export const teacherDutiesTable = pgTable("teacher_duties", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  type: text("type").notNull(), // invigilation | assembly | meeting | parent_dealing
  title: text("title").notNull(),
  dutyDate: date("duty_date").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Feature 4: Teacher Warning / Appreciation Records
export const teacherRecordsTable = pgTable("teacher_records", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  type: text("type").notNull(), // warning | late_coming | appreciation | performance_note
  title: text("title").notNull(),
  description: text("description"),
  recordDate: date("record_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Feature 5: Teacher Replacement Management
export const teacherReplacementsTable = pgTable("teacher_replacements", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  absentTeacherId: integer("absent_teacher_id").notNull().references(() => teachersTable.id),
  replacementTeacherId: integer("replacement_teacher_id").notNull().references(() => teachersTable.id),
  classId: integer("class_id").references(() => classesTable.id),
  replacementDate: date("replacement_date").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("active"), // active | completed
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Feature 6: Teacher Permission Control
export const teacherPermissionsTable = pgTable("teacher_permissions", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id),
  canUploadMarks: boolean("can_upload_marks").notNull().default(true),
  canUploadHomework: boolean("can_upload_homework").notNull().default(true),
  canContactParents: boolean("can_contact_parents").notNull().default(true),
  canEditAttendance: boolean("can_edit_attendance").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Feature 7: Teacher Contract / Renewal Alerts
export const teacherContractsTable = pgTable("teacher_contracts", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  contractType: text("contract_type").default("permanent"), // permanent | temporary | contractual
  contractStartDate: date("contract_start_date"),
  contractEndDate: date("contract_end_date"),
  documentRenewalDate: date("document_renewal_date"),
  salaryIncrementDate: date("salary_increment_date"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Feature 9: Teacher Meeting Records
export const teacherMeetingsTable = pgTable("teacher_meetings", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  meetingDate: date("meeting_date").notNull(),
  topic: text("topic").notNull(),
  decisions: text("decisions"),
  attendeeIds: text("attendee_ids"), // JSON array of teacherIds
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Feature 10: Teacher Performance / Growth Tracking
export const teacherPerformanceTable = pgTable("teacher_performance", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  month: integer("month").notNull(),
  year: integer("year").notNull(),
  attendanceScore: integer("attendance_score").default(0),    // 0-100
  disciplineScore: integer("discipline_score").default(0),    // 0-100
  teachingScore: integer("teaching_score").default(0),        // 0-100
  parentFeedbackScore: integer("parent_feedback_score").default(0), // 0-100
  trainingRequired: boolean("training_required").notNull().default(false),
  weakAreas: text("weak_areas"),     // JSON array of strings
  strengthAreas: text("strength_areas"), // JSON array of strings
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const studentsTable = pgTable("students", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  classId: integer("class_id").references(() => classesTable.id),
  userId: integer("user_id").references(() => usersTable.id),
  rollNumber: text("roll_number"),
  admissionNumber: text("admission_number"),
  name: text("name").notNull(),
  fatherName: text("father_name"),
  dob: date("dob"),
  gender: text("gender"),
  nationality: text("nationality"),
  cnicNumber: text("cnic_number"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  parentName: text("parent_name"),
  parentPhone: text("parent_phone"),
  parentEmail: text("parent_email"),
  parentCnic: text("parent_cnic"),
  previousSchool: text("previous_school"),
  admissionDate: date("admission_date"),
  photo: text("photo"),
  bFormImage: text("b_form_image"),
  parentCnicFront: text("parent_cnic_front"),
  parentCnicBack: text("parent_cnic_back"),
  previousSchoolCertificate: text("previous_school_certificate"),
  conveyance: text("conveyance"),
  generatedUsername: text("generated_username"),
  generatedPassword: text("generated_password"),
  faceDescriptor: text("face_descriptor"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const parentStudentsTable = pgTable("parent_students", {
  id: serial("id").primaryKey(),
  parentUserId: integer("parent_user_id").notNull().references(() => usersTable.id),
  studentId: integer("student_id").notNull().references(() => studentsTable.id),
});

export const attendanceTable = pgTable("attendance", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id),
  classId: integer("class_id").notNull().references(() => classesTable.id),
  date: date("date").notNull(),
  status: text("status").notNull().default("present"),
  remarks: text("remarks"),
  markedBy: integer("marked_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const feesTable = pgTable("fees", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  challanNumber: text("challan_number").unique(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  tuitionFee: numeric("tuition_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  otherCharges: numeric("other_charges", { precision: 10, scale: 2 }).notNull().default("0"),
  paidAmount: numeric("paid_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  lateFee: numeric("late_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  lateFeeApplied: boolean("late_fee_applied").notNull().default(false),
  month: integer("month").notNull(),
  year: integer("year").notNull(),
  dueDate: date("due_date"),
  paidDate: date("paid_date"),
  status: text("status").notNull().default("unpaid"),
  paymentMethod: text("payment_method"),
  receiptNumber: text("receipt_number"),
  remarks: text("remarks"),
  paymentProofData: text("payment_proof_data"),
  paymentProofName: text("payment_proof_name"),
  feeType: text("fee_type").notNull().default("monthly"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const examsTable = pgTable("exams", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  classId: integer("class_id").notNull().references(() => classesTable.id),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  totalMarks: integer("total_marks").notNull(),
  passingMarks: integer("passing_marks").notNull(),
  examDate: date("exam_date"),
  // Enhanced fields
  examType: text("exam_type").notNull().default("class_test"), // daily_test | weekly_test | monthly | mid_term | final_term | annual | class_test | quiz | assignment
  session: text("session"), // e.g. "2024-25"
  status: text("status").notNull().default("draft"), // draft | active | marks_entry | completed | published | locked
  startTime: text("start_time"), // e.g. "09:00"
  endTime: text("end_time"),   // e.g. "11:00"
  venue: text("venue"),
  invigilatorId: integer("invigilator_id").references(() => teachersTable.id),
  checkerId: integer("checker_id").references(() => teachersTable.id), // paper checker
  marksStatus: text("marks_status").notNull().default("not_entered"), // not_entered | draft | submitted | locked | approved
  marksLockedBy: integer("marks_locked_by").references(() => usersTable.id),
  marksLockedAt: timestamp("marks_locked_at"),
  publishedAt: timestamp("published_at"),
  resultPublishDate: date("result_publish_date"),
  description: text("description"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const resultsTable = pgTable("results", {
  id: serial("id").primaryKey(),
  examId: integer("exam_id").notNull().references(() => examsTable.id),
  studentId: integer("student_id").notNull().references(() => studentsTable.id),
  marksObtained: numeric("marks_obtained", { precision: 10, scale: 2 }).notNull(),
  grade: text("grade"),
  percentage: numeric("percentage", { precision: 5, scale: 2 }),
  position: integer("position"),
  isAbsent: boolean("is_absent").notNull().default(false),
  remarks: text("remarks"),
  isDraft: boolean("is_draft").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Recheck Requests (premium feature)
export const recheckRequestsTable = pgTable("recheck_requests", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  examId: integer("exam_id").notNull().references(() => examsTable.id),
  studentId: integer("student_id").notNull().references(() => studentsTable.id),
  requestedByUserId: integer("requested_by_user_id").notNull().references(() => usersTable.id),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | completed
  newMarks: numeric("new_marks", { precision: 10, scale: 2 }),
  adminNote: text("admin_note"),
  resolvedByUserId: integer("resolved_by_user_id").references(() => usersTable.id),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Audit Logs for marks changes
export const examAuditLogsTable = pgTable("exam_audit_logs", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  examId: integer("exam_id").notNull().references(() => examsTable.id),
  studentId: integer("student_id").references(() => studentsTable.id),
  changedByUserId: integer("changed_by_user_id").notNull().references(() => usersTable.id),
  action: text("action").notNull(), // marks_entry | marks_update | marks_lock | marks_unlock | result_publish | recheck_approved
  oldValue: text("old_value"),
  newValue: text("new_value"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const classTermPermissionsTable = pgTable("class_term_permissions", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  classId: integer("class_id").notNull().references(() => classesTable.id),
  examType: text("exam_type").notNull(),
  session: text("session").notNull(),
  publishEnabled: boolean("publish_enabled").notNull().default(false),
  enabledBy: integer("enabled_by").references(() => usersTable.id),
  enabledAt: timestamp("enabled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const assignmentsTable = pgTable("assignments", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  classId: integer("class_id").notNull().references(() => classesTable.id),
  teacherId: integer("teacher_id").references(() => teachersTable.id),
  title: text("title").notNull(),
  description: text("description"),
  content: text("content"),
  fileBase64: text("file_base64"),
  fileName: text("file_name"),
  fileType: text("file_type"),
  filesJson: text("files_json"),        // JSON: [{base64, name, type}] — multiple attachments
  progressJson: text("progress_json"),   // JSON: [{message, files:[{base64,name,type}], createdAt}]
  type: text("type").notNull().default("assignment"),
  dueDate: date("due_date"),
  isPublished: boolean("is_published").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  userId: integer("user_id").references(() => usersTable.id),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull().default("info"),
  isRead: boolean("is_read").notNull().default(false),
  targetRole: text("target_role"),
  targetStudentId: integer("target_student_id").references(() => studentsTable.id),
  recipientUserId: integer("recipient_user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Accounts Module ──────────────────────────────────────────────────────────

export const incomeTable = pgTable("income", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  type: text("type").notNull().default("other"), // fee | admission | transport | library | certificate | event | donation | other
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  date: date("date").notNull(),
  studentId: integer("student_id").references(() => studentsTable.id),
  category: text("category"),
  receiptNo: text("receipt_no"),
  description: text("description"),
  paymentMethod: text("payment_method").default("cash"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const expensesTable = pgTable("expenses", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  category: text("category").notNull().default("other"), // salary | utilities | academic | maintenance | it | transport | event | health | other
  subCategory: text("sub_category"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  date: date("date").notNull(),
  description: text("description"),
  paidTo: text("paid_to"),
  paymentMethod: text("payment_method").default("cash"),
  status: text("status").notNull().default("paid"),   // paid | unpaid
  teacherId: integer("teacher_id").references(() => teachersTable.id),
  attachmentData: text("attachment_data"),
  attachmentName: text("attachment_name"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const vouchersTable = pgTable("vouchers", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schoolsTable.id),
  type: text("type").notNull(), // receipt | payment
  voucherNo: text("voucher_no").unique(),
  date: date("date").notNull(),
  category: text("category"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  description: text("description"),
  party: text("party"),
  paymentMethod: text("payment_method").default("cash"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertClassSchema = createInsertSchema(classesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTeacherSchema = createInsertSchema(teachersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertStudentSchema = createInsertSchema(studentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAttendanceSchema = createInsertSchema(attendanceTable).omit({ id: true, createdAt: true });
export const insertFeeSchema = createInsertSchema(feesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertExamSchema = createInsertSchema(examsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertResultSchema = createInsertSchema(resultsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRecheckRequestSchema = createInsertSchema(recheckRequestsTable).omit({ id: true, createdAt: true });
export const insertExamAuditLogSchema = createInsertSchema(examAuditLogsTable).omit({ id: true, createdAt: true });
export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ id: true, createdAt: true });
export const insertAssignmentSchema = createInsertSchema(assignmentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertParentStudentSchema = createInsertSchema(parentStudentsTable).omit({ id: true });
export const insertIncomeSchema = createInsertSchema(incomeTable).omit({ id: true, createdAt: true });
export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, createdAt: true });
export const insertVoucherSchema = createInsertSchema(vouchersTable).omit({ id: true, createdAt: true });

// ── Staff Attendance ──────────────────────────────────────────────────────────
export const staffAttendanceTable = pgTable("staff_attendance", {
  id:        serial("id").primaryKey(),
  schoolId:  integer("school_id").notNull().references(() => schoolsTable.id),
  userId:    integer("user_id").notNull().references(() => usersTable.id),
  staffType: text("staff_type").notNull().default("teacher"), // teacher | accountant | sub_admin | admin
  status:    text("status").notNull().default("present"),     // present | late | absent | leave
  date:      date("date").notNull(),
  scanTime:  text("scan_time"),
  notes:     text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertStaffAttendanceSchema = createInsertSchema(staffAttendanceTable).omit({ id: true, createdAt: true });
export type StaffAttendance = typeof staffAttendanceTable.$inferSelect;

// ── Leave Applications ─────────────────────────────────────────────────────────
export const leaveApplicationsTable = pgTable("leave_applications", {
  id:             serial("id").primaryKey(),
  schoolId:       integer("school_id").notNull().references(() => schoolsTable.id),
  // Who applied
  applicantUserId: integer("applicant_user_id").notNull().references(() => usersTable.id),
  // Target: "student" or "staff"
  targetType:     text("target_type").notNull(),          // "student" | "staff"
  targetStudentId: integer("target_student_id").references(() => studentsTable.id),
  targetUserId:   integer("target_user_id").references(() => usersTable.id),
  targetName:     text("target_name").notNull(),
  // Leave details
  fromDate:       date("from_date").notNull(),
  toDate:         date("to_date").notNull(),
  leaveType:      text("leave_type").notNull().default("personal"), // sick | personal | emergency | other
  reason:         text("reason").notNull(),
  // Status
  status:         text("status").notNull().default("pending"), // pending | approved | rejected
  approvedByUserId: integer("approved_by_user_id").references(() => usersTable.id),
  approvedAt:     timestamp("approved_at"),
  rejectionNote:  text("rejection_note"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
});

export const insertLeaveApplicationSchema = createInsertSchema(leaveApplicationsTable).omit({ id: true, createdAt: true });
export type LeaveApplication = typeof leaveApplicationsTable.$inferSelect;

// ── Timetable ─────────────────────────────────────────────────────────────────
export const timetableTable = pgTable("timetable", {
  id:          serial("id").primaryKey(),
  schoolId:    integer("school_id").notNull().references(() => schoolsTable.id),
  classId:     integer("class_id").notNull().references(() => classesTable.id),
  teacherId:   integer("teacher_id").references(() => teachersTable.id),
  dayOfWeek:   integer("day_of_week").notNull(), // 1=Mon ... 6=Sat
  periodNo:    integer("period_no").notNull(),   // 1, 2, 3 ...
  subject:     text("subject").notNull(),
  startTime:   text("start_time").notNull(),     // "08:00"
  endTime:     text("end_time").notNull(),       // "08:45"
  room:        text("room"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});
export type Timetable = typeof timetableTable.$inferSelect;

// ── SMS / WhatsApp Settings per school ───────────────────────────────────────
export const smsSettingsTable = pgTable("sms_settings", {
  id:             serial("id").primaryKey(),
  schoolId:       integer("school_id").notNull().references(() => schoolsTable.id).unique(),
  provider:       text("provider").notNull().default("twilio"), // twilio | textlocal | easypaisa
  accountSid:     text("account_sid"),     // Twilio account SID
  authToken:      text("auth_token"),      // Twilio auth token (stored encrypted)
  fromNumber:     text("from_number"),     // +1415... or whatsapp:+1415...
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(false),
  smsEnabled:      boolean("sms_enabled").notNull().default(false),
  // Event toggles
  notifyAbsent:    boolean("notify_absent").notNull().default(true),
  notifyFeesDue:   boolean("notify_fees_due").notNull().default(true),
  notifyMarks:     boolean("notify_marks").notNull().default(true),
  notifyExam:      boolean("notify_exam").notNull().default(true),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
});
export type SmsSettings = typeof smsSettingsTable.$inferSelect;

export type Teacher = typeof teachersTable.$inferSelect;
export type Class = typeof classesTable.$inferSelect;
export type Student = typeof studentsTable.$inferSelect;
export type Attendance = typeof attendanceTable.$inferSelect;
export type Fee = typeof feesTable.$inferSelect;
export type Exam = typeof examsTable.$inferSelect;
export type Result = typeof resultsTable.$inferSelect;
export type Notification = typeof notificationsTable.$inferSelect;
export type Assignment = typeof assignmentsTable.$inferSelect;
export type ParentStudent = typeof parentStudentsTable.$inferSelect;
export type TeacherResponsibility = typeof teacherResponsibilitiesTable.$inferSelect;
export type TeacherDuty = typeof teacherDutiesTable.$inferSelect;
export type TeacherRecord = typeof teacherRecordsTable.$inferSelect;
export type TeacherReplacement = typeof teacherReplacementsTable.$inferSelect;
export type TeacherPermission = typeof teacherPermissionsTable.$inferSelect;
export type TeacherContract = typeof teacherContractsTable.$inferSelect;
export type TeacherMeeting = typeof teacherMeetingsTable.$inferSelect;
export type TeacherPerformance = typeof teacherPerformanceTable.$inferSelect;
export type RecheckRequest = typeof recheckRequestsTable.$inferSelect;
export type ExamAuditLog = typeof examAuditLogsTable.$inferSelect;
