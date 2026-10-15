import { z } from "zod";
import { containsVerbatimQuote } from "./evidence.js";
import {
  latestMaterials,
  documentEdges,
  withExtractionEvidence,
  selectMaterials,
  validateExtraction,
  validateSuppliedEvidence,
  type Material,
} from "./materials.js";
import type { AgentPort } from "./agent.js";
import {
  withPageImages,
  imageInputs,
  validateVisualEvidence,
  type ImageInput,
} from "./pdf-visuals.js";
import { Jobs, Waiting, type JobContext } from "./jobs.js";
import { Catalog } from "./catalog.js";
import { Sources } from "./sources.js";
import { Exams } from "./exams.js";
import { Learning } from "./learning.js";
import {
  rubricAuditOutput,
  semanticGradeOutput,
  rubricInstruction,
  semanticInstruction,
  validateRubricAudit,
  validateSemanticGrade,
  needsGradeReview,
} from "./grading.js";
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
    rubricCheck: rubricAuditOutput.nullable(),
    visualCheck: z
      .object({
        faithful: z.boolean(),
        complete: z.boolean(),
        noAnswerLeak: z.boolean(),
        reason: z.string(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
const shortAnswerPolicy =
  "For short questions, every scored requirement must be explicitly requested by the stem or passage. " +
  "If explanation, reasoning, an example, units or a specific format will be scored, state that requirement in the question. " +
  "Use separate criteria for separately requested outputs and explanations. A model answer is illustrative: allow semantically equivalent answers and never require its exact phrasing. " +
  "Do not add rubric requirements merely to fill points. For extracted questions preserve the source wording; leave unsupported rubric details out or report the question unresolved.";
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
    images: ImageInput[] = [],
  ) => {
    const started = now();
    try {
      const result = await agent.ask(role, input, schema, {
        signal: ctx.signal,
        search,
        images,
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
          promptVersion: 11,
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
            promptVersion: 11,
            startedAt: started,
          }),
          now(),
        );
      throw e;
    }
  };
  // Exam/variant scopes are versioned. A newer goal scope must not replace the
  // concepts belonging to an already-created exam or its original question.
  const goalAtScope = (goalId: string, scopeId: string) => {
    const goal = catalog.readGoal(goalId);
    const scope = s.get("scopes", scopeId);
    requireThat(
      scope.goal_id === goalId,
      "AGENT_SCOPE",
      "목표 범위가 다릅니다.",
    );
    return {
      ...goal,
      scope: { id: scope.id, version: scope.version, ...decode(scope.data) },
    };
  };
  const verify = async (q: any, ctx: JobContext) => {
    validateVisualEvidence(s, q);
    const materials: Material[] = [
      ...new Set<string>(q.evidence.map((e: any) => e.segmentId)),
    ].map((segmentId) => {
      const segment = s.get("segments", segmentId);
      const revision = s.get("source_revisions", segment.revision_id);
      const source = catalog.readSource(revision.source_id);
      const { boxes: _boxes, ...locator } = decode<any>(segment.locator);
      return {
        segmentId,
        sourceId: source.id,
        revisionId: revision.id,
        title: source.title,
        kind: source.kind,
        url: source.url ?? null,
        text: segment.text,
        locator,
        ordinal: segment.ordinal,
      };
    });
    const visualIds = new Set<string>(
      (q.visualEvidence ?? []).map((v: any) => v.segmentId),
    );
    const rendered = await withPageImages(
      s,
      materials.filter((m) => visualIds.has(m.segmentId)),
      ctx.signal,
    );
    const review = await ask(
      ctx,
      "verify_question",
      {
        goal: goalAtScope(q.goalId, q.scopeId),
        question: q,
        materials: materials.map(
          (m) => rendered.find((v) => v.segmentId === m.segmentId) ?? m,
        ),
        visualPolicy:
          "If visualEvidence is nonempty, inspect every attached original page. Return visualCheck: faithful confirms every stem/passage/choice and math symbol agrees with the original question image (not the answer sheet), complete confirms graphs and all necessary context are visible in requiredAssetIds, and noAnswerLeak confirms those learner-facing images contain no solutions/answer keys. Any missing image, changed question, unreadable formula or disagreement makes usable=false. Text-layout loss may be transcribed into readable plain/Unicode math only when visualTranscription=true and the original image is preserved. Independently compute answers; an original solution typo must not be silently corrected or accepted. For answerContinuationEvidence, check consecutive pages and matching parent problem/subpart; adjacency alone is not proof. Include specific reasons for discrepancies.",
        instruction:
          "Solve independently. Check the answer, ambiguity, exact quotations, source support and all required assets. An exact quote alone is not proof: the material must support the correct answer and requested concept. For extracted questions, independently check sourceMatch: the question number, choice-to-answer mapping, edition and passage must agree with the quoted question and answer sheet; never accept a match just because the numbers look similar. Verify any choice-letter references against the supplied original choices array order, never a shuffled order. Set usable=false on uncertainty. For non-short questions rubricCheck=null. For short questions return rubricCheck using this policy: " +
          rubricInstruction,
      },
      verifyOutput,
      false,
      imageInputs(s, rendered),
    );
    if (
      (q.visualEvidence?.length || q.visualTranscription) &&
      !(
        review.visualCheck?.faithful &&
        review.visualCheck.complete &&
        review.visualCheck.noAnswerLeak
      )
    )
      return {
        ...review,
        usable: false,
        reason:
          "원본 이미지 검토 보류: " +
          (review.visualCheck?.reason ?? "이미지 검토 결과가 없습니다."),
      };
    if (q.type === "short") {
      const audit = validateRubricAudit(q, review.rubricCheck);
      const mismatches = audit.criteria.filter((c) => !c.aligned);
      if (mismatches.length)
        return {
          ...review,
          usable: false,
          reason:
            "문제 요구와 채점 기준 불일치: " +
            mismatches.map((c) => c.reason).join(" "),
        };
    }
    return review;
  };
  jobs.handlers.set("plan_goal", async (input, ctx) =>
    ctx.step("plan", async () => {
      let previousFailure: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await ask(
            ctx,
            "plan_goal",
            {
              goal: catalog.readGoal(input.goalId),
              answers: input.answers ?? {},
              previousFailure,
              instruction:
                "Propose a scope and necessary clarification questions. Do not claim current exam rules without searching official sources. scope.references must contain only absolute http/https URL strings, not titles, Markdown links or citation markers; use [] if none verified. Set examFormat=null for a non-exam learning goal. Fix the reported previousFailure when present.",
            },
            z
              .object({
                scope: scopeInput,
                questions: z.array(z.string()),
                summary: z.string(),
              })
              .strict(),
            true,
          );
        } catch (error) {
          if (
            attempt ||
            ctx.signal.aborted ||
            !(error instanceof Fault) ||
            error.code !== "AGENT_OUTPUT_INVALID"
          )
            throw error;
          previousFailure = error.message;
          ctx.event({
            type: "schema_retry",
            message: "목표 초안 형식을 한 번 다시 확인합니다.",
          });
        }
      }
      throw new Error("Unreachable plan retry state");
    }),
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
              (goal.kind === "exam"
                ? "Prioritize the confirmed exam's official scope, public past papers and official practice material. "
                : goal.kind === "skill"
                  ? "Prioritize authoritative practical guides, worked examples and exercises for the abilities the user wants to demonstrate. Past papers and an exam syllabus are not prerequisites. "
                  : "Prioritize authoritative explanations, learning resources and exercises for the user's interests and level. Past papers and an exam syllabus are not prerequisites. ") +
              "Follow the supplied goal description, level and scope; never substitute a preset subject or curriculum. Open original pages; never treat search snippets as verified past-paper evidence. Classify explanatory material as reference and existing exercises by their actual provenance. Return actual absolute URLs. reuseEvidence only for an exact verbatim permission/license quote and its page. Set reuseEvidence=null if relevant reuse or AI-use restrictions require additional permission; do not quote a permissive fragment while ignoring a restriction. If a preferred source cannot be acquired for this use, keep it link-only and search for independently authored, accessible alternatives with suitable permission within the same learning scope and candidate limit. Do not bypass the original source's restrictions through mirrors or invent permission; report uncovered scope if no permitted alternative is found. Maximum 30 candidate URLs. Report uncovered scope. Discovery does not mean the app has downloaded the source: do not claim acquisition in the discovery summary.",
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
                containsVerbatimQuote(p.text, candidate.reuseEvidence!.quote),
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
      if (src.status !== "extracted" || src.kind === "reference") continue;
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
    const acquired = outcomes.filter(
      (outcome) => outcome.status === "extracted",
    ).length;
    const links = outcomes.filter(
      (outcome) => outcome.status === "link_only",
    ).length;
    return {
      ...research,
      discoverySummary: research.summary,
      summary: `자료 ${research.sources.length}개 발견 · 본문 수집 ${acquired}개 · 링크만 보관 ${links}개 · 수집 실패 ${outcomes.length - acquired - links}개. 참고 자료는 출제 근거로 보관하고, 기존 문제가 있는 자료만 문항 추출을 진행합니다.`,
      outcomes,
      extracted,
      coverage: "bounded_search",
    };
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
    const pool = latestMaterials(catalog, src.goalId);
    const relevant = pool.filter((m) => m.sourceId === src.id);
    const latest = relevant[0]?.revisionId;
    requireThat(relevant.length, "NO_TEXT", "먼저 원문을 추출하세요.", 409);
    const answerSegments: Material[] = src.answerSourceIds.flatMap(
      (sourceId: string) => {
        const other = catalog.readSource(sourceId);
        requireThat(
          other.goalId === src.goalId,
          "ANSWER_SOURCE",
          "정답표의 목표가 다릅니다.",
        );
        return pool.filter((m) => m.sourceId === sourceId);
      },
    );
    const created: string[] = [];
    const unresolved: { reference: string; reason: string }[] = [];
    const sourceContext = documentEdges(relevant);
    if (input.pdfPages)
      requireThat(
        input.pdfPages.length > 0 &&
          input.pdfPages.every((page: number) =>
            relevant.some((m) => m.locator.pdfPage === page),
          ),
        "PDF_PAGES",
        "존재하는 PDF 페이지를 선택하세요.",
      );
    // Extract one segment at a time: multi-page PDF batches can require very
    // large structured answers. Neighbours preserve continuations/context.
    for (let offset = 0; offset < relevant.length; offset++) {
      if (
        input.pdfPages &&
        !input.pdfPages.includes(relevant[offset]!.locator.pdfPage)
      )
        continue;
      const batch = relevant.slice(offset, offset + 1);
      const adjacentSegments = relevant
        .slice(Math.max(0, offset - 1), offset + 2)
        .filter((m) => !batch.includes(m));
      let body = relevant.filter(
        (m) =>
          batch.includes(m) ||
          adjacentSegments.includes(m) ||
          sourceContext.includes(m),
      );
      const answerHeaders = documentEdges(answerSegments);
      let selectedAnswers = [
        ...new Map(
          [
            ...answerHeaders,
            ...selectMaterials(
              answerSegments,
              batch.map((m) => m.text).join("\n"),
              { maxSegments: 7, maxChars: 56_000 },
            ),
            // Short answer keys often contain only numbers and letters, not
            // the vocabulary of the question. Fill the remaining bounded
            // context with whole segments instead of dropping those keys.
            ...answerSegments,
          ].map((m) => [m.segmentId, m]),
        ).values(),
      ].slice(0, 10);
      const rendered = await withPageImages(
        s,
        [...body, ...selectedAnswers],
        ctx.signal,
      );
      body = rendered.slice(0, body.length);
      selectedAnswers = rendered.slice(body.length);
      const supplied = (items: Material[]) =>
        items.map((m) => body.find((v) => v.segmentId === m.segmentId) ?? m);
      const processed = new Map<
        string,
        { reference: string; stem?: string; reason?: string }
      >();
      for (let part = 0; part < 20; part++) {
        const result = await ctx.step(
          `extract:page:${latest}:${offset}:${part}`,
          async () => {
            let previousFailure: string | null = null;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                return await ask(
                  ctx,
                  "extract_existing_questions",
                  {
                    goal: goalAtScope(src.goalId, scope.id),
                    source: src,
                    scope,
                    segments: supplied(batch),
                    adjacentSegments: supplied(adjacentSegments),
                    sourceHeader: supplied([relevant[0]!])[0],
                    sourceContext: supplied(sourceContext),
                    answerSegments: selectedAnswers,
                    previousFailure,
                    processed: [...processed.values()],
                    pagePolicy:
                      "Return at most TWO new questions in this response. processed lists questions or unresolved items already handled for this segment; do not repeat them. Set hasMore=true only if additional unprocessed questions remain in segments. Do not report remaining extractable questions as unresolved merely because of this response limit: they will be requested next. Use the shortest exact quotations that still establish the parent problem, printed marker and answer. Do not quote whole pages when a shorter complete passage suffices.",
                    evidencePolicy:
                      "Put question, answer and edition citations in sourceMatch. The server assembles these into evidence automatically after exact-source validation. evidence only needs additional support such as a parent problem or shared passage; do not repeat sourceMatch citations there. Never invent or paraphrase any quote.",
                    shortAnswerPolicy,
                    referencePolicy:
                      "questionReference and answerReference must be identical single literal printed markers inside their respective exact text quote. Do not synthesize composite labels when parent number and subpart are printed separately. Include the parent problem and shared context in evidence to disambiguate repeated subpart markers. answerEvidence anchors the printed marker. If the answer continues onto later segments/pages, put exact quotations in answerContinuationEvidence, in consecutive segment order from the same revision, including all intervening segments. Keep the original page boundaries. Inspect the page images to distinguish a continued answer from the next subpart. Never link solely because pages are adjacent. Preserve groupId across subquestions.",
                    wordingPolicy:
                      "For PDF questions with supplied pageImage, use visual extraction: set visualTranscription=true for EVERY such question, faithfully transcribe the original printed wording and math into readable plain/Unicode notation (e.g. x^2, explicit fractions), retain language and labels, and attach the original question pages. This explicit mode is necessary even for a punctuation or mathematical glyph difference from the text layer. For sources WITHOUT images, keep contiguous verbatim stem/passage/choices with whitespace normalization only and visualTranscription=false. Do not paraphrase, use LaTeX markup or guess from the answer sheet. For graphs keep the actual original image, not an invented textual replacement. Include visualEvidence {segmentId,assetId,role} for every question/answer page you visually rely on, using supplied pageImage IDs; include a literal text-layer citation for each such segment in evidence. All quote fields MUST remain exact text-layer substrings, never the visual transcription. requiredAssetIds must include ALL question-role image IDs and NO answer-role images. Use no other asset IDs. Never attach a question image containing solutions to learners. If no image resolves the problem, report unresolved. An original answer typo/conflict remains unresolved, not silently repaired.",
                    instruction:
                      "Extract only existing complete questions anchored in segments, not new ones or questions appearing only in sourceHeader/sourceContext/adjacentSegments. adjacentSegments supply shared passages or continuations; the questionEvidence anchor must be in segments. sourceContext supplies the document's front and back matter for edition evidence; it is not extra question content. Keep exact stem, choices and passage wording. For short questions choices=[] and answer=[]; provide a nonempty modelAnswer and unique rubric IDs with positive points whose sum equals the question points. Do not infer extra scoring requirements from worked solutions. Fix previousFailure when supplied. sourceMatch is required: use the identical printed questionReference/answerReference, cite questionEvidence and answerEvidence with their numbers and original answer. If the answer comes from a separate document, edition must be a common verbatim edition/session identifier and editionEvidence must quote it from BOTH documents, including sourceContext when needed. All match citations must be exact; the server adds them to evidence. Never infer a matching edition from a shared website or URL alone. For answers printed with the question, edition may be null and editionEvidence=[]. Missing or ambiguous answers, edition, passages or assets go in unresolved. Use source kind for origin; user_material and reference map to external_practice only when actual questions exist. Keep linked passage groups together. Never invent unavailable question text.",
                  },
                  z
                    .object({
                      questions: z.array(questionInput).max(2),
                      hasMore: z.boolean().default(false),
                      unresolved: z.array(
                        z
                          .object({ reference: z.string(), reason: z.string() })
                          .strict(),
                      ),
                    })
                    .strict(),
                  false,
                  imageInputs(s, rendered),
                );
              } catch (error) {
                ctx.signal.throwIfAborted();
                if (
                  !(error instanceof Fault) ||
                  error.code !== "AGENT_OUTPUT_INVALID" ||
                  attempt === 1
                )
                  throw error;
                previousFailure = error.message.slice(0, 4000);
              }
            }
            throw new Error("Unreachable extraction retry");
          },
          (output) => {
            const ids: string[] = [];
            const issues = [...output.unresolved];
            for (const returned of output.questions) {
              let q = returned;
              try {
                q = withExtractionEvidence(q);
                requireThat(
                  q.goalId === src.goalId && q.scopeId === scope.id,
                  "AGENT_SCOPE",
                  "추출 결과 범위가 다릅니다.",
                );
                validateExtraction(q, src, body, selectedAnswers);
                requireThat(
                  batch.some(
                    (m) =>
                      m.segmentId === q.sourceMatch!.questionEvidence.segmentId,
                  ),
                  "SOURCE_BATCH",
                  "이번 원문 구간의 문항이 아닙니다.",
                );
                ids.push(catalog.createQuestion(q).id);
              } catch (error) {
                if (!(error instanceof Fault)) throw error;
                issues.push({
                  reference:
                    q.sourceMatch?.questionReference ?? q.stem.slice(0, 100),
                  reason: error.message,
                });
              }
            }
            return {
              ids,
              unresolved: issues,
              hasMore: output.hasMore,
              processed: [
                ...output.questions.map((q) => ({
                  reference: q.sourceMatch?.questionReference ?? "",
                  stem: q.stem,
                })),
                ...output.unresolved.map((issue) => ({
                  reference: issue.reference,
                  reason: issue.reason,
                })),
              ],
            };
          },
        );
        created.push(...result.ids);
        unresolved.push(...result.unresolved);
        const before = processed.size;
        for (const item of result.processed)
          processed.set(
            JSON.stringify([item.reference, "stem" in item ? item.stem : null]),
            item,
          );
        if (!result.hasMore) break;
        if (processed.size === before || part === 19) {
          unresolved.push({
            reference: `segment:${batch[0]!.segmentId}`,
            reason:
              "문항 추출의 추가 응답이 진전되지 않거나 구간 처리 한도에 도달했습니다. 남은 문항을 확인하세요.",
          });
          break;
        }
      }
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
    const questionIds = [...new Set(created)];
    return {
      questionIds,
      count: questionIds.length,
      usable: questionIds.filter(
        (qid) => catalog.readQuestion(qid).status === "usable",
      ).length,
      needsReview: questionIds.filter(
        (qid) => catalog.readQuestion(qid).status !== "usable",
      ).length,
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
    const pool = latestMaterials(catalog, exam.goalId);
    if (empty.length && !pool.length)
      throw new Waiting({
        code: "SOURCE_REQUIRED",
        message: "문항 생성에 사용할 근거 자료를 먼저 등록하세요.",
      });
    for (const slot of empty) {
      const goal = goalAtScope(exam.goalId, exam.scopeId);
      const concept = goal.scope.concepts.find(
        (c: any) => c.id === slot.conceptId,
      );
      const matched = selectMaterials(pool, concept.name);
      const materials = matched.length
        ? matched
        : selectMaterials(pool, concept.name, { allowFallback: true });
      if (!materials.length)
        throw new Waiting({
          code: "RELEVANT_SOURCE_REQUIRED",
          slot: slot.slot,
          conceptId: slot.conceptId,
          message: `‘${concept.name}’에 연결할 근거 구간을 찾지 못했습니다. 관련 자료를 추가하거나 범위의 개념명을 확인한 뒤 다시 진행하세요.`,
        });
      ctx.event({
        type: "materials_selected",
        slot: slot.slot,
        conceptId: slot.conceptId,
        segmentIds: materials.map((m) => m.segmentId),
        method: matched.length ? "local_lexical" : "bounded_fallback",
      });
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
                  goal,
                  scopeId: exam.scopeId,
                  slot,
                  materials,
                  previousFailure: feedback,
                  exclude: current.items.map((q: any) => q.stem),
                  sourceMatch: null,
                  shortAnswerPolicy,
                  instruction:
                    "Create exactly one original grounded question for this slot. origin=ai_generated. Set goalId, scopeId, type and conceptIds exactly from the input. Use human-readable choice/rubric IDs. familyId, parentId and groupId must be null for a new independent question. No unsupported image/audio assets. Use exact supplied evidence quotes. For short answers choices=[] and answer=[], provide modelAnswer and rubric whose points sum to points. Choices may be shuffled: in stem, choices and explanation refer to exact choice content, never positional letters/numbers or phrases like all/none of the above. Correct previousFailure if present.",
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
              validateSuppliedEvidence(q, materials);
              requireThat(
                q.sourceMatch === null,
                "SOURCE_MATCH",
                "AI 생성 문제에 기존 문항의 정답표 연결을 붙일 수 없습니다.",
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
              if (e instanceof Fault && e.code.startsWith("CODEX_")) throw e;
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
          throw new Waiting({
            code: "GENERATION_REVIEW_REQUIRED",
            slot: slot.slot,
            conceptId: slot.conceptId,
            message: `${slot.slot}번 문항의 근거·정답을 확정하지 못했습니다: ${feedback}`,
            choices: ["관련 자료 보완 후 다시 진행", "범위와 자료의 연결 확인"],
          });
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
        item.assessment.actor === "user" ||
        item.assessment.actor === "correction" ||
        item.assessment.correctionRevision
      )
        continue;
      const expectedVersion = item.assessment.version;
      const gradeStep = `grade:${item.slot}:${expectedVersion}`;
      await ctx.step(
        gradeStep,
        async () => {
          const question = {
            stem: item.stem,
            passage: item.passage,
            modelAnswer: item.modelAnswer,
            rubric: item.rubric,
          };
          // Audit without the model answer or learner's answer to avoid adding
          // requirements after seeing a verbose solution or a concise response.
          const audit = await ctx.step(`${gradeStep}:audit`, async () =>
            validateRubricAudit(
              question,
              await ask(
                ctx,
                "audit_rubric",
                {
                  question: {
                    stem: item.stem,
                    passage: item.passage,
                    rubric: item.rubric,
                  },
                  instruction: rubricInstruction,
                },
                rubricAuditOutput,
              ),
            ),
          );
          if (audit.criteria.some((c) => !c.aligned)) return { audit };
          const gradingInput = {
            question,
            rubricAudit: audit,
            answer: item.answerGiven?.value ?? "",
            instruction: semanticInstruction,
          };
          const checkedGrade = async (
            role: string,
            payload: typeof gradingInput,
          ) => {
            const value = await ask(ctx, role, payload, semanticGradeOutput);
            // Reject fabricated quotes/IDs before checkpointing; a failed model
            // response must remain replaceable when the user resumes the job.
            validateSemanticGrade(question, gradingInput.answer, value);
            return value;
          };
          // Persist successful calls independently. Resuming after a provider
          // limit must not spend usage repeating the audit and first judgment.
          const first = await ctx.step(`${gradeStep}:first`, () =>
            checkedGrade("grade_answer", gradingInput),
          );
          const second =
            first.status === "confirmed" && needsGradeReview(question, first)
              ? await ctx.step(`${gradeStep}:second`, () =>
                  checkedGrade("review_short_answer", {
                    ...gradingInput,
                    instruction:
                      semanticInstruction +
                      " Independently re-evaluate this answer, particularly alternate valid wording and any deductions for unrequested detail. You are not given the earlier grade; do not infer it.",
                  }),
                )
              : undefined;
          return { audit, first, ...(second ? { second } : {}) };
        },
        (r) =>
          learning.reviewedGrade(
            input.attemptId,
            item.slot,
            r,
            expectedVersion,
          ),
      );
    }
    return learning.result(input.attemptId);
  });
  jobs.handlers.set("summarize_wrong", async (input, ctx) => {
    const snapshot = learning.wrong(input.goalId);
    const conceptIds = new Set(
      snapshot.flatMap((item: any) => item.conceptIds),
    );
    const concepts = s
      .all("SELECT id,name,area FROM concepts WHERE goal_id=?", input.goalId)
      .filter((concept) => conceptIds.has(concept.id));
    return ctx.step(
      "summary",
      () =>
        ask(
          ctx,
          "summarize_misconceptions",
          {
            goal: catalog.readGoal(input.goalId),
            concepts,
            wrong: snapshot.slice(0, 50),
            instruction:
              "Group by actual concept IDs and explain from answer evidence. Keep IDs only in structured fields (conceptId, attemptIds), never in summary/example prose. In prose refer to the question slot number and quote a short relevant answer. Write summary in 2-3 short paragraphs: observed answer, concept to revisit, next action. Distinguish inferred reasons from user-confirmed ones; do not diagnose an unanswered item without evidence. Put one concise contrasting example in example. Use fenced Markdown code blocks with a language tag for code and preserve indentation.",
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
        const valid = new Set(concepts.map((concept) => concept.id));
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
            goal: goalAtScope(parent.goalId, parent.scopeId),
            parent,
            materials,
            sourceMatch: null,
            shortAnswerPolicy,
            instruction:
              "Test the same concept with a meaningfully different situation. origin=ai_variant and parentId must equal the original ID. Preserve goal/scope and family. Cite exact source evidence. Choices may be shuffled: in stem, choices and explanation refer to exact choice content, never positional letters/numbers or phrases like all/none of the above.",
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
        validateSuppliedEvidence(q, materials);
        catalog.validateQuestion(q);
        requireThat(
          q.sourceMatch === null,
          "SOURCE_MATCH",
          "AI 변형 문제에 기존 문항의 정답표 연결을 붙일 수 없습니다.",
        );
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
