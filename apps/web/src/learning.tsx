import { useState } from "react";
import { StudyText } from "./study-content";
import { NoteSummary } from "./note-summary";
import {
  NotebookPen,
  RotateCcw,
  Sparkles,
  ArrowRight,
  CalendarDays,
  Workflow,
  CheckCircle2,
  Settings,
  ShieldCheck,
  Database,
  ExternalLink,
} from "lucide-react";
import { api, go, useQuery } from "./api";
import {
  Action,
  Badge,
  Button,
  Empty,
  Field,
  Heading,
  Loading,
  Notice,
  SubmitForm,
} from "./ui";
import { date, label, type Goal, type ResultItem, type Job } from "./types";
import { QuestionBody, safeUrl } from "./library";
import { ScopeEditor } from "./goals";
export function NotesPage({ goal }: { goal: Goal }) {
  const wrong = useQuery<ResultItem[]>(`/goals/${goal.id}/wrong`, 10000),
    notes = useQuery<any[]>(`/goals/${goal.id}/notes`, 10000);
  const [selected, setSelected] = useState(0),
    [tab, setTab] = useState("wrong");
  const current = wrong.data?.[selected];
  return (
    <>
      <Heading
        eyebrow="LEARN FROM MISTAKES"
        title="오답 노트"
        description="틀린 이유를 이해하면, 다음 문제는 달라질 수 있어요."
        action={
          <Action
            run={() => api(`/goals/${goal.id}/summarize`, "POST", {})}
            onDone={() => go("/jobs")}
          >
            <Sparkles size={16} /> 개념 요약 만들기
          </Action>
        }
      />
      <div className="segmented narrow">
        <button
          className={tab === "wrong" ? "selected" : ""}
          onClick={() => setTab("wrong")}
        >
          틀린 문제 · {wrong.data?.length ?? 0}
        </button>
        <button
          className={tab === "summary" ? "selected" : ""}
          onClick={() => setTab("summary")}
        >
          개념 요약 · {notes.data?.length ?? 0}
        </button>
      </div>
      {wrong.error && <Notice>{wrong.error}</Notice>}
      {tab === "wrong" ? (
        wrong.loading ? (
          <Loading />
        ) : wrong.data?.length ? (
          <div className="notes-layout panel">
            <aside className="notes-list">
              <div className="notes-list-title">
                <NotebookPen size={18} />
                <strong>다시 살펴볼 문제</strong>
              </div>
              {wrong.data.map((q, i) => (
                <button
                  key={q.attemptId + ":" + q.slot}
                  className={selected === i ? "selected" : ""}
                  onClick={() => setSelected(i)}
                >
                  <span className="muted small">
                    {q.conceptIds
                      .map(
                        (id) =>
                          goal.scope?.concepts.find((c) => c.id === id)?.name ??
                          "이전 범위",
                      )
                      .join(" · ")}
                  </span>
                  <strong>{q.stem}</strong>
                  <div className="row wrap">
                    <Badge value={q.type} />
                    <small>
                      {q.assessment.passed ? "헷갈린 문제" : "복습 필요"}
                    </small>
                  </div>
                </button>
              ))}
            </aside>
            <article className="note-detail">
              {current && (
                <>
                  <QuestionBody q={current} answer />
                  <div className="given-answer">
                    <strong>채점 피드백</strong>
                    <StudyText
                      text={
                        current.assessment.explanation ||
                        current.assessment.reason ||
                        "기록된 피드백이 없습니다."
                      }
                    />
                  </div>
                  <div className="row wrap spaced">
                    <Button
                      variant="secondary"
                      onClick={() => go("/result/" + current.attemptId)}
                    >
                      전체 결과
                    </Button>
                    <Action
                      run={() =>
                        api(`/questions/${current.id}/variant`, "POST", {})
                      }
                      onDone={() => go("/jobs")}
                    >
                      <Sparkles size={16} /> 변형 문제 만들기
                    </Action>
                  </div>
                </>
              )}
            </article>
          </div>
        ) : (
          <Empty
            title="아직 쌓인 오답이 없어요"
            description="시험을 풀면 틀리거나 헷갈린 문제를 여기에 모아 드려요."
            action={
              <Button onClick={() => go("/exams")}>
                시험 보러 가기 <ArrowRight size={16} />
              </Button>
            }
          />
        )
      ) : notes.loading ? (
        <Loading />
      ) : notes.error ? (
        <Notice>{notes.error}</Notice>
      ) : notes.data?.length ? (
        notes.data.map((n) => (
          <section className="panel spaced" key={n.id}>
            <div className="section-heading">
              <h2>개념 다시 보기</h2>
              <span className="muted small">{date(n.createdAt)}</span>
            </div>
            {n.concepts?.map((c: any) => (
              <div className="summary-concept" key={c.conceptId}>
                <h3>
                  {goal.scope?.concepts.find((x) => x.id === c.conceptId)
                    ?.name ?? "이전 범위의 개념"}
                </h3>
                <NoteSummary concept={c} goalId={goal.id} />
              </div>
            ))}
          </section>
        ))
      ) : (
        <Empty
          title="개념 요약을 만들어 보세요"
          description="오답 기록을 바탕으로 에이전트가 핵심 개념과 예시를 정리합니다."
        />
      )}
    </>
  );
}
export function ReviewsPage({ goal }: { goal: Goal }) {
  const q = useQuery<any[]>(`/goals/${goal.id}/reviews`, 10000),
    bank = useQuery<{ items: any[] }>(`/questions?goalId=${goal.id}&limit=200`);
  const [filter, setFilter] = useState("all");
  const due = q.data?.filter((r) => r.overdue) ?? [],
    list = q.data?.filter((r) => filter === "all" || r.overdue) ?? [];
  return (
    <>
      <Heading
        eyebrow="SPACED REPETITION"
        title="복습 일정"
        description="기억이 흐려질 때쯤, 같은 개념을 다시 만나세요."
        action={
          <Button
            disabled={!due.length}
            onClick={() => go("/exams?new=1&review=1")}
          >
            <RotateCcw size={16} /> 복습 시험 만들기
          </Button>
        }
      />
      <section className="review-hero panel">
        <div className="source-icon">
          <CalendarDays size={27} />
        </div>
        <div>
          <p className="eyebrow">READY TO RECALL</p>
          <h2>
            오늘 다시 만날 문제 <span>{due.length}</span>
          </h2>
          <p className="muted">
            풀이 결과와 기억 난이도에 따라 다음 복습일이 조정돼요.
          </p>
        </div>
        <div className="review-total">
          <strong>{q.data?.length ?? 0}</strong>
          <span>전체 복습 항목</span>
        </div>
      </section>
      <div className="section-heading spaced">
        <h2>예정된 복습</h2>
        <div className="segmented narrow">
          <button
            className={filter === "all" ? "selected" : ""}
            onClick={() => setFilter("all")}
          >
            전체
          </button>
          <button
            className={filter === "due" ? "selected" : ""}
            onClick={() => setFilter("due")}
          >
            오늘까지
          </button>
        </div>
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading ? (
        <Loading />
      ) : list.length ? (
        <section className="panel">
          {list.map((r) => {
            const question = bank.data?.items.find(
              (x) => x.id === r.questionId,
            );
            return (
              <div className="review-row" key={r.questionId}>
                <div className={`date-tile ${r.overdue ? "due" : ""}`}>
                  <small>
                    {new Date(r.due).toLocaleDateString("ko-KR", {
                      month: "short",
                    })}
                  </small>
                  <strong>{new Date(r.due).getDate()}</strong>
                </div>
                <div>
                  <strong>{question?.stem ?? "복습 문제"}</strong>
                  <p className="muted small">
                    {question?.conceptIds
                      .map(
                        (id: string) =>
                          goal.scope?.concepts.find((c) => c.id === id)?.name,
                      )
                      .filter(Boolean)
                      .join(" · ") || "학습한 개념 다시 확인하기"}
                  </p>
                </div>
                <Badge value={r.overdue ? "needs_review" : "queued"}>
                  {r.overdue ? "복습할 차례" : "예정"}
                </Badge>
              </div>
            );
          })}
        </section>
      ) : (
        <Empty
          title="지금은 예정된 복습이 없어요"
          description="시험을 제출하면 학습 결과를 바탕으로 복습 일정이 생겨요."
          action={
            <Button variant="secondary" onClick={() => go("/exams")}>
              새로운 공부 시작하기
            </Button>
          }
        />
      )}
    </>
  );
}
export function JobsPage({ refresh }: { refresh: () => void }) {
  const q = useQuery<Job[]>("/jobs", 3000);
  const [id, setId] = useState(""),
    [filter, setFilter] = useState("all");
  const jobs =
    q.data?.filter((j) => filter === "all" || j.status === filter) ?? [];
  const selected = q.data?.find((j) => j.id === id) ?? jobs[0];
  return (
    <>
      <Heading
        eyebrow="YOUR STUDY PARTNER"
        title="에이전트 작업"
        description="자료 조사부터 오답 정리까지, 요청한 작업의 흐름을 확인하세요."
      />
      <div className="info-strip">
        <Workflow size={21} />
        <div>
          <strong>로컬 Codex와 함께 준비해요</strong>
          <span>
            실패하거나 확인이 필요한 작업은 내용을 확인한 뒤 다시 진행할 수
            있어요.
          </span>
        </div>
        <a href="#/settings" className="text-link">
          연결 설정 <ArrowRight size={15} />
        </a>
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      <div className="segmented narrow spaced">
        {[
          ["all", "전체"],
          ["running", "진행 중"],
          ["waiting_user", "확인 필요"],
          ["failed", "실패"],
        ].map(([v, t]) => (
          <button
            key={v}
            className={filter === v ? "selected" : ""}
            onClick={() => {
              setFilter(v);
              setId("");
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {q.loading ? (
        <Loading />
      ) : jobs.length ? (
        <div className="jobs-layout">
          <section className="panel job-list">
            {jobs.map((j) => (
              <button
                key={j.id}
                className={j.id === selected?.id ? "selected" : ""}
                onClick={() => setId(j.id)}
              >
                <span className="source-icon">
                  <Sparkles size={19} />
                </span>
                <div>
                  <strong>{label(j.kind)}</strong>
                  <small>{new Date(j.createdAt).toLocaleString("ko-KR")}</small>
                </div>
                <Badge value={j.status} />
              </button>
            ))}
          </section>
          {selected && (
            <JobDetail
              key={selected.id}
              job={selected}
              onChange={() => {
                q.reload();
                refresh();
              }}
            />
          )}
        </div>
      ) : (
        <Empty
          title="표시할 작업이 없어요"
          description="목표나 자료 화면에서 에이전트 작업을 요청할 수 있어요."
        />
      )}
    </>
  );
}
function JobDetail({ job: j, onChange }: { job: Job; onChange: () => void }) {
  const extractionResults =
    j.kind === "extract_questions" && j.result
      ? [j.result]
      : Array.isArray(j.result?.extracted)
        ? j.result.extracted
        : [];
  const events = useQuery<any[]>(`/jobs/${j.id}/events`, 3000);
  const goal = useQuery<Goal>(
    j.input.goalId ? `/goals/${j.input.goalId}` : null,
  );
  const [scope, setScope] = useState(false);
  return (
    <section className="panel job-detail">
      <div className="section-heading">
        <h2>{label(j.kind)}</h2>
        <Badge value={j.status} />
      </div>
      <p className="muted small">
        {goal.data?.title ?? "학습을 위한 준비 작업"}
      </p>
      <div className="row wrap spaced">
        {["queued", "running"].includes(j.status) && (
          <Action
            variant="secondary"
            run={() => api(`/jobs/${j.id}/pause`, "POST", {})}
            onDone={onChange}
          >
            일시정지
          </Action>
        )}
        {["paused", "failed", "waiting_user"].includes(j.status) && (
          <Action
            run={() => api(`/jobs/${j.id}/resume`, "POST", {})}
            onDone={onChange}
          >
            다시 진행
          </Action>
        )}
        {!["succeeded", "cancelled"].includes(j.status) && (
          <Action
            variant="ghost"
            run={() => api(`/jobs/${j.id}/cancel`, "POST", {})}
            onDone={onChange}
          >
            작업 취소
          </Action>
        )}
      </div>
      {j.error && (
        <Notice>
          <strong>{j.error.message}</strong>
          {j.error.details && (
            <p className="small">
              {typeof j.error.details === "string"
                ? j.error.details
                : (j.error.details.message ?? JSON.stringify(j.error.details))}
            </p>
          )}
        </Notice>
      )}
      {j.kind === "research" && Array.isArray(j.result?.outcomes) ? (
        <p className="pre-wrap">
          자료 {j.result.sources?.length ?? j.result.outcomes.length}개 발견 ·
          본문 수집{" "}
          {
            j.result.outcomes.filter((o: any) => o.status === "extracted")
              .length
          }
          개 · 링크만 보관{" "}
          {
            j.result.outcomes.filter((o: any) => o.status === "link_only")
              .length
          }
          개 · 수집 실패{" "}
          {j.result.outcomes.filter((o: any) => o.status === "blocked").length}
          개.
          {"\n"}실제로 수집된 본문을 기준으로 문제를 준비합니다. 참고 자료와
          실제 기출·연습문제는 구분해 보관합니다.
        </p>
      ) : j.result?.summary ? (
        <p className="pre-wrap">{j.result.summary}</p>
      ) : null}
      {j.result?.uncovered?.length > 0 && (
        <Notice tone="info">
          추가로 필요한 자료: {j.result.uncovered.join(", ")}
        </Notice>
      )}
      {extractionResults.map((result: any, index: number) => (
        <section className="excerpt" key={result.sourceId ?? index}>
          <h3>
            문항 추출 결과
            {extractionResults.length > 1 ? ` · 자료 ${index + 1}` : ""}
          </h3>
          <p>
            저장 {result.count ?? 0}개
            {typeof result.usable === "number"
              ? ` · 사용 가능 ${result.usable}개 · 검토 대기 ${result.needsReview}개`
              : ""}
          </p>
          {result.reason && <Notice>{result.reason}</Notice>}
          {!!result.unresolved?.length && (
            <>
              <strong>추가 확인이 필요한 항목</strong>
              <ul>
                {result.unresolved.map((issue: any, i: number) => (
                  <li key={i}>
                    {issue.reference}: {issue.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
      {j.result?.scope && goal.data && (
        <Button className="spaced" onClick={() => setScope(true)}>
          제안된 학습 범위 검토 <ArrowRight size={16} />
        </Button>
      )}
      {j.result?.questions?.length > 0 && goal.data && (
        <SubmitForm
          submit="답변으로 목표 다시 설계"
          onSubmit={(f) =>
            api(`/goals/${goal.data!.id}/plan`, "POST", {
              answers: Object.fromEntries(
                j.result.questions.map((question: string, i: number) => [
                  question,
                  String(f.get("answer" + i)),
                ]),
              ),
            })
          }
          onDone={onChange}
        >
          {j.result.questions.map((question: string, i: number) => (
            <Field label={question} key={i}>
              <input name={"answer" + i} required />
            </Field>
          ))}
        </SubmitForm>
      )}
      <h3 className="spaced">진행 기록</h3>
      {events.error && <Notice>{events.error}</Notice>}
      <ol className="timeline">
        {events.data?.map((e) => (
          <li key={e.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{eventText(e.data)}</strong>
              <small>{new Date(e.createdAt).toLocaleTimeString("ko-KR")}</small>
            </div>
          </li>
        ))}
      </ol>
      <details className="spaced">
        <summary>작업 상세 데이터</summary>
        <pre className="debug-data">
          {JSON.stringify({ input: j.input, result: j.result }, null, 2)}
        </pre>
      </details>
      {scope && goal.data && (
        <ScopeEditor
          goal={goal.data}
          initial={j.result.scope}
          onClose={() => setScope(false)}
          onSaved={() => {
            setScope(false);
            onChange();
          }}
        />
      )}
    </section>
  );
}
function eventText(e: any) {
  if (e.type === "materials_selected")
    return `${e.slot}번 문항 · 근거 후보 ${e.segmentIds?.length ?? 0}개 선택${e.method === "bounded_fallback" ? " (용어 일치 없음 · 검토 필요)" : ""}`;
  if (e.error?.message) return e.error.message;
  if (e.step)
    return `${e.step} · ${e.status === "completed" ? "완료" : e.status === "started" ? "시작" : label(e.status ?? "running")}`;
  if (e.status) return label(e.status);
  if (e.message) return String(e.message);
  return e.type ? String(e.type) : "작업 진행 중";
}
export function SettingsPage() {
  const config = useQuery<any>("/settings"),
    backups = useQuery<any[]>("/backups");
  const [agent, setAgent] = useState<any>(null),
    [login, setLogin] = useState<any>(null),
    [verified, setVerified] = useState("");
  return (
    <>
      <Heading
        eyebrow="PREFERENCES"
        title="설정"
        description="로컬 연결과 학습 기록을 관리하세요."
      />
      <div className="settings-grid">
        <section className="panel">
          <div className="section-heading">
            <h2>
              <Sparkles size={20} /> Codex 연결
            </h2>
            {agent && (
              <Badge
                value={
                  agent.connected && agent.authenticated
                    ? "usable"
                    : "needs_review"
                }
              >
                {agent.connected && agent.authenticated
                  ? "로그인됨"
                  : "연결 확인 필요"}
              </Badge>
            )}
          </div>
          <p className="muted">
            컴퓨터에 설치된 Codex의 로그인 상태를 사용합니다.
          </p>
          <div className="row wrap">
            <Action
              variant="secondary"
              run={() => api("/agent/status")}
              onDone={setAgent}
            >
              연결 상태 확인
            </Action>
            <Action
              run={() => api("/agent/login", "POST", { type: "chatgpt" })}
              onDone={setLogin}
            >
              ChatGPT로 로그인
            </Action>
          </div>
          {agent?.error && (
            <Notice>
              {typeof agent.error === "string"
                ? agent.error
                : (agent.error.message ??
                  "Codex 실행 경로와 로그인 상태를 확인해 주세요.")}
            </Notice>
          )}
          {login && (
            <div className="spaced">
              <Notice tone="info">
                로그인 창에서 인증을 완료한 뒤 연결 상태를 다시 확인해 주세요.
              </Notice>
              {(login.authUrl || login.verificationUri) && (
                <a
                  className="button secondary"
                  href={safeUrl(login.authUrl || login.verificationUri)}
                  target="_blank"
                  rel="noreferrer"
                >
                  로그인 페이지 열기 <ExternalLink size={16} />
                </a>
              )}
              {login.userCode && (
                <p>
                  인증 코드: <code>{login.userCode}</code>
                </p>
              )}
            </div>
          )}
          <div className="setting-note">
            <ShieldCheck size={18} />
            <p>
              별도 API 키를 입력하지 않아요. Codex 계정의 이용 한도가
              적용됩니다.
            </p>
          </div>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <Settings size={20} /> 학습 기본값
            </h2>
          </div>
          {config.error && <Notice>{config.error}</Notice>}
          <dl className="settings-list">
            <div>
              <dt>기본 시험 분량</dt>
              <dd>{config.data?.defaultQuestionCount ?? 25}문항</dd>
            </div>
            <div>
              <dt>시간대</dt>
              <dd>{config.data?.timezoneDefault ?? "Asia/Seoul"}</dd>
            </div>
            <div>
              <dt>자료 형식</dt>
              <dd>텍스트 · 웹 문서 · PDF</dd>
            </div>
            <div>
              <dt>복습 일정</dt>
              <dd>FSRS {config.data?.fsrsVersion}</dd>
            </div>
          </dl>
          <p className="small muted">
            스캔 PDF의 OCR과 코드 실행 채점은 아직 지원하지 않아요. 첨부 음성은
            파일로 내려받아 확인할 수 있어요.
          </p>
        </section>
      </div>
      <section className="panel spaced">
        <div className="section-heading">
          <h2>
            <Database size={20} /> 학습 기록 백업
          </h2>
          <Action
            run={() => api("/backups", "POST", {})}
            onDone={backups.reload}
          >
            지금 백업하기
          </Action>
        </div>
        <p className="muted">
          데이터베이스와 첨부파일을 서버의 로컬 백업 폴더에 함께 보관합니다.
        </p>
        {backups.error && <Notice>{backups.error}</Notice>}
        {verified && (
          <Notice tone="info">
            <CheckCircle2 size={16} /> 백업 무결성 검증을 통과했어요.
          </Notice>
        )}
        {backups.data?.length ? (
          backups.data.map((b) => (
            <div className="list-row" key={b.id}>
              <Database size={18} />
              <div>
                <strong>{new Date(b.createdAt).toLocaleString("ko-KR")}</strong>
                <small>
                  첨부 {b.assets?.length ?? 0}개 · {b.id.slice(0, 8)}
                </small>
              </div>
              <Action
                variant="secondary"
                run={() => api(`/backups/${b.id}/verify`, "POST", {})}
                onDone={() => setVerified(b.id)}
              >
                백업 검증
              </Action>
            </div>
          ))
        ) : (
          <p className="muted small">아직 만든 백업이 없어요.</p>
        )}
      </section>
      <section className="panel spaced">
        <h3>디자인 참고</h3>
        <p className="muted small">
          무료 MIT 템플릿의 탐색·목록·노트 구성을 참고해 study-cafe에 맞게
          구현했어요.
        </p>
        <div className="row wrap">
          <a
            className="text-link"
            href="https://github.com/satnaing/shadcn-admin"
            target="_blank"
            rel="noreferrer"
          >
            Shadcn Admin <ExternalLink size={14} />
          </a>
          <a
            className="text-link"
            href="https://github.com/shadcndashboard/shadcndashboard"
            target="_blank"
            rel="noreferrer"
          >
            Shadcn Dashboard <ExternalLink size={14} />
          </a>
        </div>
      </section>
    </>
  );
}
