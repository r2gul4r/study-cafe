import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function requireThat(
  value: unknown,
  code: string,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new Fault(status, code, message);
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const decode = <T = any>(value: unknown): T => JSON.parse(String(value));
export const text = z.string().trim().min(1).max(100_000);
export const key = z.string().min(1).max(100);
export const evidence = z.object({ segmentId: key, quote: text }).strict();
export const goalInput = z
  .object({
    title: text.max(200),
    description: z.string().max(10000).default(""),
    kind: z.enum(["general", "exam", "skill"]).default("general"),
    level: z.string().max(200).nullable().default(null),
    targetDate: z.iso.date().nullable().default(null),
    minutesPerDay: z.number().int().min(1).max(1440).nullable().default(null),
    timezone: z
      .string()
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      })
      .default("Asia/Seoul"),
  })
  .strict();
export const scopeInput = z
  .object({
    title: text.max(200),
    concepts: z
      .array(
        z
          .object({
            id: key.optional(),
            name: text.max(200),
            area: text.max(200),
            weight: z.number().positive().max(100).default(1),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    references: z.array(z.url()).max(50).default([]),
    examFormat: z
      .object({
        total: z.number().int().min(1).max(300),
        minutes: z.number().int().min(1).max(1440),
        evidenceUrl: z.url(),
      })
      .nullable()
      .default(null),
  })
  .strict();
export const questionInput = z
  .object({
    goalId: key,
    scopeId: key,
    familyId: key.optional(),
    parentId: key.nullable().default(null),
    type: z.enum(["single", "multiple", "short"]),
    stem: text,
    passage: z.string().max(50000).nullable().default(null),
    groupId: key.nullable().default(null),
    choices: z
      .array(z.object({ id: key, text }).strict())
      .max(10)
      .default([]),
    answer: z.array(key).max(10).default([]),
    modelAnswer: z.string().max(20000).nullable().default(null),
    rubric: z
      .array(
        z
          .object({
            id: key,
            description: text,
            points: z.number().positive().max(100),
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    explanation: z.string().max(30000).default(""),
    origin: z.enum([
      "past_exam",
      "official_practice",
      "external_practice",
      "ai_generated",
      "ai_variant",
    ]),
    pastExamEvidence: z.string().min(1).max(5000).nullable().default(null),
    conceptIds: z.array(key).min(1).max(20),
    difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
    evidence: z.array(evidence).max(30).default([]),
    sourceMatch: z
      .object({
        questionReference: text.max(200),
        answerReference: text.max(200),
        questionEvidence: evidence,
        answerEvidence: evidence,
        answerContinuationEvidence: z.array(evidence).max(4).default([]),
        edition: text.max(200).nullable(),
        editionEvidence: z.array(evidence).max(6),
      })
      .strict()
      .nullable()
      .default(null),
    requiredAssetIds: z.array(key).max(20).default([]),
    visualEvidence: z
      .array(
        z
          .object({
            segmentId: key,
            assetId: key,
            role: z.enum(["question", "answer"]),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    learnerRegions: z
      .array(
        z
          .object({
            segmentId: key,
            sourceAssetId: key,
            assetId: key,
            bounds: z
              .object({
                x: z.number().min(0).max(1),
                y: z.number().min(0).max(1),
                width: z.number().min(0.01).max(1),
                height: z.number().min(0.01).max(1),
              })
              .strict()
              .refine(
                (b) => b.x + b.width <= 1 && b.y + b.height <= 1,
                "영역은 페이지 안에 있어야 합니다.",
              ),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    visualTranscription: z.boolean().default(false),
    points: z.number().positive().max(100).default(1),
  })
  .strict()
  .superRefine((q, c) => {
    const bad = (message: string) => c.addIssue({ code: "custom", message });
    if (new Set(q.choices.map((v) => v.id)).size !== q.choices.length)
      bad("보기 ID가 중복됩니다.");
    if (new Set(q.conceptIds).size !== q.conceptIds.length)
      bad("개념 ID가 중복됩니다.");
    if (
      q.type !== "short" &&
      (q.choices.length < 2 ||
        q.answer.some((a) => !q.choices.some((v) => v.id === a)) ||
        new Set(q.answer).size !== q.answer.length)
    )
      bad("보기와 정답 ID를 확인하세요.");
    if (q.type === "single" && q.answer.length !== 1)
      bad("단일 선택 정답은 하나여야 합니다.");
    if (q.type === "multiple" && q.answer.length < 1)
      bad("복수 선택 정답이 필요합니다.");
    if (q.type === "short") {
      if (!q.modelAnswer) bad("주관식 modelAnswer에 모범답안이 필요합니다.");
      if (!q.rubric.length) bad("주관식 rubric에 채점 기준이 필요합니다.");
      if (q.choices.length || q.answer.length)
        bad(
          "주관식 choices와 answer는 빈 배열이어야 합니다. 정답은 modelAnswer에 작성하세요.",
        );
      if (new Set(q.rubric.map((r) => r.id)).size !== q.rubric.length)
        bad("주관식 rubric의 기준 ID가 중복됩니다.");
      const sum = q.rubric.reduce((s, r) => s + r.points, 0);
      if (Math.abs(sum - q.points) > 1e-8)
        bad(
          `주관식 rubric.points 합계(${sum})가 문항 points(${q.points})와 다릅니다.`,
        );
    }
    if (q.origin === "past_exam" && !q.pastExamEvidence)
      bad("실제 기출 근거가 필요합니다.");
    if (q.origin === "ai_variant" && !q.parentId)
      bad("변형 문제의 원본이 필요합니다.");
  });
export type Question = z.infer<typeof questionInput>;
export const templateInput = z
  .object({
    name: text.max(200),
    total: z.number().int().min(1).max(300).default(25),
    single: z.number().int().min(0).default(20),
    multiple: z.number().int().min(0).default(0),
    short: z.number().int().min(0).default(5),
    mode: z
      .enum(["practice", "weakness", "review", "mock"])
      .default("practice"),
    policy: z
      .enum(["past_only", "official_first", "mixed", "ai_only"])
      .default("mixed"),
    minutes: z.number().int().min(1).max(1440).nullable().default(null),
    difficulty: z.enum(["easy", "medium", "hard", "any"]).default("any"),
    shuffleChoices: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.total !== v.single + v.multiple + v.short)
      c.addIssue({
        code: "custom",
        message: "총 문항 수와 유형별 합계가 다릅니다.",
      });
    if (v.mode === "mock" && !v.minutes)
      c.addIssue({
        code: "custom",
        message: "실전 모드는 제한 시간이 필요합니다.",
      });
  });
export type Template = z.infer<typeof templateInput>;
export function canonicalQuestion(q: Question) {
  return hash(
    JSON.stringify([
      q.type,
      q.stem.normalize("NFKC").replace(/\s+/g, " ").trim(),
      q.passage?.normalize("NFKC").replace(/\s+/g, " "),
      q.choices.map((c) => c.text.normalize("NFKC").trim()).sort(),
      ...(q.requiredAssetIds.length ? [[...q.requiredAssetIds].sort()] : []),
    ]),
  );
}
export function dayAt(date: string, zone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
}
export function shuffled<T>(items: T[], seed: string): T[] {
  return [...items]
    .map((v, i) => ({ v, k: hash(seed + ":" + i) }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map((x) => x.v);
}
export const agentEnvelope = (
  name: string,
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
