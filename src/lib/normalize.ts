/**
 * Normalize a subject/field name to Title Case.
 * "chemistry" → "Chemistry"
 * "ENGLISH LITERATURE" → "English Literature"
 * "  urdu  " → "Urdu"
 * null/undefined → returns as-is (null/undefined)
 */
export function normalizeSubject(subject: string | null | undefined): string | null | undefined {
  if (!subject) return subject;
  return subject
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}
