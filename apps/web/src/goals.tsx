import { useEffect, useState } from "react";
import {
  ChevronDown,
  MoreHorizontal,
  Archive,
  Target,
  BookOpen,
  ArrowUpRight,
  ArrowRight,
  Plus,
  Clock3,
  Layers3,
  RotateCcw,
  Play,
  CheckCircle2,
  FolderOpen,
  Sparkles,
} from "lucide-react";
import { api, go, useQuery } from "./api";
import {
  Badge,
  Button,
  Empty,
  Field,
  Heading,
  Loading,
  Modal,
  Select,
  SubmitForm,
  Action,
  Notice,
} from "./ui";
import {
  date,
  label,
  type Goal,
  type Home,
  type Concept,
  type ExamSection,
} from "./types";
import { SectionEditor } from "./section-editor";
import { GoalActions } from "./goal-actions";
export function Dashboard({
  goals,
  home,
  loading,
  select,
}: {
  goals: Goal[];
  home?: Home;
  loading: boolean;
  select: (id: string) => void;
}) {
  const active = goals.filter((g) => !g.archived),
    progress = home?.goals.flatMap((g) => g.progress) ?? [];
  const learned = progress.filter((c) => c.status !== "unseen").length;
  return (
    <>
      <Heading
        eyebrow={new Intl.DateTimeFormat("ko-KR", {
          timeZone: "Asia/Seoul",
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(new Date())}
        title="오늘도, 한 걸음 더."
        description="어제보다 조금 더 알게 되는 하루를 시작해 보세요."
        action={
          <Button onClick={() => go("/goals?new=1")}>
            <Plus size={17} /> 새 목표
          </Button>
        }
      />
      <section className="welcome-panel">
        <div>
          <span className="hero-kicker">
            <span className="online-dot" /> MY STUDY CAFE
          </span>
          <h2>
            {home?.continueAttempts.length
              ? "시작한 공부, 이어서 해볼까요?"
              : "어떤 목표를 향해 공부하고 있나요?"}
          </h2>
          <p>
            {home?.continueAttempts.length
              ? "저장된 답안에서 이어서 시작할 수 있어요."
              : "막연한 관심도 괜찮아요. 목표를 만들면 공부할 범위부터 차근차근 정리할 수 있어요."}
          </p>
          <Button
            onClick={() =>
              home?.continueAttempts[0]
                ? go("/attempt/" + home.continueAttempts[0].id)
                : go("/goals?new=1")
            }
          >
            {home?.continueAttempts.length ? "이어서 풀기" : "학습 목표 만들기"}
            <ArrowRight size={17} />
          </Button>
        </div>
        <div className="study-path">
          <div>
            <span>01</span>
            <Target />
            <strong>목표를 정하고</strong>
          </div>
          <i />
          <div>
            <span>02</span>
            <BookOpen />
            <strong>문제를 풀고</strong>
          </div>
          <i />
          <div>
            <span>03</span>
            <RotateCcw />
            <strong>다시 기억해요</strong>
          </div>
        </div>
      </section>
      <div className="stats-grid">
        {[
          [Target, "학습 중인 목표", active.length, "나의 관심이 모이는 곳"],
          [
            Layers3,
            "학습한 개념",
            learned,
            `전체 ${progress.length}개 개념 중`,
          ],
          [
            RotateCcw,
            "오늘 복습",
            home?.dueReviews ?? 0,
            "다시 만나야 할 문제",
          ],
          [
            Clock3,
            "진행 중인 작업",
            home?.jobs.filter((j) => ["queued", "running"].includes(j.status))
              .length ?? 0,
            "에이전트가 준비하고 있어요",
          ],
        ].map(([Icon, title, value, sub], i) => {
          const I = Icon as typeof Target;
          return (
            <div className="stat-card" key={i}>
              <div className="row between">
                <span>{String(title)}</span>
                <I size={18} />
              </div>
              <strong>
                {loading ? "—" : String(value)}
                <small>개</small>
              </strong>
              <p>{String(sub)}</p>
            </div>
          );
        })}
      </div>
      <div className="home-columns">
        <section>
          <div className="section-heading">
            <h2>
              나의 학습 목표 <span>{active.length}</span>
            </h2>
            <a href="#/goals">
              전체 보기 <ArrowUpRight size={15} />
            </a>
          </div>
          {!active.length ? (
            <Empty
              title="첫 번째 목표를 기다리고 있어요"
              description="관심 있는 주제, 익히고 싶은 능력, 준비할 시험을 목표로 만들어 보세요."
              action={
                <Button variant="secondary" onClick={() => go("/goals?new=1")}>
                  <Plus size={16} /> 목표 만들기
                </Button>
              }
            />
          ) : (
            <div className="goal-grid">
              {active.slice(0, 4).map((g, i) => (
                <GoalCard
                  key={g.id}
                  goal={g}
                  index={i}
                  progress={home?.goals.find((x) => x.id === g.id)?.progress}
                  onClick={() => {
                    select(g.id);
                    go("/goals");
                  }}
                />
              ))}
            </div>
          )}
        </section>
        <section className="panel next-study">
          <div className="section-heading">
            <h2>다음 학습</h2>
            <RotateCcw size={18} />
          </div>
          <p className="muted">기억이 흐려지기 전에 한 번 더.</p>
          <div className="review-count">
            <strong>{home?.dueReviews ?? 0}</strong>
            <span>오늘 복습할 문제</span>
          </div>
          <Button variant="secondary" onClick={() => go("/reviews")}>
            복습 일정 보기 <ArrowRight size={16} />
          </Button>
          <hr />
          <h3>이어 풀기</h3>
          {home?.continueAttempts.length ? (
            home.continueAttempts.slice(0, 3).map((a, i) => (
              <button
                key={a.id}
                className="continue-row"
                onClick={() => go("/attempt/" + a.id)}
              >
                <Play size={17} />
                <span>
                  진행 중인 시험 {i + 1}
                  <small>{label(a.status)} · 저장된 답안에서 시작</small>
                </span>
                <ArrowRight size={16} />
              </button>
            ))
          ) : (
            <p className="muted small">
              진행 중인 시험이 없어요.
              <br />
              목표에서 새 시험을 준비해 보세요.
            </p>
          )}
        </section>
      </div>
      {home?.jobs.length ? (
        <section className="panel">
          <div className="section-heading">
            <h2>에이전트 작업</h2>
            <a href="#/jobs">
              작업 보기 <ArrowUpRight size={15} />
            </a>
          </div>
          {home.jobs.slice(0, 3).map((j) => (
            <div className="list-row" key={j.id}>
              <Sparkles size={18} />
              <strong>{label(j.kind)}</strong>
              <Badge value={j.status} />
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
function GoalCard({
  goal: g,
  index,
  onClick,
  progress = [],
}: {
  goal: Goal;
  index: number;
  onClick: () => void;
  progress?: Concept[];
}) {
  const checked = progress.filter(
      (c) => c.status === "confirmed_multiple_times",
    ).length,
    total = g.scope?.concepts.length ?? 0;
  return (
    <button className="goal-card" onClick={onClick}>
      <div className="row between">
        <span className={`goal-icon color-${index % 4}`}>
          <BookOpen size={22} />
        </span>
        <Badge value={g.kind} />
      </div>
      <h3>{g.title}</h3>
      <p>{g.description || "작은 성취를 쌓아 목표에 가까워져요."}</p>
      <div className="row between small">
        <span>반복 확인한 개념</span>
        <strong>
          {checked} / {total}
        </strong>
      </div>
      <div className="progress-track">
        <i style={{ width: `${total ? (checked / total) * 100 : 0}%` }} />
      </div>
      <div className="goal-footer">
        <span>
          <Clock3 size={14} />
          {g.minutesPerDay ? `하루 ${g.minutesPerDay}분` : "내 속도대로"}
        </span>
        <span>
          {g.targetDate ? date(g.targetDate) : "목표 살펴보기"}{" "}
          <ArrowUpRight size={15} />
        </span>
      </div>
    </button>
  );
}
export function Goals({
  goals,
  goal,
  select,
  refresh,
}: {
  goals: Goal[];
  goal?: Goal;
  select: (id: string) => void;
  refresh: () => void;
}) {
  const [create, setCreate] = useState(location.hash.includes("new=1")),
    [edit, setEdit] = useState<Goal | null>(null),
    [scope, setScope] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(goal?.id ?? null);
  const [archived, setArchived] = useState(false);
  const [manage, setManage] = useState<Goal | null>(null);
  useEffect(() => {
    setExpanded(goal?.id ?? null);
  }, [goal?.id]);
  const visible = goals.filter((g) => g.archived === archived);
  const p = useQuery<Concept[]>(goal ? `/goals/${goal.id}/progress` : null);
  return (
    <>
      <Heading
        eyebrow="MY GOALS"
        title="내 목표"
        description="공부하고 싶은 것을, 이룰 수 있는 목표로."
        action={
          <Button onClick={() => setCreate(true)}>
            <Plus size={17} /> 새 목표
          </Button>
        }
      />
      <div
        className="row wrap spaced goal-list-filters"
        role="group"
        aria-label="목표 목록 필터"
      >
        <Button
          variant={archived ? "secondary" : ""}
          aria-pressed={!archived}
          onClick={() => setArchived(false)}
        >
          공부 중 {goals.filter((g) => !g.archived).length}
        </Button>
        <Button
          variant={archived ? "" : "secondary"}
          aria-pressed={archived}
          onClick={() => setArchived(true)}
        >
          <Archive size={16} /> 보관함 {goals.filter((g) => g.archived).length}
        </Button>
      </div>
      <div className="goal-list">
        {visible.map((g) => (
          <article
            key={g.id}
            className={`goal-list-item ${expanded === g.id && !archived ? "expanded" : ""}`}
          >
            <div className="goal-list-heading">
              <button
                className="goal-toggle"
                id={`goal-toggle-${g.id}`}
                aria-expanded={!archived && expanded === g.id}
                aria-controls={
                  !archived && expanded === g.id
                    ? `goal-detail-${g.id}`
                    : undefined
                }
                onClick={() => {
                  if (archived) {
                    setManage(g);
                    return;
                  }
                  select(g.id);
                  setExpanded(expanded === g.id ? null : g.id);
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`goal-toggle-${g.id}`)
                      ?.scrollIntoView({
                        block: expanded === g.id ? "nearest" : "start",
                      }),
                  );
                }}
              >
                <ChevronDown size={18} className="goal-chevron" />
                <span className="goal-list-title">
                  <strong>{g.title}</strong>
                  <span>
                    {label(g.kind)} ·{" "}
                    {g.minutesPerDay
                      ? `하루 ${g.minutesPerDay}분`
                      : "내 속도대로"}
                    {archived ? " · 보관됨" : ""}
                  </span>
                </span>
              </button>
              <button
                className="icon-button goal-more"
                aria-label={`${g.title} 관리`}
                onClick={() => setManage(g)}
              >
                <MoreHorizontal size={20} />
              </button>
            </div>
            {goal && goal.id === g.id && expanded === g.id && !archived && (
              <section
                className="goal-inline-detail"
                id={`goal-detail-${g.id}`}
                role="region"
                aria-labelledby={`goal-toggle-${g.id}`}
              >
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">선택한 목표</p>
                    <h2>{goal.title}</h2>
                  </div>
                  <Button variant="secondary" onClick={() => setEdit(goal)}>
                    목표 수정
                  </Button>
                </div>
                <p className="muted">
                  {goal.description || "학습 범위와 자료를 준비해 보세요."}
                </p>
                <div className="row wrap spaced">
                  <Badge value={goal.kind} />
                  <Badge>{goal.level || "현재 수준 미정"}</Badge>
                  <Badge>목표일 {date(goal.targetDate)}</Badge>
                </div>
                <div className="row wrap spaced">
                  <Action
                    run={() => api(`/goals/${goal.id}/plan`, "POST", {})}
                    onDone={() => go("/jobs")}
                  >
                    <Sparkles size={16} /> AI로 범위 설계
                  </Action>
                  <Button variant="secondary" onClick={() => setScope(true)}>
                    <Layers3 size={16} />
                    {goal.scope ? "범위 수정" : "범위 직접 입력"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!goal.scope}
                    onClick={() => go("/sources")}
                  >
                    <FolderOpen size={16} /> 자료 준비
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!goal.scope}
                    onClick={() => go("/exams")}
                  >
                    <Play size={16} /> 시험 만들기
                  </Button>
                </div>
                {!goal.scope ? (
                  <Notice tone="info">
                    학습 범위를 먼저 정해 주세요. AI가 제안한 초안은 에이전트
                    작업 화면에서 확인 후 저장할 수 있어요.
                  </Notice>
                ) : (
                  <div className="concept-grid">
                    {(p.data ?? goal.scope.concepts).map((c) => (
                      <div key={c.id} className="concept">
                        <div className="row between">
                          <span className="muted small">{c.area}</span>
                          <CheckCircle2 size={16} />
                        </div>
                        <strong>{c.name}</strong>
                        <Badge value={c.status ?? "unseen"} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </article>
        ))}
      </div>
      {!visible.length && (
        <Empty
          title={archived ? "보관한 목표가 없어요" : "무엇을 배우고 싶나요?"}
          description={
            archived
              ? "잠시 쉬고 싶은 목표를 보관하고 나중에 복원하세요."
              : "원하는 공부를 첫 목표로 만들어 보세요."
          }
        />
      )}
      {manage && (
        <GoalActions
          key={manage.id}
          goal={manage}
          close={() => setManage(null)}
          edit={() => {
            setEdit(manage);
            setManage(null);
          }}
          changed={() => {
            setManage(null);
            refresh();
          }}
        />
      )}
      {(create || edit) && (
        <Modal
          title={edit ? "목표 수정" : "새 학습 목표"}
          onClose={() => {
            setCreate(false);
            setEdit(null);
          }}
        >
          <SubmitForm
            submit={edit ? "변경 저장" : "목표 만들기"}
            onSubmit={(f) =>
              api(
                edit ? `/goals/${edit!.id}` : "/goals",
                edit ? "PATCH" : "POST",
                {
                  title: f.get("title"),
                  description: f.get("description"),
                  kind: f.get("kind"),
                  level: f.get("level") || null,
                  targetDate: f.get("targetDate") || null,
                  minutesPerDay: f.get("minutesPerDay")
                    ? Number(f.get("minutesPerDay"))
                    : null,
                },
              )
            }
            onDone={(g) => {
              if (!g.archived) {
                select(g.id);
                setExpanded(g.id);
                setArchived(false);
              }
              refresh();
              setCreate(false);
              setEdit(null);
              go("/goals");
            }}
          >
            <Field label="무엇을 이루고 싶나요?">
              <input
                name="title"
                autoFocus
                required
                maxLength={200}
                defaultValue={edit ? edit?.title : ""}
                placeholder="무엇을 배우거나 할 수 있게 되고 싶나요?"
              />
            </Field>
            <Field label="목표 유형">
              <Select
                name="kind"
                options={["general", "exam", "skill"]}
                defaultValue={edit ? edit?.kind : "general"}
              />
            </Field>
            <Field label="공부 방향">
              <textarea
                name="description"
                rows={3}
                defaultValue={edit ? edit?.description : ""}
                placeholder="어떤 상황에서 활용하고 싶은지 알려 주세요."
              />
            </Field>
            <Field label="현재 수준 (선택)">
              <input
                name="level"
                defaultValue={edit ? (edit?.level ?? "") : ""}
                placeholder="이미 아는 내용이나 경험을 적어 주세요. 처음이어도 괜찮아요."
              />
            </Field>
            <div className="form-grid">
              <Field label="목표일 (선택)">
                <input
                  name="targetDate"
                  type="date"
                  defaultValue={edit ? (edit?.targetDate ?? "") : ""}
                />
              </Field>
              <Field label="하루 공부 시간 (분)">
                <input
                  name="minutesPerDay"
                  type="number"
                  min={1}
                  max={1440}
                  defaultValue={edit ? (edit?.minutesPerDay ?? "") : 30}
                />
              </Field>
            </div>
          </SubmitForm>
        </Modal>
      )}
      {scope && goal && (
        <ScopeEditor
          goal={goal}
          onClose={() => setScope(false)}
          onSaved={() => {
            setScope(false);
            refresh();
            p.reload();
          }}
        />
      )}
    </>
  );
}
export function ScopeEditor({
  goal,
  initial,
  onClose,
  onSaved,
}: {
  goal: Goal;
  initial?: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const base = initial ?? goal.scope;
  const [sections, setSections] = useState<ExamSection[]>(
    base?.examFormat?.sections ?? [],
  );
  return (
    <Modal title="학습 범위 확인" onClose={onClose} wide>
      <SubmitForm
        submit="이 범위로 공부하기"
        onSubmit={(f) => {
          const concepts = String(f.get("concepts"))
            .split("\n")
            .filter((x) => x.trim())
            .map((line) => {
              const [area, ...rest] = line.split("|");
              const name = rest.join("|").trim();
              if (!name)
                throw new Error(
                  "각 줄을 ‘영역 | 개념’ 형식으로 입력해 주세요.",
                );
              const old = (base?.concepts as Concept[] | undefined)?.find(
                (c) => c.area === area.trim() && c.name === name,
              );
              return {
                area: area.trim(),
                name,
                weight: 1,
                ...(old ? { id: old.id } : {}),
              };
            });
          return api(`/goals/${goal.id}/scopes`, "POST", {
            title: f.get("title"),
            concepts,
            references: String(f.get("references"))
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            examFormat:
              f.get("examTotal") ||
              f.get("examMinutes") ||
              f.get("examEvidence") ||
              sections.length
                ? {
                    total: Number(f.get("examTotal")),
                    minutes: Number(f.get("examMinutes")),
                    evidenceUrl: f.get("examEvidence"),
                    sections,
                  }
                : null,
          });
        }}
        onDone={onSaved}
      >
        <Field label="범위 이름">
          <input
            name="title"
            required
            defaultValue={base?.title ?? goal.title}
          />
        </Field>
        <Field
          label="영역과 개념"
          hint="내 목표에 맞는 영역과 개념을 한 줄에 하나씩 입력하세요."
        >
          <textarea
            name="concepts"
            required
            rows={9}
            defaultValue={
              base?.concepts
                .map((c: Concept) => `${c.area} | ${c.name}`)
                .join("\n") ?? ""
            }
            placeholder={
              "영역 이름 | 학습할 개념\n다른 영역 이름 | 학습할 개념"
            }
          />
        </Field>
        <Field label="참고 URL (한 줄에 하나)">
          <textarea
            name="references"
            rows={3}
            defaultValue={base?.references?.join("\n") ?? ""}
          />
        </Field>
        <Notice tone="info">
          범위 변경은 새 버전으로 저장돼요. 이전 시험의 문제와 기록은 그대로
          유지됩니다.
        </Notice>
        <details>
          <summary>실전 모의시험의 공식 구성 (선택)</summary>
          <div className="form spaced">
            <div className="form-grid">
              <Field label="공식 문항 수">
                <input
                  name="examTotal"
                  type="number"
                  min={1}
                  max={500}
                  defaultValue={base?.examFormat?.total ?? ""}
                />
              </Field>
              <Field label="공식 시험 시간 (분)">
                <input
                  name="examMinutes"
                  type="number"
                  min={1}
                  max={1440}
                  defaultValue={base?.examFormat?.minutes ?? ""}
                />
              </Field>
            </div>
            <Field label="시험 구성 확인 URL">
              <input
                name="examEvidence"
                type="url"
                defaultValue={base?.examFormat?.evidenceUrl ?? ""}
              />
            </Field>
            <SectionEditor
              value={sections}
              change={setSections}
              concepts={(base?.concepts ?? []).filter((c: Concept) => !!c.id)}
            />
            <p className="small muted">
              새로 추가한 개념은 범위를 먼저 저장한 뒤 섹션에 지정할 수 있어요.
              선택하지 않으면 전체 개념을 사용해요.
            </p>
          </div>
        </details>
      </SubmitForm>
    </Modal>
  );
}
