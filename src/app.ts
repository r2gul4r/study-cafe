import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  correctionInput,
  saveCorrection,
  confirmCorrection,
} from "./corrections.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.js";
import { BrowserSessions } from "./browser-sessions.js";
import { readNotes } from "./notes.js";
import { Catalog, sourceInput } from "./catalog.js";
import { Sources, fetchPublic } from "./sources.js";
import { Jobs } from "./jobs.js";
import { GoalLifecycle } from "./goal-lifecycle.js";
import { Exams } from "./exams.js";
import { Learning } from "./learning.js";
import { reviewQueue } from "./reviews.js";
import { gradePython, pythonRuntime } from "./python.js";
import { CodexAgent, type AgentPort } from "./agent.js";
import { registerWorkflows } from "./workflows.js";
import {
  questionRegionsInput,
  saveQuestionRegions,
} from "./question-regions.js";
import { backup, verifyBackup, lockData, backupRestorePlan } from "./backup.js";
import {
  Fault,
  requireThat,
  decode,
  now,
  goalInput,
  scopeInput,
  questionInput,
  templateInput,
  key,
  id,
} from "./core.js";

export type AppOptions = {
  dataDir: string;
  webDir?: string;
  agent?: AgentPort;
  fetcher?: typeof fetchPublic;
  token?: string;
  allowedOrigins?: string[];
  autoWorker?: boolean;
  lock?: boolean;
};
export async function createApp(options: AppOptions) {
  const release = options.lock === false ? () => {} : lockData(options.dataDir);
  const store = new Store(options.dataDir);
  const catalog = new Catalog(store),
    sources = new Sources(catalog, options.fetcher),
    exams = new Exams(catalog),
    learning = new Learning(exams),
    jobs = new Jobs(store);
  const goalLifecycle = new GoalLifecycle(store, jobs);
  const agent =
    options.agent ??
    new CodexAgent({
      cwd: join(options.dataDir, "agent-work"),
      model: process.env.STUDY_CAFE_MODEL,
    });
  registerWorkflows(jobs, catalog, sources, exams, learning, agent);
  const tokenFile = join(options.dataDir, "session-token");
  const token =
    options.token ??
    (existsSync(tokenFile)
      ? readFileSync(tokenFile, "utf8").trim()
      : randomBytes(32).toString("hex"));
  if (!options.token && !existsSync(tokenFile))
    writeFileSync(tokenFile, token, { mode: 0o600, flag: "wx" });
  const browserSessions = new BrowserSessions(options.dataDir, token);
  const bearerValid = (authorization?: string) => {
    const supplied = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    return (
      !!token &&
      Buffer.byteLength(supplied) === Buffer.byteLength(token) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    );
  };
  const browserRequest = (req: FastifyRequest) => {
    const site = req.headers["sec-fetch-site"];
    requireThat(
      req.headers["x-study-cafe-client"] === "browser" &&
        (!req.headers.origin ||
          req.headers.origin === `http://${req.headers.host}`) &&
        (!site || site === "same-origin" || site === "none"),
      "BROWSER_ORIGIN",
      "공부방 화면에서 연결해 주세요.",
      403,
    );
  };
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
  const frontend =
    !!options.webDir && existsSync(join(options.webDir, "index.html"));
  const paths: Record<string, any> = {};
  const origins = new Set(options.allowedOrigins ?? []);
  app.addHook("onRequest", async (req, reply) => {
    const hostname = req.hostname;
    requireThat(
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname),
      "HOST",
      "허용하지 않는 Host입니다.",
      403,
    );
    const origin = req.headers.origin;
    if (origin) {
      requireThat(
        origins.has(origin),
        "ORIGIN",
        "허용하지 않는 Origin입니다.",
        403,
      );
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Vary", "Origin")
        .header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Idempotency-Key, Last-Event-ID, X-Study-Cafe-Client",
        )
        .header(
          "Access-Control-Allow-Methods",
          "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        );
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
    if (req.url === "/health") return;
    const pathname = req.url.split("?")[0]!;
    if (pathname.startsWith("/api/browser/"))
      reply.header("Cache-Control", "no-store");
    if (pathname === "/api/browser/connect" && req.method === "POST") {
      browserRequest(req);
      return;
    }
    if (
      frontend &&
      ["GET", "HEAD"].includes(req.method) &&
      (pathname === "/" ||
        pathname === "/index.html" ||
        pathname.startsWith("/assets/"))
    )
      return;
    if (bearerValid(req.headers.authorization)) return;
    if (browserSessions.valid(req.headers.host!, req.headers.cookie)) {
      browserRequest(req);
      return;
    }
    requireThat(
      false,
      "UNAUTHORIZED",
      "공부방 열기를 실행해 연결해 주세요.",
      401,
    );
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION",
          message: "입력을 확인하세요.",
          issues: error.issues,
        },
      });
    if (error instanceof Fault)
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    if ((error as any).statusCode === 413)
      return reply.code(413).send({
        error: {
          code: "TOO_LARGE",
          message: "요청 크기 제한을 초과했습니다.",
        },
      });
    if ((error as any).statusCode >= 400 && (error as any).statusCode < 500)
      return reply.code((error as any).statusCode).send({
        error: {
          code: "BAD_REQUEST",
          message: "요청 형식이 잘못되었습니다.",
        },
      });
    return reply.code(500).send({
      error: { code: "INTERNAL", message: "서버 처리 오류가 발생했습니다." },
    });
  });
  const route = (
    method: any,
    path: string,
    description: string,
    handler: (req: any, reply: any) => any,
    body?: z.ZodType,
  ) => {
    const documentedPath = path.replace(/:([A-Za-z]+)/g, "{$1}");
    paths[documentedPath] ??= {};
    paths[documentedPath][method.toLowerCase()] = {
      summary: description,
      security:
        path === "/health"
          ? []
          : path === "/api/browser/connect"
            ? [{}, { localToken: [] }]
            : path === "/api/browser/launch"
              ? [{ localToken: [] }]
              : [{ localToken: [] }, { browserCookie: [], browserClient: [] }],
      ...(path === "/api/browser/connect"
        ? {
            description:
              "Requires X-Study-Cafe-Client: browser and same-origin request. Supply a one-use launch code in the body, or the existing root Bearer token with an empty object for migration. Returns an HttpOnly cookie; anonymous empty requests are rejected.",
          }
        : {}),
      ...(body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: z.toJSONSchema(body, { unrepresentable: "any" }),
                },
              },
            },
          }
        : {}),
      parameters: [...path.matchAll(/:([A-Za-z]+)/g)].map((match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      responses: {
        "200": { description: "성공" },
        "202": {
          description:
            "비동기 작업 접수. 응답은 Job 객체이며 id로 상태와 이벤트를 조회합니다.",
        },
        "400": { description: "입력 검증 실패" },
        "401": { description: "로컬 세션 인증 필요" },
        "403": { description: "Host 또는 Origin 거부" },
        "404": { description: "자료 없음" },
        "409": { description: "상태 또는 버전 충돌" },
        "422": { description: "지원하지 않는 자료 또는 도메인 검증 실패" },
        "502": { description: "에이전트 연결 또는 결과 오류" },
        "504": { description: "외부 작업 시간 초과" },
      },
    };
    app.route({
      method,
      url: path,
      handler: async (req, reply) => {
        if (body) req.body = body.parse(req.body);
        return handler(req, reply);
      },
    });
  };
  const enqueue = (kind: string, input: any, req: any, reply: any) => {
    const keyHeader = req.headers["idempotency-key"];
    requireThat(
      !keyHeader || (typeof keyHeader === "string" && keyHeader.length <= 200),
      "REQUEST_KEY",
      "요청 ID가 너무 깁니다.",
    );
    reply.code(202);
    return jobs.enqueue(kind, input, keyHeader);
  };
  const goalId = z.object({ goalId: key }).strict();
  route("GET", "/health", "프로세스 상태", () => ({
    status: "ok",
    version: "0.1.0",
    frontend,
  }));
  route("GET", "/api/openapi.json", "API 명세", () => ({
    openapi: "3.1.0",
    info: { title: "study-cafe backend", version: "0.1.0" },
    components: {
      securitySchemes: {
        localToken: { type: "http", scheme: "bearer" },
        browserCookie: {
          type: "apiKey",
          in: "header",
          name: "Cookie",
          description:
            "HttpOnly cookie issued by /api/browser/connect. Cookie name is study_cafe_ plus the first 16 SHA-256 hex characters of Host (including port). Only same-origin browser requests are accepted.",
        },
        browserClient: {
          type: "apiKey",
          in: "header",
          name: "X-Study-Cafe-Client",
          description:
            "Value must be browser. Required together with the browser cookie; not an authentication secret.",
        },
      },
    },
    paths,
  }));
  route("GET", "/api/goals", "목표 목록", () =>
    store
      .all("SELECT id FROM goals ORDER BY created_at DESC")
      .map((r) => catalog.readGoal(r.id)),
  );
  route(
    "POST",
    "/api/goals",
    "목표 생성",
    (req) => catalog.goal(req.body),
    goalInput,
  );
  route("GET", "/api/goals/:id", "목표 조회", (req) =>
    catalog.readGoal(req.params.id),
  );
  route(
    "PATCH",
    "/api/goals/:id",
    "목표 변경",
    (req) => catalog.updateGoal(req.params.id, req.body),
    goalInput.partial(),
  );
  route(
    "POST",
    "/api/goals/:id/archive",
    "목표 보관",
    (req) => {
      store.get("goals", req.params.id);
      store.run(
        "UPDATE goals SET archived=? WHERE id=?",
        req.body.archived ? 1 : 0,
        req.params.id,
      );
      return catalog.readGoal(req.params.id);
    },
    z.object({ archived: z.boolean() }).strict(),
  );
  route("GET", "/api/goals/:id/deletion-preview", "목표 삭제 범위", (req) =>
    goalLifecycle.preview(req.params.id),
  );
  route(
    "DELETE",
    "/api/goals/:id",
    "목표와 학습 기록 삭제",
    (req) => goalLifecycle.delete(req.params.id, req.body),
    z
      .object({
        title: z.string().min(1).max(200),
        confirmation: z.string().length(64),
      })
      .strict(),
  );
  route(
    "POST",
    "/api/goals/:id/scopes",
    "범위 버전 생성",
    (req) => catalog.scope(req.params.id, req.body),
    scopeInput,
  );
  route("GET", "/api/goals/:id/scopes", "범위 이력", (req) =>
    store
      .all(
        "SELECT * FROM scopes WHERE goal_id=? ORDER BY version",
        req.params.id,
      )
      .map((r) => ({ id: r.id, version: r.version, ...decode(r.data) })),
  );
  route(
    "POST",
    "/api/goals/:id/plan",
    "에이전트 목표 초안",
    (req, reply) =>
      enqueue(
        "plan_goal",
        { goalId: req.params.id, answers: req.body.answers },
        req,
        reply,
      ),
    z
      .object({ answers: z.record(z.string(), z.string()).default({}) })
      .strict(),
  );
  route(
    "POST",
    "/api/goals/:id/research",
    "자료 조사",
    (req, reply) => {
      catalog.readGoal(req.params.id);
      return enqueue("research", { goalId: req.params.id }, req, reply);
    },
    z.object({}).strict(),
  );
  route("GET", "/api/goals/:id/progress", "개념별 학습 상태", (req) =>
    learning.progress(req.params.id),
  );
  route("GET", "/api/goals/:id/wrong", "오답 기록", (req) =>
    learning.wrong(req.params.id),
  );
  route(
    "POST",
    "/api/goals/:id/summarize",
    "오답 개념 요약",
    (req, reply) =>
      enqueue("summarize_wrong", { goalId: req.params.id }, req, reply),
    z.object({}).strict(),
  );
  route("GET", "/api/goals/:id/notes", "요약 기록", (req) =>
    readNotes(store, req.params.id),
  );
  route("GET", "/api/goals/:id/reviews", "복습 예정", (req) =>
    reviewQueue(catalog, req.params.id),
  );
  route(
    "POST",
    "/api/goals/:id/review-exam",
    "오늘 남은 문항으로 복습 시험 생성",
    (req) => exams.createReview(req.params.id),
    z.object({}).strict(),
  );
  route("GET", "/api/goals/:id/review-events", "복습 반영 근거", (req) =>
    store
      .all(
        "SELECT * FROM review_events WHERE goal_id=? ORDER BY occurred_at",
        req.params.id,
      )
      .map((r) => ({
        id: r.id,
        questionId: r.question_id,
        attemptId: r.attempt_id,
        ...decode(r.data),
        occurredAt: r.occurred_at,
      })),
  );
  route(
    "POST",
    "/api/sources",
    "자료 등록",
    (req) => {
      const { goalId, ...data } = req.body;
      return catalog.source(goalId, data);
    },
    sourceInput.extend({ goalId: key }),
  );
  route("GET", "/api/sources", "자료 목록", (req) => {
    const query = goalId.parse(req.query);
    return store
      .all(
        "SELECT id FROM sources WHERE goal_id=? ORDER BY created_at DESC",
        query.goalId,
      )
      .map((r) => catalog.readSource(r.id));
  });
  route("GET", "/api/sources/:id", "자료 상세", (req) =>
    catalog.readSource(req.params.id),
  );
  route(
    "PATCH",
    "/api/sources/:id",
    "자료 권한·정답표 연결 수정",
    (req) => {
      const old = store.get("sources", req.params.id);
      const data = sourceInput.parse({ ...decode<any>(old.data), ...req.body });
      if (data.rights !== "link_only")
        requireThat(
          data.rightsBasis,
          "RIGHTS_BASIS",
          "이용 근거가 필요합니다.",
        );
      for (const sourceId of data.answerSourceIds)
        requireThat(
          store.get("sources", sourceId).goal_id === old.goal_id,
          "GOAL",
          "다른 목표의 정답표입니다.",
        );
      store.run(
        "UPDATE sources SET data=? WHERE id=?",
        JSON.stringify(data),
        req.params.id,
      );
      return catalog.readSource(req.params.id);
    },
    sourceInput.partial(),
  );
  route("GET", "/api/sources/:id/segments", "원문 근거 구간", (req) =>
    catalog.segments(req.params.id),
  );
  route(
    "POST",
    "/api/sources/:id/ingest",
    "다운로드·본문 추출",
    (req, reply) =>
      enqueue(
        "ingest_source",
        { sourceId: req.params.id, ...req.body },
        req,
        reply,
      ),
    z
      .object({
        text: z.string().max(2_000_000).optional(),
        base64: z.string().max(28_000_000).optional(),
        ocr: z.boolean().default(false),
        ocrLanguages: z
          .array(z.enum(["eng", "jpn", "kor"]))
          .length(1)
          .default(["eng"]),
        mime: z
          .enum(["application/pdf", "text/plain", "text/html", "text/markdown"])
          .optional(),
      })
      .strict()
      .refine(
        (v) => !(v.text !== undefined && v.base64),
        "텍스트와 파일 중 하나를 선택하세요.",
      ),
  );
  route(
    "POST",
    "/api/sources/:id/extract-questions",
    "원문에서 문제 추출·검토",
    (req, reply) =>
      enqueue(
        "extract_questions",
        { sourceId: req.params.id, ...req.body },
        req,
        reply,
      ),
    z
      .object({
        pdfPages: z
          .array(z.number().int().min(1).max(300))
          .min(1)
          .max(50)
          .optional(),
      })
      .strict(),
  );
  route("GET", "/api/assets/:id", "자료 원본 다운로드", (req, reply) => {
    const a = store.assetBytes(req.params.id);
    reply
      .header("Content-Type", a.asset.mime)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `attachment; filename="${a.asset.hash}"`);
    return a.bytes;
  });
  route(
    "POST",
    "/api/questions",
    "문항 등록",
    (req) => catalog.createQuestion(req.body),
    questionInput,
  );
  route("GET", "/api/questions", "문제은행 검색", (req) => {
    const q = z
      .object({
        goalId: key,
        q: z.string().optional(),
        origin: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        conceptId: key.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .strict()
      .parse(req.query);
    return catalog.listQuestions(q.goalId, q);
  });
  route("GET", "/api/questions/:id", "문항 상세·정답", (req) =>
    catalog.readQuestion(req.params.id),
  );
  route(
    "GET",
    "/api/questions/:id/evidence",
    "문항 버전의 원문 근거 대조",
    (req) => {
      const query = z
        .object({ revisionId: key.optional() })
        .strict()
        .parse(req.query);
      return catalog.questionEvidence(req.params.id, query.revisionId);
    },
  );
  route("GET", "/api/questions/:id/revisions", "문항 수정 이력", (req) =>
    catalog.questionRevisions(req.params.id),
  );
  route(
    "POST",
    "/api/questions/:id/regions",
    "PDF 문제 표시 영역 새 버전",
    (req) => saveQuestionRegions(catalog, req.params.id, req.body),
    questionRegionsInput,
  );
  route(
    "POST",
    "/api/questions/:id/corrections",
    "원본 정답 정정안 저장",
    (req) => saveCorrection(catalog, req.params.id, req.body),
    correctionInput,
  );
  route(
    "POST",
    "/api/questions/:id/corrections/confirm",
    "검증된 정정안 사용자 확정",
    (req) => confirmCorrection(catalog, req.params.id, req.body),
    z
      .object({
        revisionId: key,
        reviewToken: key,
        reason: z.string().trim().min(1).max(5000),
      })
      .strict(),
  );
  route(
    "POST",
    "/api/questions/:id/revisions",
    "문항 수정 버전",
    (req) => {
      const { expectedRevisionId, ...input } = req.body;
      return catalog.createQuestion(input, {
        questionId: req.params.id,
        expectedRevisionId,
      });
    },
    questionInput.safeExtend({ expectedRevisionId: key.optional() }),
  );
  route(
    "POST",
    "/api/questions/:id/regrade",
    "정정 버전으로 이전 답안 재채점",
    (req) =>
      learning.regradeQuestion(
        req.params.id,
        req.body.revisionId,
        req.body.reason,
      ),
    z.object({ revisionId: key, reason: z.string().min(1).max(5000) }).strict(),
  );
  route(
    "POST",
    "/api/questions/:id/archive",
    "문항 보관",
    (req) => {
      store.get("questions", req.params.id);
      store.run(
        "UPDATE questions SET archived=? WHERE id=?",
        req.body.archived ? 1 : 0,
        req.params.id,
      );
      return catalog.readQuestion(req.params.id);
    },
    z.object({ archived: z.boolean() }).strict(),
  );
  route(
    "POST",
    "/api/questions/:id/review",
    "사용자 검토",
    (req) => {
      const q = catalog.readQuestion(req.params.id);
      requireThat(
        q.revisionId === req.body.revisionId,
        "REVISION_CONFLICT",
        "문항 버전이 변경되었습니다.",
        409,
      );
      return catalog.review(q.revisionId, req.body.status, req.body.reason);
    },
    z
      .object({
        revisionId: key,
        status: z.enum(["usable", "needs_review", "retired"]),
        reason: z.string().min(1).max(5000),
      })
      .strict(),
  );
  route(
    "POST",
    "/api/questions/:id/verify",
    "에이전트 검토",
    (req, reply) =>
      enqueue("verify_question", { questionId: req.params.id }, req, reply),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/questions/:id/variant",
    "변형 문항 작성",
    (req, reply) =>
      enqueue("generate_variant", { questionId: req.params.id }, req, reply),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/exam-templates",
    "시험 템플릿 저장",
    (req) => exams.template(req.body),
    templateInput,
  );
  route("GET", "/api/exam-templates", "시험 템플릿 목록", () =>
    store
      .all("SELECT * FROM templates ORDER BY created_at DESC")
      .map((r) => ({ id: r.id, ...decode(r.data) })),
  );
  route(
    "POST",
    "/api/exams",
    "시험 구성표·기존 문항 선택",
    (req) => exams.create(req.body.goalId, req.body.templateId, req.body.seed),
    z
      .object({
        goalId: key,
        templateId: key,
        seed: z.string().min(1).max(100).optional(),
      })
      .strict(),
  );
  route("GET", "/api/exams", "시험 목록", (req) =>
    store
      .all(
        "SELECT id FROM exams WHERE goal_id=? ORDER BY created_at DESC",
        goalId.parse(req.query).goalId,
      )
      .map((r) => exams.get(r.id)),
  );
  route("GET", "/api/exams/:id", "시험 조회 (정답 제외)", (req) =>
    exams.get(req.params.id),
  );
  route(
    "POST",
    "/api/exams/:id/prepare",
    "부족분 출제·검토·시험 확정",
    (req, reply) =>
      enqueue("prepare_exam", { examId: req.params.id }, req, reply),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/exams/:id/finalize",
    "준비된 시험 확정",
    (req) => exams.finalize(req.params.id),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/exams/:id/attempts",
    "응시 시작",
    (req) => exams.start(req.params.id),
    z.object({}).strict(),
  );
  route("GET", "/api/attempts", "목표별 응시 기록", (req) => {
    learning.expire();
    const goalId = key.parse(req.query.goalId);
    catalog.readGoal(goalId);
    return store
      .all(
        "SELECT a.id FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE e.goal_id=? ORDER BY a.started_at DESC",
        goalId,
      )
      .map((r) => exams.attempt(r.id));
  });
  route("GET", "/api/attempts/:id", "응시·저장 답안 조회", (req) => {
    learning.expire();
    return exams.attempt(req.params.id);
  });
  route(
    "PUT",
    "/api/attempts/:id/answers/:slot",
    "버전 조건부 답안 저장",
    (req) => {
      learning.expire();
      return exams.saveAnswer(
        req.params.id,
        z.coerce.number().int().min(1).parse(req.params.slot),
        req.body,
      );
    },
    z
      .object({
        value: z.union([z.string().max(20000), z.array(key).max(10)]),
        version: z.number().int().min(0),
        flagged: z.boolean().default(false),
        uncertain: z.boolean().default(false),
        hintUsed: z.boolean().default(false),
        recall: z.enum(["hard", "good", "easy"]).nullable().default(null),
      })
      .strict(),
  );
  route("GET", "/api/python/runtime", "Python 실행기 상태", () => ({
    available: pythonRuntime().available,
    engine: pythonRuntime().engine,
  }));
  route(
    "POST",
    "/api/questions/:id/suggest-regions",
    "PDF 표시 영역 추천",
    (req, reply) =>
      enqueue(
        "suggest_regions",
        { questionId: req.params.id, revisionId: req.body.revisionId },
        req,
        reply,
      ),
    z.object({ revisionId: key }).strict(),
  );
  let pythonPreviewBusy = false;
  route(
    "POST",
    "/api/attempts/:id/python/:slot",
    "공개 예제로 Python 실행",
    async (req) => {
      learning.expire();
      const attempt = exams.attempt(req.params.id);
      requireThat(
        attempt.status === "active",
        "ATTEMPT_CLOSED",
        "진행 중인 시험에서 실행하세요.",
        409,
      );
      const item = attempt.exam.items.find(
        (q: any) => q.slot === Number(req.params.slot),
      );
      exams.sections.assertSlot(req.params.id, Number(req.params.slot));
      requireThat(
        item?.python,
        "PYTHON_QUESTION",
        "Python 실행 문항이 아닙니다.",
      );
      requireThat(
        !pythonPreviewBusy,
        "PYTHON_BUSY",
        "다른 코드 실행이 끝난 뒤 다시 실행하세요.",
        409,
      );
      pythonPreviewBusy = true;
      try {
        return await gradePython(req.body.code, item.python);
      } finally {
        pythonPreviewBusy = false;
      }
    },
    z.object({ code: z.string().min(1).max(20000) }).strict(),
  );
  route(
    "POST",
    "/api/attempts/:id/next-section",
    "현재 섹션 확정 후 다음 섹션",
    (req) => {
      learning.expire();
      requireThat(
        exams.sections.next(req.params.id, req.body.expectedIndex),
        "LAST_SECTION",
        "마지막 섹션입니다. 답안을 제출하세요.",
        409,
      );
      return exams.attempt(req.params.id);
    },
    z.object({ expectedIndex: z.number().int().min(0) }).strict(),
  );
  route(
    "POST",
    "/api/attempts/:id/pause",
    "일반 학습 일시정지",
    (req) => exams.pause(req.params.id),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/attempts/:id/resume",
    "일반 학습 재개",
    (req) => exams.pause(req.params.id, true),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/attempts/:id/submit",
    "제출·객관식 채점",
    (req, reply) => {
      const expired = learning.expire();
      const result = learning.submit(
        req.params.id,
        req.body.requestId,
        expired.includes(req.params.id),
      );
      const job = result.pending
        ? jobs.enqueue(
            "grade_attempt",
            { attemptId: req.params.id },
            "grade:" + req.params.id,
          )
        : null;
      return { ...result, gradingJobId: job?.id ?? null };
    },
    z.object({ requestId: key }).strict(),
  );
  route("GET", "/api/attempts/:id/result", "점수·해설·보류 결과", (req) =>
    learning.result(req.params.id),
  );
  route(
    "POST",
    "/api/attempts/:id/grade",
    "주관식 재평가 작업",
    (req, reply) =>
      enqueue("grade_attempt", { attemptId: req.params.id }, req, reply),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/attempts/:id/assessments/:slot",
    "사용자 채점 확정·정정",
    (req) =>
      learning.manual(
        req.params.id,
        z.coerce.number().int().min(1).parse(req.params.slot),
        req.body,
      ),
    z
      .object({
        score: z.number().nonnegative().nullable(),
        passed: z.boolean(),
        status: z.enum(["confirmed", "pending"]),
        reason: z.string().min(1).max(5000),
        explanation: z.string().min(1).max(20000),
        expectedVersion: z.number().int().min(1),
      })
      .strict(),
  );
  route(
    "GET",
    "/api/attempts/:id/assessment-history",
    "불변 채점 이력",
    (req) =>
      store
        .all(
          "SELECT * FROM assessments WHERE attempt_id=? ORDER BY slot,version",
          req.params.id,
        )
        .map((r) => ({
          id: r.id,
          slot: r.slot,
          version: r.version,
          status: r.status,
          ...decode(r.data),
        })),
  );
  route("GET", "/api/jobs", "작업 목록", () =>
    store
      .all("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 200")
      .map((r) => jobs.get(r.id)),
  );
  route("GET", "/api/jobs/:id", "작업 상태", (req) => jobs.get(req.params.id));
  route(
    "POST",
    "/api/jobs/:id/cancel",
    "작업 취소",
    (req) => jobs.cancel(req.params.id),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/jobs/:id/pause",
    "작업 일시정지",
    (req) => jobs.cancel(req.params.id, true),
    z.object({}).strict(),
  );
  route(
    "POST",
    "/api/jobs/:id/resume",
    "작업 재개",
    (req) => jobs.resume(req.params.id),
    z.object({}).strict(),
  );
  route("GET", "/api/jobs/:id/events", "저장된 진행 이벤트", (req) =>
    jobs.events(
      req.params.id,
      z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.query.after ?? 0),
    ),
  );
  const streamClients = new Set<() => void>();
  route(
    "GET",
    "/api/jobs/:id/stream",
    "SSE 진행 이벤트 재연결",
    (req, reply) => {
      jobs.get(req.params.id);
      let cursor = z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.headers["last-event-id"] ?? req.query.after ?? 0);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(req.headers.origin
          ? { "Access-Control-Allow-Origin": req.headers.origin }
          : {}),
      });
      const flush = () => {
        for (const e of jobs.events(req.params.id, cursor)) {
          reply.raw.write(
            `id: ${e.id}\nevent: progress\ndata: ${JSON.stringify(e.data)}\n\n`,
          );
          cursor = e.id;
        }
      };
      const listener = (jobId: string) => {
        if (jobId === req.params.id) flush();
      };
      const heartbeat = setInterval(() => {
        flush();
        reply.raw.write(": keepalive\n\n");
      }, 1000);
      const close = () => {
        clearInterval(heartbeat);
        jobs.off("event", listener);
        streamClients.delete(close);
        reply.raw.end();
      };
      jobs.on("event", listener);
      streamClients.add(close);
      reply.raw.on("close", close);
      flush();
    },
  );
  route("GET", "/api/agent/status", "코덱스 연결·로그인 상태", () =>
    agent.status(),
  );
  route("GET", "/api/agent/models", "코덱스 모델 목록", () => agent.models());
  route(
    "POST",
    "/api/agent/login",
    "코덱스 관리 로그인 시작",
    (req) => agent.login(req.body.type),
    z
      .object({
        type: z.enum(["chatgpt", "chatgptDeviceCode"]).default("chatgpt"),
      })
      .strict(),
  );
  route(
    "POST",
    "/api/backups",
    "DB·첨부 백업",
    () => backup(store),
    z.object({}).strict(),
  );
  route("GET", "/api/backups", "백업 목록", () => {
    const dir = join(store.dir, "backups");
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => /^[a-f0-9-]{36}$/.test(n))
          .map((n) =>
            JSON.parse(readFileSync(join(dir, n, "manifest.json"), "utf8")),
          )
      : [];
  });
  route(
    "GET",
    "/api/backups/:id/restore-plan",
    "백업 내용 확인·복원 안내 (읽기 전용)",
    (req) => backupRestorePlan(store, req.params.id),
  );
  route(
    "POST",
    "/api/backups/:id/verify",
    "백업 무결성 확인",
    (req) => {
      requireThat(
        /^[a-f0-9-]{36}$/.test(req.params.id),
        "BACKUP_ID",
        "잘못된 백업 ID",
      );
      return verifyBackup(join(store.dir, "backups", req.params.id));
    },
    z.object({}).strict(),
  );
  route("GET", "/api/home", "오늘 학습 요약", () => {
    learning.expire();
    return {
      goals: store.all("SELECT id FROM goals WHERE archived=0").map((r) => ({
        id: r.id,
        title: catalog.readGoal(r.id).title,
        progress: learning.progress(r.id),
      })),
      continueAttempts: store.all(
        "SELECT id,exam_id,status FROM attempts WHERE status IN ('active','paused') ORDER BY started_at DESC",
      ),
      dueReviews: store
        .all("SELECT id FROM goals WHERE archived=0")
        .reduce(
          (n, g) =>
            n + reviewQueue(catalog, g.id).filter((r) => r.overdue).length,
          0,
        ),
      jobs: store.all(
        "SELECT id,kind,status FROM jobs WHERE status IN ('running','queued','waiting_user','failed','paused') ORDER BY created_at DESC LIMIT 20",
      ),
    };
  });
  route(
    "POST",
    "/api/browser/launch",
    "로컬 실행기용 일회용 연결",
    (req) => {
      requireThat(
        bearerValid(req.headers.authorization),
        "UNAUTHORIZED",
        "로컬 실행기에서 공부방을 열어 주세요.",
        401,
      );
      const origin = req.body?.origin ?? `http://${req.headers.host}`;
      const target = new URL(origin);
      requireThat(
        target.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
          target.origin === origin &&
          (origin === `http://${req.headers.host}` || origins.has(origin)),
        "ORIGIN",
        "허용하지 않는 공부방 주소입니다.",
        403,
      );
      const code = browserSessions.issue(target.host);
      return { url: `${origin}/#/connect?code=${code}` };
    },
    z.object({ origin: z.url().optional() }).strict().optional(),
  );
  route(
    "POST",
    "/api/browser/connect",
    "일회용 연결·기존 탭 자동 전환",
    (req, reply) => {
      const body = req.body;
      const cookie = body.code
        ? browserSessions.exchange(req.headers.host, body.code)
        : (requireThat(
            bearerValid(req.headers.authorization),
            "UNAUTHORIZED",
            "공부방 열기를 실행해 주세요.",
            401,
          ),
          browserSessions.connect(req.headers.host));
      reply.header("Set-Cookie", cookie);
      return { connected: true };
    },
    z
      .object({
        code: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
  );
  route("GET", "/api/browser/session", "브라우저 연결 확인", () => ({
    connected: true,
  }));
  route(
    "POST",
    "/api/browser/logout",
    "이 브라우저 연결 해제",
    (req, reply) => {
      reply.header(
        "Set-Cookie",
        browserSessions.disconnect(req.headers.host, req.headers.cookie),
      );
      return { connected: false };
    },
  );
  route("GET", "/api/settings", "백엔드 지원 기능", () => ({
    timezoneDefault: "Asia/Seoul",
    defaultQuestionCount: 25,
    formats: ["text/plain", "text/html", "application/pdf"],
    ocr: true,
    codeExecution: pythonRuntime().available,
    frontend,
    fsrsVersion: "5.4.2",
  }));
  if (frontend)
    await app.register(fastifyStatic, {
      root: options.webDir!,
      index: "index.html",
      setHeaders(res, path) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (path.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          );
        }
      },
    });
  let ticker: NodeJS.Timeout | undefined;
  if (options.autoWorker !== false) {
    jobs.kick();
    ticker = setInterval(() => {
      for (const attemptId of learning.expire()) {
        if (learning.result(attemptId).pending)
          jobs.enqueue("grade_attempt", { attemptId }, "grade:" + attemptId);
      }
      jobs.kick();
    }, 1000);
    ticker.unref();
  }
  app.addHook("preClose", async () => {
    for (const close of [...streamClients]) close();
  });
  app.addHook("onClose", async () => {
    if (ticker) clearInterval(ticker);
    await jobs.close();
    await agent.close();
    store.close();
    release();
  });
  return {
    app,
    store,
    catalog,
    sources,
    exams,
    learning,
    jobs,
    agent,
    token,
    browserSessions,
  };
}
