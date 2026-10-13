import { z } from "zod";
import type { AgentPort } from "./agent.js";
import { Jobs, Waiting, type JobContext } from "./jobs.js";
import { Catalog } from "./catalog.js";
import { Sources } from "./sources.js";
import { Exams } from "./exams.js";
import { Learning, gradeOutput } from "./learning.js";
import {
  decode,
  id,
  now,
  questionInput,
  requireThat,
  scopeInput,
  Fault,
  canonicalQuestion,
} from "./core.js";

const researchOutput = z
  .object({
    candidates: z
      .array(
        z
          .object({
            title: z.string(),
            url: z.url(),
            publisher: z.string(),
            kind: z.enum([
              "past_exam",
              "official_practice",
              "external_practice",
              "reference",
            ]),
            examEvidence: z.string().nullable(),
            reuseEvidence: z
              .object({ quote: z.string(), url: z.url() })
              .nullable(),
            answerUrls: z.array(z.url()),
          })
          .strict(),
      )
      .max(30),
    uncovered: z.array(z.string()),
    summary: z.string(),
  })
  .strict();
const verifyOutput = z
  .object({
    usable: z.boolean(),
    reason: z.string(),
    evidenceValid: z.boolean(),
    answerValid: z.boolean(),
  })
  .strict();
export function registerWorkflows(
  jobs: Jobs,
  catalog: Catalog,
  sources: Sources,
  exams: Exams,
  learning: Learning,
  agent: AgentPort,
) {
  const s = catalog.store;
  const ask = async <T>(
    ctx: JobContext,
    role: string,
    input: any,
    schema: z.ZodType<T>,
    search = false,
  ) => {
    const started = now();
    try {
      const result = await agent.ask(role, input, schema, {
        signal: ctx.signal,
        search,
        onProgress: (e) => ctx.event(e),
      });
      ctx.signal.throwIfAborted();
      s.run(
        "INSERT INTO agent_runs VALUES(?,?,?,?)",
        id(),
        ctx.jobId,
        JSON.stringify({
          role,
          status: "completed",
          promptVersion: 1,
          startedAt: started,
        }),
        now(),
      );
      return result;
    } catch (e) {
      if (!ctx.signal.aborted)
        s.run(
          "INSERT INTO agent_runs VALUES(?,?,?,?)",
          id(),
          ctx.jobId,
          JSON.stringify({
            role,
            status: "failed",
            promptVersion: 1,
            startedAt: started,
          }),
          now(),
        );
      throw e;
    }
  };
  const sourceContext = (goalId: string) =>
    s
      .all(
        "SELECT seg.id,seg.text,seg.locator FROM segments seg JOIN source_revisions r ON r.id=seg.revision_id JOIN sources src ON src.id=r.source_id WHERE src.goal_id=? AND r.rowid=(SELECT MAX(latest.rowid) FROM source_revisions latest WHERE latest.source_id=src.id) ORDER BY src.created_at,seg.ordinal LIMIT 40",
        goalId,
      )
      .map((r) => ({
        segmentId: r.id,
        text: r.text,
        locator: decode(r.locator),
      }));
  const verify = async (q: any, ctx: JobContext) =>
    ask(
      ctx,
      "verify_question",
      {
        question: q,
        materials: q.evidence.map((e: any) => ({
          segmentId: e.segmentId,
          text: s.get("segments", e.segmentId).text,
        })),
        instruction:
          "Solve independently. Check the answer, ambiguity, exact quotations, source support and all required assets. Set usable=false on uncertainty.",
      },
      verifyOutput,
    );
  jobs.handlers.set("plan_goal", async (input, ctx) =>
    ctx.step("plan", () =>
      ask(
        ctx,
        "plan_goal",
        {
          goal: catalog.readGoal(input.goalId),
          answers: input.answers ?? {},
          instruction:
            "Propose a scope and necessary clarification questions. Do not claim current exam rules without searching official sources.",
        },
        z
          .object({
            scope: scopeInput,
            questions: z.array(z.string()),
            summary: z.string(),
          })
          .strict(),
        true,
      ),
    ),
  );
  jobs.handlers.set("research", async (input, ctx) => {
    const goal = catalog.readGoal(input.goalId);
    requireThat(goal.scope, "SCOPE_REQUIRED", "목표 범위가 필요합니다.");
    const research = await ctx.step(
      "discover",
      () =>
        ask(
          ctx,
          "research_sources",
          {
            goal,
            existing: s
              .all("SELECT data FROM sources WHERE goal_id=?", input.goalId)
              .map((r) => decode(r.data)),
            instruction:
              "Search official scope, public past papers, official exercises and reputable practice material. Open original pages; never treat search snippets as verified past-paper evidence. Return actual URLs. reuseEvidence only for explicit permission/license text and its page. Maximum 30 candidate URLs. Report uncovered scope.",
          },
          researchOutput,
          true,
        ),
      (result) => ({
        sources: result.candidates.map(
          (c) =>
            catalog.source(input.goalId, {
              title: c.title,
              url: c.url,
              publisher: c.publisher,
              kind: c.kind,
              examEvidence: c.examEvidence,
              rights: "link_only",
            }).id,
        ),
        candidates: result.candidates,
        uncovered: result.uncovered,
        summary: result.summary,
      }),
    );
    const outcomes = [];
    for (let i = 0; i < research.sources.length; i++) {
      ctx.signal.throwIfAborted();
      const sourceId = research.sources[i]!;
      const candidate = research.candidates[i]!;
      // Model permission claims are checked against the actual page before allowing acquisition.
      if (
        candidate.reuseEvidence &&
        candidate.reuseEvidence.quote.length >= 20
      ) {
        await ctx.step(
          `permission:${sourceId}`,
          async () => {
            try {
              const r = await sources.fetcher(
                candidate.reuseEvidence!.url,
                ctx.signal,
                2 * 1024 * 1024,
              );
              const { extract } = await import("./sources.js");
              const extracted = await extract(r.bytes, r.mime, r.url);
              return extracted.pages.some((p) =>
                p.text.includes(candidate.reuseEvidence!.quote),
              );
            } catch (e) {
              ctx.signal.throwIfAborted();
              return false;
            }
          },
          (ok) => {
            if (ok) {
              const old = s.get("sources", sourceId);
              s.run(
                "UPDATE sources SET data=? WHERE id=?",
                JSON.stringify({
                  ...decode(old.data),
                  rights: "allowed",
                  rightsBasis: JSON.stringify(candidate.reuseEvidence),
                }),
                sourceId,
              );
            }
            return ok;
          },
        );
      }
      const src = catalog.readSource(sourceId);
      if (src.rights === "link_only") {
        outcomes.push({ sourceId, status: "link_only" });
        continue;
      }
      const outcome = await ctx.step(
        `acquire:${sourceId}`,
        async () => {
          try {
            return {
              prepared: await sources.prepare(sourceId, {}, ctx.signal),
              error: null,
            };
          } catch (e) {
            ctx.signal.throwIfAborted();
            return {
              prepared: null,
              error: e instanceof Error ? e.message : "수집 실패",
            };
          }
        },
        (result) => {
          if (result.prepared)
            return {
              sourceId,
              status: "extracted",
              ...sources.commit(sourceId, result.prepared),
            };
          s.run("UPDATE sources SET status='blocked' WHERE id=?", sourceId);
          return { sourceId, status: "blocked", reason: result.error };
        },
      );
      outcomes.push(outcome);
    }
    const extracted = [];
    for (let i = 0; i < research.sources.length; i++) {
      const sourceId = research.sources[i]!;
      const src = catalog.readSource(sourceId);
      if (src.status !== "extracted") continue;
      const candidate = research.candidates[i]!;
      const answerIds: string[] = [];
      for (const url of candidate.answerUrls.slice(0, 5)) {
        const answerSource = await ctx.step(
          `answer-source:${sourceId}:${url}`,
          async () => url,
          (value) =>
            catalog.source(input.goalId, {
              title: src.title + " 정답표",
              url: value,
              publisher: src.publisher,
              kind: "reference",
              rights:
                src.rights === "allowed" &&
                new URL(value).hostname === new URL(src.url).hostname
                  ? "allowed"
                  : "link_only",
              rightsBasis: src.rightsBasis,
            }),
        );
        answerIds.push(answerSource.id);
        if (answerSource.rights === "link_only") continue;
        await ctx.step(
          `answer-ingest:${answerSource.id}`,
          async () => {
            try {
              return {
                prepared: await sources.prepare(
                  answerSource.id,
                  {},
                  ctx.signal,
                ),
                error: null,
              };
            } catch (e) {
              ctx.signal.throwIfAborted();
              return {
                prepared: null,
                error: e instanceof Error ? e.message : "정답표 수집 실패",
              };
            }
          },
          (value) =>
            value.prepared
              ? sources.commit(answerSource.id, value.prepared)
              : { error: value.error },
        );
      }
      if (answerIds.length) {
        const old = s.get("sources", sourceId);
        s.run(
          "UPDATE sources SET data=? WHERE id=?",
          JSON.stringify({
            ...decode<any>(old.data),
            answerSourceIds: answerIds,
          }),
          sourceId,
        );
      }
      try {
        const childContext: JobContext = {
          ...ctx,
          step: (name, work, commit) =>
            ctx.step(`source:${sourceId}:${name}`, work, commit),
        };
        extracted.push({
          sourceId,
          ...(await jobs.handlers.get("extract_questions")!(
            { sourceId },
            childContext,
          )),
        });
      } catch (e) {
        ctx.signal.throwIfAborted();
        extracted.push({
          sourceId,
          status: "needs_review",
          reason: e instanceof Error ? e.message : "문항 추출 실패",
        });
      }
    }
    return { ...research, outcomes, extracted, coverage: "bounded_search" };
  });
  jobs.handlers.set("ingest_source", async (input, ctx) =>
    ctx.step(
      "ingest",
      () => sources.prepare(input.sourceId, input, ctx.signal),
      (p) => sources.commit(input.sourceId, p),
    ),
  );
  jobs.handlers.set("extract_questions", async (input, ctx) => {
    const src = catalog.readSource(input.sourceId);
    const scope = catalog.latestScope(src.goalId);
    requireThat(scope, "SCOPE_REQUIRED", "목표 범위가 필요합니다.");
    const segments = catalog.segments(input.sourceId);
    const latest = src.revisions.at(-1)?.id;
    const relevant = segments.filter((s) => s.revision_id === latest);
    requireThat(relevant.length, "NO_TEXT", "먼저 원문을 추출하세요.", 409);
    const answerSegments = src.answerSourceIds.flatMap((sourceId: string) => {
      const other = catalog.readSource(sourceId);
      requireThat(
        other.goalId === src.goalId,
        "ANSWER_SOURCE",
        "정답표의 목표가 다릅니다.",
      );
      return catalog
        .segments(sourceId)
        .filter(
          (segment) => segment.revision_id === other.revisions.at(-1)?.id,
        );
    });
    const created: string[] = [];
    const unresolved: { reference: string; reason: string }[] = [];
    for (let offset = 0; offset < relevant.length; offset += 3) {
      const batch = relevant.slice(offset, offset + 3);
      const result = await ctx.step(
        `extract:${latest}:${offset}`,
        () =>
          ask(
            ctx,
            "extract_existing_questions",
            {
              source: src,
              scope,
              segments: batch.map((r) => ({
                segmentId: r.id,
                text: r.text,
                locator: r.locator,
              })),
              answerSegments: answerSegments.slice(0, 12),
              instruction:
                "Extract only existing complete questions, not new ones. Keep exact wording. Match answer sheet edition and question number. Every question requires exact source evidence. Missing answers/assets go in unresolved. Use source kind for origin; user_material and reference map to external_practice only when actual questions exist. Keep linked passage groups together. Never invent unavailable question text.",
            },
            z
              .object({
                questions: z.array(questionInput).max(20),
                unresolved: z.array(
                  z
                    .object({ reference: z.string(), reason: z.string() })
                    .strict(),
                ),
              })
              .strict(),
          ),
        (output) => {
          const ids = output.questions.map((q) => {
            requireThat(
              q.goalId === src.goalId && q.scopeId === scope.id,
              "AGENT_SCOPE",
              "추출 결과 범위가 다릅니다.",
            );
            return catalog.createQuestion(q).id;
          });
          return { ids, unresolved: output.unresolved };
        },
      );
      created.push(...result.ids);
      unresolved.push(...result.unresolved);
    }
    for (const qid of new Set(created)) {
      const q = catalog.readQuestion(qid);
      await ctx.step(
        `verify:${q.revisionId}`,
        () => verify(q, ctx),
        (v) =>
          catalog.review(
            q.revisionId,
            v.usable && v.evidenceValid && v.answerValid
              ? "usable"
              : "needs_review",
            v.reason,
            "codex",
          ),
      );
    }
    return {
      questionIds: [...new Set(created)],
      count: new Set(created).size,
      unresolved,
    };
  });
  jobs.handlers.set("verify_question", async (input, ctx) => {
    const q = catalog.readQuestion(input.questionId);
    return ctx.step(
      "verify:" + q.revisionId,
      () => verify(q, ctx),
      (v) =>
        catalog.review(
          q.revisionId,
          v.usable && v.evidenceValid && v.answerValid
            ? "usable"
            : "needs_review",
          v.reason,
          "codex",
        ),
    );
  });
  jobs.handlers.set("prepare_exam", async (input, ctx) => {
    let exam = exams.get(input.examId, true);
    if (exam.status === "ready") return exams.get(input.examId);
    exams.fillExisting(input.examId);
    exam = exams.get(input.examId, true);
    const empty = exam.slots.filter(
      (slot: any) => !exam.items.some((q: any) => q.slot === slot.slot),
    );
    if (empty.length && exam.template.policy === "past_only")
      throw new Waiting({
        code: "INSUFFICIENT_PAST",
        missing: empty.length,
        slots: empty,
        choices: ["추가 자료 수집 후 재개", "다른 구성으로 새 시험 생성"],
      });
    const materials = sourceContext(exam.goalId);
    if (empty.length && !materials.length)
      throw new Waiting({
        code: "SOURCE_REQUIRED",
        message: "문항 생성에 사용할 근거 자료를 먼저 등록하세요.",
      });
    for (const slot of empty) {
      await ctx.step(
        `slot:${slot.slot}`,
        async () => {
          let feedback: string | null = null;
          for (let retry = 0; retry < 3; retry++) {
            try {
              const current = exams.get(input.examId, true);
              const q = await ask(
                ctx,
                "generate_question",
                {
                  goal: catalog.readGoal(exam.goalId),
                  scopeId: exam.scopeId,
                  slot,
                  materials,
                  previousFailure: feedback,
                  exclude: current.items.map((q: any) => q.stem),
                  instruction:
                    "Create exactly one original grounded question for this slot. origin=ai_generated. Set goalId, scopeId, type and conceptIds exactly from the input. Use human-readable choice/rubric IDs. familyId, parentId and groupId must be null for a new independent question. No unsupported image/audio assets. Use exact supplied evidence quotes. For short answers choices=[] and answer=[], provide modelAnswer and rubric whose points sum to points. Correct previousFailure if present.",
                },
                questionInput,
              );
              requireThat(
                q.goalId === exam.goalId &&
                  q.scopeId === exam.scopeId &&
                  q.origin === "ai_generated" &&
                  q.type === slot.type &&
                  q.conceptIds.includes(slot.conceptId) &&
                  (slot.difficulty === "any" ||
                    q.difficulty === slot.difficulty),
                "AGENT_SCOPE",
                "생성 결과 범위가 다릅니다.",
              );
              catalog.validateQuestion(q);
              requireThat(
                !current.items.some(
                  (existing: any) =>
                    canonicalQuestion(existing) === canonicalQuestion(q),
                ),
                "DUPLICATE_QUESTION",
                "이번 시험에 이미 포함된 문항입니다.",
              );
              const review = await verify(q, ctx);
              if (review.usable && review.evidenceValid && review.answerValid)
                return { q, review };
              feedback = review.reason;
            } catch (e) {
              ctx.signal.throwIfAborted();
              if (
                e instanceof Fault &&
                ["CODEX_SPAWN", "CODEX_EXIT", "CODEX_TURN_TIMEOUT"].includes(
                  e.code,
                )
              )
                throw e;
              feedback = (e instanceof Error ? e.message : String(e)).slice(
                0,
                4000,
              );
            }
            ctx.event({
              slot: slot.slot,
              retry: retry + 1,
              status: "retrying",
              reason: feedback,
            });
          }
          throw new Fault(
            422,
            "GENERATION_REVIEW_FAILED",
            `${slot.slot}번 문항 검토 실패: ${feedback}`,
          );
        },
        (value) => {
          const q = catalog.createQuestion(value.q);
          catalog.review(q.revisionId, "usable", value.review.reason, "codex");
          const ready = catalog.readQuestion(q.id);
          exams.place(input.examId, slot.slot, ready);
          return { questionId: q.id, revisionId: q.revisionId };
        },
      );
    }
    return ctx.step(
      "finalize",
      async () => null,
      () => exams.finalize(input.examId),
    );
  });
  jobs.handlers.set("grade_attempt", async (input, ctx) => {
    const result = learning.result(input.attemptId);
    for (const item of result.items) {
      if (
        item.type !== "short" ||
        item.assessment.status !== "pending" ||
        item.assessment.actor === "correction"
      )
        continue;
      const expectedVersion = item.assessment.version;
      await ctx.step(
        `grade:${item.slot}:${expectedVersion}`,
        () =>
          ask(
            ctx,
            "grade_answer",
            {
              question: {
                stem: item.stem,
                passage: item.passage,
                modelAnswer: item.modelAnswer,
                rubric: item.rubric,
              },
              answer: item.answerGiven?.value ?? "",
              instruction:
                "Evaluate only this submitted answer against each frozen rubric criterion. Evidence must quote exact answer text. Required criteria must be fully satisfied to pass. Use pending if ambiguous. Never assign fallback partial credit for an error.",
            },
            gradeOutput,
          ),
        (r) => learning.aiGrade(input.attemptId, item.slot, r, expectedVersion),
      );
    }
    return learning.result(input.attemptId);
  });
  jobs.handlers.set("summarize_wrong", async (input, ctx) => {
    const snapshot = learning.wrong(input.goalId);
    return ctx.step(
      "summary",
      () =>
        ask(
          ctx,
          "summarize_misconceptions",
          {
            goal: catalog.readGoal(input.goalId),
            wrong: snapshot.slice(0, 50),
            instruction:
              "Group by actual concept IDs and explain from answer evidence. Distinguish inferred reasons from user-confirmed ones; propose a concise correction and a contrasting example.",
          },
          z
            .object({
              concepts: z.array(
                z
                  .object({
                    conceptId: z.string(),
                    summary: z.string(),
                    example: z.string(),
                    reasonIsInferred: z.boolean(),
                    attemptIds: z.array(z.string()).min(1),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      (result) => {
        const valid = new Set(
          catalog.latestScope(input.goalId)?.concepts.map((c: any) => c.id),
        );
        for (const c of result.concepts) {
          requireThat(valid.has(c.conceptId), "CONCEPT", "없는 개념");
          requireThat(
            c.attemptIds.every((a) =>
              snapshot.some(
                (s: any) =>
                  s.attemptId === a && s.conceptIds.includes(c.conceptId),
              ),
            ),
            "SUMMARY_EVIDENCE",
            "요약 근거가 없습니다.",
          );
        }
        const noteId = id();
        s.run(
          "INSERT INTO notes VALUES(?,?,?,?)",
          noteId,
          input.goalId,
          JSON.stringify({
            ...result,
            assessmentIds: snapshot.map((i: any) => i.assessment.id),
          }),
          now(),
        );
        return { id: noteId, ...result };
      },
    );
  });
  jobs.handlers.set("generate_variant", async (input, ctx) => {
    const parent = catalog.readQuestion(input.questionId);
    const materials = parent.evidence.map((e: any) => ({
      segmentId: e.segmentId,
      text: s.get("segments", e.segmentId).text,
    }));
    return ctx.step(
      "variant",
      async () => {
        const q = await ask(
          ctx,
          "generate_variant",
          {
            parent,
            materials,
            instruction:
              "Test the same concept with a meaningfully different situation. origin=ai_variant and parentId must equal the original ID. Preserve goal/scope and family. Cite exact source evidence.",
          },
          questionInput,
        );
        requireThat(
          q.origin === "ai_variant" &&
            q.parentId === parent.id &&
            q.goalId === parent.goalId &&
            q.scopeId === parent.scopeId,
          "VARIANT",
          "변형 관계가 다릅니다.",
        );
        catalog.validateQuestion(q);
        requireThat(
          canonicalQuestion(q) !== canonicalQuestion(parent),
          "VARIANT_UNCHANGED",
          "변형 문제가 원본과 동일합니다.",
        );
        requireThat(
          q.conceptIds.some((concept) => parent.conceptIds.includes(concept)),
          "VARIANT_CONCEPT",
          "원본 개념을 평가해야 합니다.",
        );
        const review = await verify(q, ctx);
        return { q, review };
      },
      (r) => {
        const q = catalog.createQuestion(r.q);
        return catalog.review(
          q.revisionId,
          r.review.usable && r.review.evidenceValid && r.review.answerValid
            ? "usable"
            : "needs_review",
          r.review.reason,
          "codex",
        );
      },
    );
  });
}
