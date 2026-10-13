import { useEffect, useState } from "react";
import {
  Plus,
  Play,
  Sparkles,
  ArrowLeft,
  ArrowRight,
  Flag,
  Clock3,
  Check,
  Pause,
  Send,
  ClipboardList,
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
  Modal,
  Notice,
  Select,
  SubmitForm,
} from "./ui";
import {
  date,
  label,
  type Goal,
  type Template,
  type Exam,
  type Attempt,
  type Result,
  type ResultItem,
} from "./types";
import { QuestionBody, AssetLink } from "./library";
import { useAnswers } from "./answers";
export function ExamsPage({ goal }: { goal: Goal }) {
  const exams = useQuery<Exam[]>(`/exams?goalId=${goal.id}`, 10000),
    history = useQuery<Attempt[]>(`/attempts?goalId=${goal.id}`, 10000);
  const [create, setCreate] = useState(location.hash.includes("new=1"));
  return (
    <>
      <Heading
        eyebrow="PRACTICE & HISTORY"
        title="시험과 기록"
        description="한 회차를 끝내고, 무엇을 알게 됐는지 확인해 보세요."
        action={
          <Button disabled={!goal.scope} onClick={() => setCreate(true)}>
            <Plus size={16} /> 새 시험
          </Button>
        }
      />
      {!goal.scope && (
        <Notice tone="info">내 목표에서 학습 범위를 먼저 저장해 주세요.</Notice>
      )}
      {exams.error && <Notice>{exams.error}</Notice>}
      <div className="section-heading">
        <h2>준비된 시험</h2>
        <span className="muted small">기본 20–30문항 · 구성 변경 가능</span>
      </div>
      {exams.loading ? (
        <Loading />
      ) : exams.data?.length ? (
        <div className="source-grid">
          {exams.data.map((e) => (
            <section className="panel exam-card" key={e.id}>
              <div className="row between">
                <span className="source-icon">
                  <ClipboardList size={23} />
                </span>
                <Badge value={e.status} />
              </div>
              <h3>{e.template.name}</h3>
              <p className="muted">
                {label(e.template.mode)} · {e.template.total}문항 ·{" "}
                {e.template.minutes
                  ? `${e.template.minutes}분`
                  : "시간 제한 없음"}
              </p>
              <div className="progress-track">
                <i
                  style={{
                    width: `${(e.items.length / e.template.total) * 100}%`,
                  }}
                />
              </div>
              <p className="small muted">
                {e.items.length} / {e.template.total}문항 준비됨
              </p>
              <div className="row wrap">
                {e.status === "ready" ? (
                  <Action
                    run={() => api(`/exams/${e.id}/attempts`, "POST", {})}
                    onDone={(a) => go("/attempt/" + a.id)}
                  >
                    <Play size={16} /> 시험 시작
                  </Action>
                ) : (
                  <>
                    <Action
                      run={() => api(`/exams/${e.id}/prepare`, "POST", {})}
                      onDone={() => go("/jobs")}
                    >
                      <Sparkles size={16} /> 문항 준비
                    </Action>
                    {e.items.length === e.template.total && (
                      <Action
                        variant="secondary"
                        run={() => api(`/exams/${e.id}/finalize`, "POST", {})}
                        onDone={exams.reload}
                      >
                        시험 확정
                      </Action>
                    )}
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty
          title="첫 시험을 준비해 볼까요?"
          description="문제은행에서 먼저 채우고, 부족한 문항은 에이전트 작업으로 준비해요."
          action={
            <Button disabled={!goal.scope} onClick={() => setCreate(true)}>
              시험 구성하기
            </Button>
          }
        />
      )}
      <section className="panel spaced">
        <div className="section-heading">
          <h2>학습 기록</h2>
        </div>
        {history.error && <Notice>{history.error}</Notice>}
        {history.data?.length ? (
          history.data.map((a) => (
            <button
              className="history-row"
              key={a.id}
              onClick={() =>
                go((a.status === "submitted" ? "/result/" : "/attempt/") + a.id)
              }
            >
              <span className="source-icon">
                <ClipboardList size={18} />
              </span>
              <div>
                <strong>{a.exam.template.name}</strong>
                <small>
                  {date(a.startedAt)} · {a.exam.template.total}문항
                </small>
              </div>
              <Badge value={a.status} />
              <ArrowRight size={16} />
            </button>
          ))
        ) : (
          <p className="muted">시험을 시작하면 기록이 여기에 쌓여요.</p>
        )}
      </section>
      {create && (
        <CreateExam
          goal={goal}
          onClose={() => setCreate(false)}
          onDone={() => {
            setCreate(false);
            exams.reload();
          }}
        />
      )}
    </>
  );
}
function CreateExam({
  goal,
  onClose,
  onDone,
}: {
  goal: Goal;
  onClose: () => void;
  onDone: () => void;
}) {
  const q = useQuery<Template[]>("/exam-templates");
  const [template, setTemplate] = useState(""),
    [total, setTotal] = useState(25),
    [single, setSingle] = useState(20),
    [multiple, setMultiple] = useState(0),
    [mode, setMode] = useState(
      location.hash.includes("review=1") ? "review" : "practice",
    );
  return (
    <Modal title="새 시험 구성" onClose={onClose} wide>
      <SubmitForm
        submit="시험 만들기"
        onSubmit={async (f) => {
          let templateId = template;
          if (!templateId) {
            const t = await api("/exam-templates", "POST", {
              name: f.get("name"),
              total,
              single,
              multiple,
              short: total - single - multiple,
              mode,
              policy: f.get("policy"),
              minutes: f.get("minutes") ? Number(f.get("minutes")) : null,
              difficulty: f.get("difficulty"),
              shuffleChoices: true,
            });
            templateId = t.id;
          }
          const e = await api<Exam>("/exams", "POST", {
            goalId: goal.id,
            templateId,
          });
          if (e.items.length === e.template.total)
            await api(`/exams/${e.id}/finalize`, "POST", {});
          return e;
        }}
        onDone={onDone}
      >
        <Field label="저장된 구성">
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="">새 구성 만들기</option>
            {q.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.total}문항
              </option>
            ))}
          </select>
        </Field>
        {!template && (
          <>
            <Field label="시험 이름">
              <input name="name" required defaultValue={goal.title + " 연습"} />
            </Field>
            <Field label="학습 방식">
              <Select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                options={["practice", "weakness", "review", "mock"]}
              />
            </Field>
            <div className="segmented">
              {[20, 25, 30].map((n) => (
                <button
                  type="button"
                  key={n}
                  className={total === n ? "selected" : ""}
                  onClick={() => {
                    setTotal(n);
                    setSingle(n - 5);
                    setMultiple(0);
                  }}
                >
                  {n}문항
                </button>
              ))}
            </div>
            <div className="form-grid thirds">
              <Field label="전체 문항">
                <input
                  type="number"
                  value={total}
                  min={1}
                  max={500}
                  onChange={(e) => setTotal(Number(e.target.value))}
                />
              </Field>
              <Field label="단일 선택">
                <input
                  type="number"
                  min={0}
                  max={total}
                  value={single}
                  onChange={(e) => setSingle(Number(e.target.value))}
                />
              </Field>
              <Field label="복수 선택">
                <input
                  type="number"
                  min={0}
                  max={total - single}
                  value={multiple}
                  onChange={(e) => setMultiple(Number(e.target.value))}
                />
              </Field>
            </div>
            <p className="small muted">
              주관식 {Math.max(0, total - single - multiple)}문항 · 합계가 전체
              문항 수와 일치해야 해요.
            </p>
            <div className="form-grid">
              <Field label="문제 출처">
                <Select
                  name="policy"
                  defaultValue="mixed"
                  options={["mixed", "official_first", "past_only", "ai_only"]}
                />
              </Field>
              <Field label="난이도">
                <Select
                  name="difficulty"
                  defaultValue="any"
                  options={["any", "easy", "medium", "hard"]}
                />
              </Field>
            </div>
            <Field label="제한 시간 (분, 선택)">
              <input
                name="minutes"
                type="number"
                min={1}
                max={1440}
                required={mode === "mock"}
                placeholder="비우면 시간 제한 없음"
              />
            </Field>
            {mode === "mock" && (
              <Notice tone="info">
                실전 모의시험은 학습 범위에 저장된 공식 문항 수·시간과 일치해야
                합니다.
              </Notice>
            )}
          </>
        )}
        <Notice tone="info">
          이 구성은 재사용할 수 있어요. 부족한 문항은 시험을 만든 뒤 ‘문항
          준비’를 눌러 요청하세요.
        </Notice>
      </SubmitForm>
    </Modal>
  );
}
export function AttemptPage({ id }: { id: string }) {
  const q = useQuery<Attempt>(`/attempts/${id}`);
  if (q.loading) return <Loading />;
  if (q.error) return <Notice>{q.error}</Notice>;
  if (!q.data) return null;
  return <ExamRunner key={id} initial={q.data} />;
}
function ExamRunner({ initial }: { initial: Attempt }) {
  const [attempt, setAttempt] = useState(initial),
    [index, setIndex] = useState(0),
    [confirm, setConfirm] = useState(false),
    [tick, setTick] = useState(Date.now()),
    [pollError, setPollError] = useState("");
  const answers = useAnswers(initial);
  useEffect(() => {
    let live = true;
    const poll = setInterval(
      () =>
        api<Attempt>(`/attempts/${initial.id}`)
          .then((a) => {
            if (live) {
              setAttempt(a);
              setPollError("");
            }
          })
          .catch(() => {
            if (live)
              setPollError(
                "서버 연결을 확인하고 있어요. 답안은 이 탭에 임시 보관됩니다.",
              );
          }),
      5000,
    );
    const clock = setInterval(() => setTick(Date.now()), 1000);
    return () => {
      live = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [initial.id]);
  if (attempt.status === "submitted") return <ResultsPage id={attempt.id} />;
  const item = attempt.exam.items[index],
    draft = answers.drafts[item.slot];
  const remaining = attempt.deadline
    ? Math.max(0, new Date(attempt.deadline).getTime() - tick)
    : attempt.remainingMs;
  const answered = Object.values(answers.drafts).filter((d) =>
    Array.isArray(d.value) ? d.value.length : String(d.value).trim(),
  ).length;
  const blocked = attempt.status !== "active";
  return (
    <>
      <Heading
        eyebrow="FOCUS SESSION"
        title={attempt.exam.template.name}
        description={`${label(attempt.exam.template.mode)} · 한 문제씩 차분하게 풀어 보세요.`}
        action={
          <span className="exam-timer">
            <Clock3 size={18} />
            {remaining === null
              ? "시간 제한 없음"
              : `${Math.floor(remaining / 60000)}:${String(Math.floor(remaining / 1000) % 60).padStart(2, "0")}`}
          </span>
        }
      />
      {pollError && <Notice>{pollError}</Notice>}
      {blocked && (
        <Notice tone="info">
          시험이 일시정지되어 있어요.{" "}
          <Action
            run={() => api(`/attempts/${attempt.id}/resume`, "POST", {})}
            onDone={setAttempt}
          >
            이어서 풀기
          </Action>
        </Notice>
      )}
      <div className="exam-layout">
        <section className="panel question-panel">
          <div className="question-heading">
            <span>
              QUESTION <b>{String(index + 1).padStart(2, "0")}</b>{" "}
              <small>/ {attempt.exam.items.length}</small>
            </span>
            <Button
              variant={draft?.flagged ? "selected secondary" : "ghost"}
              disabled={blocked}
              onClick={() =>
                answers.change(item.slot, { flagged: !draft?.flagged })
              }
            >
              <Flag size={16} />
              {draft?.flagged ? "다시 볼 문제" : "다시 보기 표시"}
            </Button>
          </div>
          <div className="row wrap">
            <Badge value={item.type} />
            <Badge value={item.origin} />
            <span className="muted small">{item.points}점</span>
          </div>
          {item.passage && (
            <div className="passage pre-wrap">{item.passage}</div>
          )}
          <h2 className="question-stem pre-wrap">{item.stem}</h2>
          {item.requiredAssetIds?.map((id) => (
            <AssetLink key={id} id={id} />
          ))}
          <fieldset className="options-fieldset" disabled={blocked}>
            <legend className="sr-only">답안 선택</legend>
            {item.type === "short" ? (
              <textarea
                aria-label="주관식 답안"
                value={typeof draft?.value === "string" ? draft.value : ""}
                rows={7}
                placeholder="생각한 답을 적어 주세요."
                onChange={(e) =>
                  answers.change(item.slot, { value: e.target.value })
                }
              />
            ) : (
              item.choices.map((c, i) => {
                const selected =
                  Array.isArray(draft?.value) && draft.value.includes(c.id);
                return (
                  <label
                    className={`option ${selected ? "chosen" : ""}`}
                    key={c.id}
                  >
                    <input
                      type={item.type === "multiple" ? "checkbox" : "radio"}
                      name={"q" + item.slot}
                      checked={selected}
                      onChange={() =>
                        answers.change(item.slot, {
                          value:
                            item.type === "single"
                              ? [c.id]
                              : selected
                                ? (draft!.value as string[]).filter(
                                    (x) => x !== c.id,
                                  )
                                : [
                                    ...(Array.isArray(draft?.value)
                                      ? draft.value
                                      : []),
                                    c.id,
                                  ],
                        })
                      }
                    />
                    <span className="option-letter">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span>{c.text}</span>
                    {selected && <Check size={18} />}
                  </label>
                );
              })
            )}
          </fieldset>
          <div className="row wrap spaced">
            <label className="check-label">
              <input
                type="checkbox"
                disabled={blocked}
                checked={draft?.uncertain ?? false}
                onChange={(e) =>
                  answers.change(item.slot, { uncertain: e.target.checked })
                }
              />{" "}
              답이 헷갈려요
            </label>
            <select
              aria-label="기억 난이도"
              disabled={blocked}
              value={draft?.recall ?? ""}
              onChange={(e) =>
                answers.change(item.slot, {
                  recall: (e.target.value as "hard" | "good" | "easy") || null,
                })
              }
            >
              <option value="">기억 난이도 (선택)</option>
              <option value="hard">어렵게 떠올렸어요</option>
              <option value="good">생각해서 풀었어요</option>
              <option value="easy">쉽게 떠올렸어요</option>
            </select>
          </div>
          {draft?.conflict ? (
            <Notice>
              <p>
                다른 탭에서 이 답안이 수정되었어요. 사용할 답안을 선택해 주세요.
              </p>
              <p>
                서버 답안:{" "}
                {Array.isArray(draft.conflict.value)
                  ? draft.conflict.value
                      .map(
                        (id) =>
                          item.choices.find((c) => c.id === id)?.text ?? id,
                      )
                      .join(", ")
                  : draft.conflict.value || "비어 있음"}
              </p>
              <div className="row wrap">
                <Button
                  variant="secondary"
                  onClick={() => answers.resolve(item.slot, false)}
                >
                  서버 답안 사용
                </Button>
                <Button onClick={() => answers.resolve(item.slot, true)}>
                  내 답안으로 저장
                </Button>
              </div>
            </Notice>
          ) : (
            draft?.error && (
              <Notice>
                {draft.error}
                <Action variant="secondary" run={answers.retry}>
                  저장 다시 시도
                </Action>
              </Notice>
            )
          )}
          <div className="question-footer">
            <Button
              variant="secondary"
              disabled={index === 0}
              onClick={() => setIndex((i) => i - 1)}
            >
              <ArrowLeft size={16} /> 이전 문제
            </Button>
            <span className="small muted" role="status">
              {answers.dirty ? "답안 저장 중…" : "답안 저장됨"}
            </span>
            <Button
              variant="secondary"
              disabled={index === attempt.exam.items.length - 1}
              onClick={() => setIndex((i) => i + 1)}
            >
              다음 문제 <ArrowRight size={16} />
            </Button>
          </div>
        </section>
        <aside className="panel exam-map">
          <h3>문항 한눈에 보기</h3>
          <div className="row between small">
            <span className="muted">답변한 문제</span>
            <strong>
              {answered} / {attempt.exam.items.length}
            </strong>
          </div>
          <div className="progress-track">
            <i
              style={{
                width: `${(answered / attempt.exam.items.length) * 100}%`,
              }}
            />
          </div>
          <div className="question-grid">
            {attempt.exam.items.map((q, i) => {
              const d = answers.drafts[q.slot],
                done = Array.isArray(d?.value)
                  ? d.value.length
                  : !!d?.value?.trim();
              return (
                <button
                  key={q.slot}
                  aria-label={`${i + 1}번 문제${done ? ", 답변함" : ""}${d?.flagged ? ", 다시 보기" : ""}`}
                  className={`${done ? "answered" : ""} ${i === index ? "current" : ""} ${d?.flagged ? "flagged" : ""}`}
                  onClick={() => setIndex(i)}
                >
                  {i + 1}
                  {d?.flagged && <i />}
                </button>
              );
            })}
          </div>
          <div className="map-legend">
            <span>
              <i /> 미응답
            </span>
            <span>
              <i className="done" /> 답변함
            </span>
            <span>
              <i className="flag" /> 다시 보기
            </span>
          </div>
          <hr />
          {attempt.exam.template.mode !== "mock" && (
            <Action
              variant="secondary"
              disabled={blocked}
              run={async () => {
                await answers.flush();
                return api(`/attempts/${attempt.id}/pause`, "POST", {});
              }}
              onDone={() => go("/exams")}
            >
              <Pause size={16} /> 저장하고 나가기
            </Action>
          )}
          <Button
            className="full"
            disabled={blocked}
            onClick={() => setConfirm(true)}
          >
            <Send size={16} /> 답안 제출
          </Button>
          <p className="small muted">제출한 뒤 정답과 해설을 볼 수 있어요.</p>
        </aside>
      </div>
      {confirm && (
        <Modal title="시험을 제출할까요?" onClose={() => setConfirm(false)}>
          <div className="modal-body">
            <p>
              {answered}문항에 답했어요.{" "}
              {attempt.exam.items.length - answered > 0
                ? `아직 ${attempt.exam.items.length - answered}문항이 비어 있어요.`
                : "모든 문항에 답했어요."}
            </p>
            <p className="muted">
              제출 후 객관식은 바로 채점하고, 주관식은 에이전트 채점 작업으로
              이어져요.
            </p>
            <Action
              run={async () => {
                await answers.flush();
                const key = "study-cafe-submit:" + attempt.id;
                const requestId =
                  sessionStorage.getItem(key) ?? crypto.randomUUID();
                sessionStorage.setItem(key, requestId);
                await api(`/attempts/${attempt.id}/submit`, "POST", {
                  requestId,
                });
                sessionStorage.removeItem("study-cafe-drafts:" + attempt.id);
              }}
              onDone={() => go("/result/" + attempt.id)}
            >
              제출하고 결과 보기
            </Action>
          </div>
        </Modal>
      )}
    </>
  );
}
export function ResultsPage({ id }: { id: string }) {
  const q = useQuery<Result>(`/attempts/${id}/result`, 10000);
  const [filter, setFilter] = useState("all"),
    [manual, setManual] = useState<ResultItem | null>(null);
  if (q.loading) return <Loading />;
  if (q.error) return <Notice>{q.error}</Notice>;
  const r = q.data;
  if (!r) return null;
  const items = r.items.filter(
    (i) =>
      filter === "all" ||
      (filter === "pending"
        ? i.assessment.status === "pending"
        : i.assessment.status === "confirmed" && !i.assessment.passed),
  );
  return (
    <>
      <Heading
        eyebrow="SESSION COMPLETE"
        title="오늘의 학습 결과"
        description="점수보다 중요한 건, 다음에 더 잘 이해하는 거예요."
        action={
          <Button variant="secondary" onClick={() => go("/exams")}>
            시험과 기록
          </Button>
        }
      />
      <div className="result-summary panel">
        <div>
          <span className="muted">
            {r.pending ? "확정된 문항 점수" : "최종 점수"}
          </span>
          <strong>
            {r.earned}
            <small>
              {" "}
              / {r.pending ? r.confirmedPossible : r.totalPossible}
            </small>
          </strong>
          <Badge value={r.pending ? "pending" : "confirmed"} />
        </div>
        <div>
          <h2>
            {r.pending
              ? `${r.pending}문항의 채점을 기다리고 있어요.`
              : "한 회차를 완주했어요."}
          </h2>
          <p className="muted">
            {r.pending
              ? "보류 중인 점수는 0점으로 계산하지 않아요. 채점이 끝나면 결과에 반영됩니다."
              : "틀린 문제를 정리하고, 다음 복습에서 다시 만나 보세요."}
          </p>
          <div className="row wrap">
            {r.pending > 0 && (
              <Action
                variant="secondary"
                run={() => api(`/attempts/${id}/grade`, "POST", {})}
                onDone={() => go("/jobs")}
              >
                주관식 채점 요청
              </Action>
            )}
            <Action
              run={() => api(`/goals/${r.goalId}/summarize`, "POST", {})}
              onDone={() => go("/jobs")}
            >
              <Sparkles size={16} /> 오답 요약 만들기
            </Action>
            <Button
              variant="secondary"
              onClick={() => go("/notes?goalId=" + r.goalId)}
            >
              오답 노트
            </Button>
          </div>
        </div>
      </div>
      <div className="segmented narrow spaced">
        {[
          ["all", "전체 문항"],
          ["wrong", "틀린 문항"],
          ["pending", "채점 보류"],
        ].map(([v, t]) => (
          <button
            key={v}
            className={filter === v ? "selected" : ""}
            onClick={() => setFilter(v)}
          >
            {t}
          </button>
        ))}
      </div>
      {items.length ? (
        items.map((item) => (
          <section className="panel result-question" key={item.slot}>
            <div className="section-heading">
              <h3>문항 {item.slot}</h3>
              <Badge
                value={
                  item.assessment.status === "pending"
                    ? "pending"
                    : item.assessment.passed
                      ? "usable"
                      : "needs_review"
                }
              >
                {item.assessment.status === "pending"
                  ? "채점 보류"
                  : `${item.assessment.passed ? "정답" : "복습 필요"} · ${item.assessment.score} / ${item.points}점`}
              </Badge>
            </div>
            <QuestionBody q={item} answer />
            <div className="given-answer">
              <strong>내 답안</strong>
              <p className="pre-wrap">
                {Array.isArray(item.answerGiven?.value)
                  ? item
                      .answerGiven!.value.map(
                        (id) =>
                          item.choices.find((c) => c.id === id)?.text ?? id,
                      )
                      .join(", ") || "미응답"
                  : item.answerGiven?.value || "미응답"}
              </p>
            </div>
            <p className="muted pre-wrap">
              {item.assessment.explanation || item.assessment.reason}
            </p>
            <div className="row wrap">
              <Button variant="secondary" onClick={() => setManual(item)}>
                채점 직접 검토
              </Button>
              <Action
                variant="ghost"
                run={() => api(`/questions/${item.id}/variant`, "POST", {})}
                onDone={() => go("/jobs")}
              >
                변형 문제 만들기 <Sparkles size={15} />
              </Action>
            </div>
          </section>
        ))
      ) : (
        <Empty title="해당하는 문항이 없어요" />
      )}
      {manual && (
        <Modal title="채점 직접 검토" onClose={() => setManual(null)}>
          <SubmitForm
            onSubmit={(f) =>
              api(`/attempts/${id}/assessments/${manual.slot}`, "POST", {
                score: Number(f.get("score")),
                passed: f.get("passed") === "true",
                status: "confirmed",
                reason: f.get("reason"),
                explanation: f.get("explanation"),
                expectedVersion: manual.assessment.version,
              })
            }
            onDone={() => {
              setManual(null);
              q.reload();
            }}
          >
            <Field label={`점수 (0–${manual.points})`}>
              <input
                name="score"
                type="number"
                min={0}
                max={manual.points}
                step="0.1"
                required
                defaultValue={manual.assessment.score ?? 0}
              />
            </Field>
            <Field label="개념 이해 여부">
              <select
                name="passed"
                defaultValue={String(manual.assessment.passed)}
              >
                <option value="true">이해했어요</option>
                <option value="false">복습이 필요해요</option>
              </select>
            </Field>
            <Field label="검토 사유">
              <textarea name="reason" required rows={2} />
            </Field>
            <Field label="해설">
              <textarea
                name="explanation"
                rows={3}
                defaultValue={manual.assessment.explanation}
              />
            </Field>
          </SubmitForm>
        </Modal>
      )}
    </>
  );
}
