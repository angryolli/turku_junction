import { z } from "zod";

// Mirrors backend/app/models/schemas.py — keep in sync by hand.

export const fieldProfileSchema = z.object({
  field_id: z.string(),
  n: z.number(),
  mean: z.number().nullable(),
  std: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  skew: z.number().nullable().optional(),
  kurtosis: z.number().nullable().optional(),
  missing_rate: z.number(),
  unique_ratio: z.number(),
  frozen_rate: z.number(),
  lag1_autocorr: z.number().nullable(),
  stationary: z.boolean(),
  stationarity_evidence: z.string(),
  dominant_fft: z.number().nullable(),
  evidence: z.string(),
});

export const profileArtifactSchema = z.object({
  calibration_id: z.string(),
  fields: z.array(fieldProfileSchema).max(80),
});

export const correlationPairSchema = z.object({
  a: z.string(),
  b: z.string(),
  pearson: z.number(),
  spearman: z.number(),
  best_lag: z.number(),
  lagged_corr: z.number().nullable(),
  evidence: z.string(),
});

export const correlationArtifactSchema = z.object({
  calibration_id: z.string(),
  pairs: z.array(correlationPairSchema).max(20),
  clusters: z.array(
    z.object({
      cluster_id: z.string(),
      members: z.array(z.string()),
      evidence: z.string(),
    }),
  ),
});

export const structuralRoleSchema = z.object({
  field_id: z.string(),
  role: z.enum(["measured", "actuator", "ambiguous"]),
  quantization_score: z.number(),
  bounded_range_score: z.number(),
  lag_centrality_score: z.number(),
  evidence: z.string(),
});

export const rolesArtifactSchema = z.object({
  calibration_id: z.string(),
  roles: z.array(structuralRoleSchema).max(80),
});

export const ruleSchema = z.object({
  column: z.string(),
  condition: z.enum(["gt", "lt", "abs_gt", "stuck", "missing_rate"]),
  threshold: z.number(),
  window: z.number().default(20),
  severity: z.enum(["info", "warn", "fail"]).default("warn"),
  rule_text: z.string().default(""),
});

export const rankingRowSchema = z.object({
  field: z.string(),
  contribution_score: z.number(),
  correlation_evidence: z.string(),
  lag_evidence: z.string(),
  evidence: z.string(),
});

export const rankingArtifactSchema = z.object({
  event_id: z.string(),
  calibration_id: z.string(),
  ranked: z.array(rankingRowSchema).max(10),
  evidence: z.string(),
  confidence: z.number(),
});

export const roleInferenceSchema = z.object({
  items: z.array(
    z.object({
      field_id: z.string(),
      hypothesis: z.string(),
      evidence_refs: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      caveats: z.string(),
      background_knowledge: z.string().optional(),
    }),
  ),
});

export const critiqueSchema = z.object({
  agreement: z.enum(["agree", "partial", "disagree"]),
  counterpoints: z.array(z.string()),
  confidence_adjustment: z.string(),
});

export const chatSourcesSchema = z.object({
  sources: z.array(
    z.object({
      artifact_type: z.string(),
      id: z.string(),
    }),
  ),
});

export const diagnosisContributorSchema = z.object({
  field_id: z.string(),
  score: z.number(),
  mean: z.number().nullable().optional(),
  sd: z.number().nullable().optional(),
  skew: z.number().nullable().optional(),
  kurt: z.number().nullable().optional(),
  n: z.number().optional(),
});

export const diagnosisSignalSchema = z.object({
  id: z.string(),
  tick: z.number(),
  level: z.enum(["yellow", "red"]),
  score: z.number(),
  z: z.number(),
  top_fields: z.array(diagnosisContributorSchema),
  evidence: z.string(),
  created_at: z.string().optional(),
});

export const diagnosisSnapshotSchema = z.object({
  signals: z.array(diagnosisSignalSchema),
  current: z.record(z.string(), z.unknown()).optional(),
  evidence: z.string().optional(),
});
