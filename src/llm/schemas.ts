import { z } from "zod";

export const Severity = z.enum(["P0", "P1", "P2", "P3"]);
export const Category = z.enum([
  "correctness",
  "security",
  "performance",
  "concurrency",
  "compatibility",
  "testing",
]);

export const Candidate = z.object({
  id: z.string(),
  title: z.string(),
  severity: Severity,
  file: z.string(),
  line: z.number().int().positive(),
  category: Category,
  description: z.string(),
  trigger: z.string(),
  impact: z.string(),
  suggestion: z.string(),
});

export const CandidateListSchema = z.object({
  findings: z.array(Candidate),
});

export const VerificationResult = z.object({
  id: z.string(),
  verdict: z.enum(["confirmed", "downgraded", "rejected"]),
  severity: Severity,
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.string(),
  reason: z.string(),
});

export const VerificationListSchema = z.object({
  verifications: z.array(VerificationResult),
});

export const Finding = Candidate.extend({
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.string(),
});

export type Severity = z.infer<typeof Severity>;
export type Category = z.infer<typeof Category>;
export type Candidate = z.infer<typeof Candidate>;
export type CandidateList = z.infer<typeof CandidateListSchema>;
export type VerificationResult = z.infer<typeof VerificationResult>;
export type VerificationList = z.infer<typeof VerificationListSchema>;
export type Finding = z.infer<typeof Finding>;
