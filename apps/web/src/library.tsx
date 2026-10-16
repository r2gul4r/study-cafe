import { useEffect, useState } from "react";
import { reviewChoices } from "./review-choices";
import { StudyText } from "./study-content";
import {
  FileText,
  ExternalLink,
  Plus,
  Search,
  Sparkles,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-react";
import { api, go, browserHeaders, useQuery } from "./api";
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
  label,
  type Goal,
  type Source,
  type Question,
  type Assessment,
} from "./types";
import { QuestionEditor } from "./question-editor";
import { QuestionRegions } from "./question-regions";
import { QuestionEvidence } from "./question-evidence";
import { AnswerCorrection, needsCorrection } from "./answer-correction";
export function SourcesPage({ goal }: { goal: Goal }) {
  const q = useQuery<Source[]>(`/sources?goalId=${goal.id}`, 10000);
  const [add, setAdd] = useState(false),
    [detail, setDetail] = useState<Source | null>(null),
    [inputType, setInputType] = useState("url");
  return (
    <>
      <Heading
        eyebrow="STUDY MATERIALS"
        title="학습 자료"
        description="신뢰할 수 있는 자료에서 좋은 문제가 시작돼요."
        action={
          <div className="row wrap">
            <Action
              variant="secondary"
              disabled={!goal.scope}
              run={() => api(`/goals/${goal.id}/research`, "POST", {})}
              onDone={() => go("/jobs")}
            >
              <Sparkles size={16} /> 에이전트 조사
            </Action>
            <Button onClick={() => setAdd(true)}>
              <Plus size={16} /> 자료 추가
            </Button>
          </div>
        }
      />
      <div className="info-strip">
        <FileText size={19} />
        <div>
          <strong>{goal.title}</strong>
          <span>공식 자료 · 공개 기출 · 직접 준비한 교재를 한곳에</span>
        </div>
        <Badge>{q.data?.length ?? 0}개 자료</Badge>
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading ? (
        <Loading />
      ) : q.data?.length ? (
        <div className="source-grid">
          {q.data.map((s) => (
            <section className="panel source-card" key={s.id}>
              <div className="row between">
                <div className="source-icon">
                  <FileText size={23} />
                </div>
                <Badge value={s.status} />
              </div>
              <h3>{s.title}</h3>
              <p className="muted small">{s.publisher || "직접 등록한 자료"}</p>
              <div className="row wrap">
                <Badge value={s.kind} />
                <Badge value={s.rights} />
              </div>
              <div className="source-actions">
                <Button variant="secondary" onClick={() => setDetail(s)}>
                  자료 상세
                </Button>
                <Action
                  variant="ghost"
                  disabled={!s.revisions?.length || !goal.scope}
                  run={() =>
                    api(`/sources/${s.id}/extract-questions`, "POST", {})
                  }
                  onDone={() => go("/jobs")}
                >
                  문제 추출 <Sparkles size={14} />
                </Action>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty
          title="학습에 쓸 자료를 모아 보세요"
          description="URL, PDF, 텍스트를 추가하거나 에이전트에게 조사를 맡길 수 있어요."
          action={
            <Button onClick={() => setAdd(true)}>
              <Plus size={16} /> 첫 자료 추가
            </Button>
          }
        />
      )}
      {add && (
        <Modal title="학습 자료 추가" onClose={() => setAdd(false)} wide>
          <div className="segmented">
            {[
              ["url", "웹 링크"],
              ["pdf", "PDF 파일"],
              ["text", "텍스트"],
            ].map(([v, t]) => (
              <button
                key={v}
                className={inputType === v ? "selected" : ""}
                onClick={() => setInputType(v)}
              >
                {t}
              </button>
            ))}
          </div>
          <SubmitForm
            submit="자료 저장"
            onSubmit={async (f) => {
              const rights = String(f.get("rights"));
              const text = String(f.get("text") ?? "");
              let payload: any = {};
              if (inputType === "pdf") {
                const file = f.get("file") as File;
                if (!file?.size) throw new Error("PDF 파일을 선택해 주세요.");
                if (file.size > 20 * 1024 * 1024)
                  throw new Error("20MB 이하 PDF를 선택해 주세요.");
                const bytes = new Uint8Array(await file.arrayBuffer());
                if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
                  throw new Error("PDF 형식의 파일을 선택해 주세요.");
                let binary = "";
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                payload = { base64: btoa(binary), mime: "application/pdf" };
              } else if (inputType === "text")
                payload = { text, mime: "text/plain" };
              const s = await api("/sources", "POST", {
                goalId: goal.id,
                title: f.get("title"),
                url: inputType === "url" ? f.get("url") : null,
                publisher: f.get("publisher"),
                kind: f.get("kind"),
                rights,
                rightsBasis: f.get("basis"),
                examEvidence: f.get("examEvidence") || null,
              });
              if (rights !== "link_only")
                await api(`/sources/${s.id}/ingest`, "POST", payload);
              return s;
            }}
            onDone={(source) => {
              setAdd(false);
              q.reload();
              setDetail(source);
            }}
          >
            <Field label="자료 제목">
              <input
                autoFocus
                name="title"
                required
                maxLength={300}
                placeholder="어떤 자료인지 알아볼 수 있는 이름"
              />
            </Field>
            {inputType === "url" ? (
              <Field label="자료 URL">
                <input name="url" type="url" required placeholder="https://" />
              </Field>
            ) : inputType === "pdf" ? (
              <Field label="PDF 파일 (최대 20MB)">
                <input
                  type="file"
                  name="file"
                  accept="application/pdf,.pdf"
                  required
                />
              </Field>
            ) : (
              <Field label="자료 내용">
                <textarea
                  name="text"
                  rows={7}
                  required
                  placeholder="문제의 근거가 될 학습 내용을 입력하세요."
                />
              </Field>
            )}
            <div className="form-grid">
              <Field label="자료 분류">
                <Select
                  name="kind"
                  defaultValue="user_material"
                  options={[
                    "user_material",
                    "reference",
                    "past_exam",
                    "official_practice",
                    "external_practice",
                  ]}
                />
              </Field>
              <Field label="게시자">
                <input name="publisher" placeholder="공식 기관 또는 작성자" />
              </Field>
            </div>
            <Field label="자료 이용 방식">
              <Select
                key={inputType}
                name="rights"
                defaultValue={
                  inputType === "url" ? "link_only" : "user_provided"
                }
                options={
                  inputType === "url"
                    ? ["link_only", "allowed", "user_provided"]
                    : ["user_provided"]
                }
              />
            </Field>
            <Field
              label="이용 근거"
              hint="내용을 가져오는 자료는 직접 작성·제공 또는 이용 허용 근거를 남겨 주세요."
            >
              <textarea
                name="basis"
                rows={2}
                defaultValue={
                  inputType === "url"
                    ? ""
                    : "사용자가 학습용으로 직접 제공한 자료"
                }
              />
            </Field>
            <Field label="실제 기출 근거 (기출인 경우)">
              <input name="examEvidence" placeholder="시험명·회차·공개 근거" />
            </Field>
          </SubmitForm>
        </Modal>
      )}
      {detail && (
        <SourceDetail
          source={detail}
          onClose={() => setDetail(null)}
          refresh={q.reload}
        />
      )}
    </>
  );
}
function SourceDetail({
  source: initial,
  onClose,
  refresh,
}: {
  source: Source;
  onClose: () => void;
  refresh: () => void;
}) {
  const latest = useQuery<Source>(`/sources/${initial.id}`, 5000);
  const s = latest.data ?? initial;
  const segments = useQuery<any[]>(`/sources/${s.id}/segments`, 5000);
  return (
    <Modal title={s.title} onClose={onClose} wide>
      <div className="modal-body">
        <div className="row wrap">
          <Badge value={s.status} />
          <Badge value={s.rights} />
          {s.url && (
            <a
              className="text-link"
              href={safeUrl(s.url)}
              target="_blank"
              rel="noreferrer"
            >
              원문 열기 <ExternalLink size={14} />
            </a>
          )}
        </div>
        <p className="muted">{s.rightsBasis || "링크만 보관 중입니다."}</p>
        {latest.error && <Notice>{latest.error}</Notice>}
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            go("/jobs");
          }}
        >
          자료 처리 진행·실패 이유 확인
        </Button>
        <div className="row wrap">
          <Action
            variant="secondary"
            disabled={s.rights === "link_only" || !s.url}
            run={() => api(`/sources/${s.id}/ingest`, "POST", {})}
            onDone={() => {
              refresh();
              go("/jobs");
              onClose();
            }}
          >
            원문 가져오기
          </Action>
          <Action
            disabled={!s.revisions?.length}
            run={() => api(`/sources/${s.id}/extract-questions`, "POST", {})}
            onDone={() => {
              go("/jobs");
              onClose();
            }}
          >
            문제 추출
          </Action>
        </div>
        <details className="spaced">
          <summary>이용 방식 변경</summary>
          <SubmitForm
            onSubmit={(f) =>
              api(`/sources/${s.id}`, "PATCH", {
                rights: f.get("rights"),
                rightsBasis: f.get("basis"),
              })
            }
            onDone={() => {
              refresh();
              onClose();
            }}
          >
            <Field label="이용 방식">
              <Select
                name="rights"
                defaultValue={s.rights}
                options={["link_only", "allowed", "user_provided"]}
              />
            </Field>
            <Field label="이용 근거">
              <textarea name="basis" required defaultValue={s.rightsBasis} />
            </Field>
          </SubmitForm>
        </details>
        <h3>추출된 원문</h3>
        {segments.loading ? (
          <Loading />
        ) : segments.error ? (
          <Notice>{segments.error}</Notice>
        ) : segments.data?.length ? (
          segments.data.map((seg) => (
            <div className="excerpt" key={seg.id}>
              <small className="muted">원문 구간 · {seg.ordinal + 1}</small>
              <p className="pre-wrap">{seg.text}</p>
            </div>
          ))
        ) : (
          <p className="muted">
            아직 가져온 내용이 없어요. 자료 수집 작업을 확인해 주세요.
          </p>
        )}
      </div>
    </Modal>
  );
}
export function Bank({ goal, search }: { goal: Goal; search: string }) {
  const [term, setTerm] = useState(search),
    [origin, setOrigin] = useState(""),
    [type, setType] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<Question | null>(null);
  const params = new URLSearchParams({
    goalId: goal.id,
    q: term,
    limit: "12",
    offset: String(page * 12),
    ...(origin ? { origin } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  });
  const q = useQuery<{ total: number; items: Question[] }>(
    `/questions?${params}`,
  );
  return (
    <>
      <Heading
        eyebrow="QUESTION BANK"
        title="문제은행"
        description="출처와 개념을 확인하고, 나에게 필요한 문제를 찾아보세요."
        action={
          <Button variant="secondary" onClick={() => go("/sources")}>
            자료에서 문제 가져오기 <Plus size={16} />
          </Button>
        }
      />
      <section className="panel table-panel">
        <div className="table-toolbar">
          <label className="search-input">
            <Search size={16} />
            <input
              value={term}
              aria-label="문제 내용 검색"
              onChange={(e) => {
                setTerm(e.target.value);
                setPage(0);
              }}
              placeholder="문제 내용 검색…"
            />
          </label>
          <select
            aria-label="출처 필터"
            value={origin}
            onChange={(e) => {
              setOrigin(e.target.value);
              setPage(0);
            }}
          >
            <option value="">모든 출처</option>
            {[
              "past_exam",
              "official_practice",
              "external_practice",
              "ai_generated",
              "ai_variant",
            ].map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
          <select
            aria-label="유형 필터"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(0);
            }}
          >
            <option value="">모든 유형</option>
            {["single", "multiple", "short"].map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
          <select
            aria-label="검토 상태 필터"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
          >
            <option value="">모든 상태</option>
            {["usable", "needs_review", "retired"].map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
        </div>
        {q.error && <Notice>{q.error}</Notice>}
        {q.loading ? (
          <Loading />
        ) : !q.data?.items.length ? (
          <Empty
            title="표시할 문제가 없어요"
            description={
              term || origin || type || status
                ? "검색어 또는 필터를 바꿔 보세요."
                : "자료에서 문제를 추출하거나 새 시험을 준비해 보세요."
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>문제</th>
                  <th>출처</th>
                  <th>유형</th>
                  <th>난이도</th>
                  <th>검토 상태</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((item, i) => (
                  <tr key={item.id}>
                    <td>
                      <button
                        className="question-link"
                        onClick={() => setSelected(item)}
                      >
                        <span className="row-number">
                          {String(page * 12 + i + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <strong>{item.stem}</strong>
                          <small>
                            {item.conceptIds
                              .map(
                                (id) =>
                                  goal.scope?.concepts.find((c) => c.id === id)
                                    ?.name ?? "이전 범위",
                              )
                              .join(" · ")}
                          </small>
                        </div>
                      </button>
                    </td>
                    <td>
                      <Badge value={item.origin} />
                    </td>
                    <td>{label(item.type)}</td>
                    <td>{label(item.difficulty)}</td>
                    <td>
                      <Badge value={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>전체 {q.data?.total ?? 0}문항</span>
          <div className="row">
            <Button
              variant="secondary"
              disabled={!page}
              onClick={() => setPage((p) => p - 1)}
              aria-label="이전 페이지"
            >
              <ChevronLeft size={16} />
            </Button>
            <span>
              {page + 1} / {Math.max(1, Math.ceil((q.data?.total ?? 0) / 12))}
            </span>
            <Button
              variant="secondary"
              disabled={(page + 1) * 12 >= (q.data?.total ?? 0)}
              onClick={() => setPage((p) => p + 1)}
              aria-label="다음 페이지"
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        </div>
      </section>
      {selected && (
        <QuestionDetail
          question={selected}
          onClose={() => setSelected(null)}
          refresh={() => {
            q.reload();
          }}
        />
      )}
    </>
  );
}
export function QuestionBody({
  q,
  answer = false,
}: {
  q: Question & { assessment?: Assessment };
  answer?: boolean;
}) {
  const choices = answer
    ? reviewChoices(q.choices ?? [], q.explanationChoiceOrder)
    : q.choices;
  const reordered = choices?.some(
    (choice, index) => choice.id !== q.choices[index]?.id,
  );
  return (
    <>
      {answer && q.assessment?.correctionRevision && (
        <Notice tone="info">
          {q.assessment.correctedAnswer
            ? "정정된 정답과 해설을 표시합니다. 문제 본문은 응시 당시 내용입니다."
            : q.assessment.status === "pending"
              ? "문항 또는 채점 기준이 정정되었습니다. 아래는 응시 당시 문제이며 수동 검토가 필요합니다."
              : "정정된 문항을 수동 검토한 결과입니다. 아래는 응시 당시 문제입니다."}
        </Notice>
      )}
      <div className="row wrap">
        <Badge value={q.type} />
        <Badge value={q.origin} />
        <span className="muted small">{q.points}점</span>
      </div>
      {q.passage && <StudyText className="passage" text={q.passage} />}
      <StudyText className="question-stem" text={q.stem} headingLevel="h3" />
      {q.visualTranscription && (
        <p className="muted small">
          원본 이미지에서 수식·배치를 읽어 옮긴 문항이에요. 아래 원본도 함께
          확인할 수 있어요.
        </p>
      )}
      {reordered && (
        <Notice tone="info">
          해설의 보기 기호와 맞추기 위해 원문 순서로 표시합니다. 시험에서 본
          순서와 다를 수 있으며, 제출한 답안과 점수는 그대로입니다.
        </Notice>
      )}
      {q.choices?.length > 0 && (
        <ol className="answer-choices" type="A">
          {choices.map((c) => (
            <li
              key={c.id}
              className={
                answer &&
                (q.assessment?.correctedAnswer ?? q.answer)?.includes(c.id)
                  ? "correct"
                  : ""
              }
            >
              <StudyText text={c.text} />
              {answer &&
                (q.assessment?.correctedAnswer ?? q.answer)?.includes(c.id) && (
                  <Badge>정답</Badge>
                )}
            </li>
          ))}
        </ol>
      )}
      {answer && (
        <div className="explanation">
          <h4>정답과 해설</h4>
          <StudyText
            text={
              q.modelAnswer ||
              (q.assessment?.correctedExplanation ?? q.explanation) ||
              "등록된 해설이 없어요."
            }
          />
          {q.modelAnswer && q.explanation && <StudyText text={q.explanation} />}
        </div>
      )}
      {!!q.requiredAssetIds?.length && (
        <div className="row wrap">
          {q.requiredAssetIds.map((id) => (
            <AssetLink
              key={id}
              id={id}
              title={
                q.learnerRegions?.some((r) => r.assetId === id)
                  ? "선택한 문제 영역"
                  : "문제 원본"
              }
            />
          ))}
        </div>
      )}
    </>
  );
}
function QuestionDetail({
  question: initial,
  onClose,
  refresh,
}: {
  question: Question;
  onClose: () => void;
  refresh: () => void;
}) {
  const latest = useQuery<Question>(`/questions/${initial.id}`);
  const history = useQuery<Question[]>(`/questions/${initial.id}/revisions`);
  const [editing, setEditing] = useState(false);
  const [revisionId, setRevisionId] = useState("");
  const [saved, setSaved] = useState("");
  const [regraded, setRegraded] = useState<{
    affected: { attemptId: string; slot: number; status: string }[];
  }>();
  const current = latest.data ?? initial;
  const q = history.data?.find((r) => r.revisionId === revisionId) ?? current;
  const historical = q.revisionId !== current.revisionId;
  const updated = (question: Question) => {
    latest.setData(question);
    history.reload();
    setRevisionId("");
    setRegraded(undefined);
    refresh();
  };
  return (
    <Modal title="문제 상세" wide onClose={onClose}>
      <div className="modal-body">
        {latest.error && <Notice>{latest.error}</Notice>}
        {saved && <Notice tone="info">{saved}</Notice>}
        {needsCorrection(q) && (
          <>
            <AnswerCorrection
              question={q}
              canConfirm={!historical && !editing}
              original={history.data?.find(
                (r) =>
                  r.revisionId ===
                  q.review?.answerCorrection?.originalRevisionId,
              )}
              onUpdated={(question) => {
                updated(question);
                setSaved(
                  "정정을 확정했어요. 새 시험부터 이 버전을 사용합니다.",
                );
              }}
            />
            <details className="spaced">
              <summary>원본 근거와 PDF 페이지 대조</summary>
              <QuestionEvidence key={q.revisionId} question={q} />
              {(q.visualEvidence ?? []).map((v) => (
                <div key={`${v.role}:${v.assetId}`}>
                  <strong>
                    {v.role === "answer" ? "원본 정답표" : "원본 문제"}
                  </strong>
                  <AssetLink
                    id={v.assetId}
                    title={v.role === "answer" ? "정답표 원본" : "문제 원본"}
                  />
                </div>
              ))}
            </details>
          </>
        )}
        {editing ? (
          <QuestionEditor
            question={current}
            correctionMode={needsCorrection(current)}
            onCancel={() => setEditing(false)}
            onSaved={(question) => {
              updated(question);
              setEditing(false);
              setSaved(
                needsCorrection(question)
                  ? `정정 버전 ${question.version} 저장 완료. AI 검토를 실행한 뒤 원본과 비교하고 정정 확정해 주세요.`
                  : `새 버전 ${question.version} 저장 완료. 검토 후 사용 가능으로 변경하면 새 시험에 사용할 수 있어요.`,
              );
            }}
          />
        ) : (
          <>
            <div className="row between wrap spaced">
              <div className="row wrap">
                <Badge>버전 {q.version}</Badge>
                <Badge value={q.status} />
                {q.createdAt && (
                  <span className="muted small">
                    {new Date(q.createdAt).toLocaleString("ko-KR")}
                  </span>
                )}
              </div>
              <Button
                disabled={latest.loading || !!latest.error || historical}
                onClick={() => {
                  setEditing(true);
                  setSaved("");
                  setRegraded(undefined);
                }}
              >
                {needsCorrection(q)
                  ? q.review?.answerCorrection
                    ? "정정안 수정"
                    : "원본 정답 정정"
                  : "문제 수정"}
              </Button>
            </div>
            <Field label="수정 이력">
              <select
                value={revisionId || current.revisionId}
                onChange={(e) => {
                  setRevisionId(e.target.value);
                  setRegraded(undefined);
                }}
              >
                {(history.data ?? [current]).map((r) => (
                  <option key={r.revisionId} value={r.revisionId}>
                    버전 {r.version} · {label(r.status)}
                    {r.revisionId === current.revisionId ? " · 최신" : ""}
                  </option>
                ))}
              </select>
            </Field>
            {history.error && <Notice>{history.error}</Notice>}
            {historical && (
              <Notice tone="info">
                이전 버전을 보고 있어요. 수정·검토·재채점은 최신 버전에서 진행해
                주세요.
              </Notice>
            )}
            <QuestionBody q={q} answer />
            {!historical &&
              !needsCorrection(q) &&
              !q.review?.answerCorrection &&
              q.visualEvidence?.some((v) => v.role === "question") && (
                <QuestionRegions
                  key={`regions:${q.revisionId}`}
                  question={q}
                  onSaved={(question) => {
                    updated(question);
                    setSaved(
                      "표시 영역을 새 버전으로 저장했어요. AI 검토에서 잘린 내용과 정답 노출 여부를 확인해 주세요.",
                    );
                  }}
                />
              )}
            {q.review?.sourceCheck && (
              <Notice tone="info">
                <strong>원본 표기·정답 검토</strong>
                <StudyText text={q.review.reason} />
              </Notice>
            )}
            {q.review?.visualCheck && (
              <Notice tone="info">
                <strong>문제 이미지 검토</strong>
                <p>
                  원본 일치:{" "}
                  {q.review.visualCheck.faithful ? "확인" : "확인 필요"} · 내용
                  완전성:{" "}
                  {q.review.visualCheck.complete ? "확인" : "누락 확인 필요"} ·
                  정답 노출 없음:{" "}
                  {q.review.visualCheck.noAnswerLeak ? "확인" : "확인 필요"}
                </p>
                <StudyText text={q.review.visualCheck.reason} />
              </Notice>
            )}
            {q.type === "short" && (
              <div className="excerpt">
                <h4>채점 기준</h4>
                {q.rubric?.map((r) => (
                  <p key={r.id}>
                    {r.description} · {r.points}점 ·{" "}
                    {r.required === false ? "선택" : "필수"}
                  </p>
                ))}
              </div>
            )}
            {!needsCorrection(q) && (
              <QuestionEvidence key={q.revisionId} question={q} />
            )}
            {!historical && (
              <>
                <div className="row wrap spaced">
                  <Action
                    variant="secondary"
                    run={() => api(`/questions/${q.id}/verify`, "POST", {})}
                    onDone={() => {
                      go("/jobs");
                      onClose();
                    }}
                  >
                    <Sparkles size={16} /> AI 검토
                  </Action>
                  <Action
                    variant="secondary"
                    run={() => api(`/questions/${q.id}/variant`, "POST", {})}
                    onDone={() => {
                      go("/jobs");
                      onClose();
                    }}
                  >
                    변형 문제 만들기
                  </Action>
                </div>
                <details>
                  <summary>검토 상태 직접 변경</summary>
                  <SubmitForm
                    onSubmit={(f) =>
                      api(`/questions/${q.id}/review`, "POST", {
                        revisionId: q.revisionId,
                        status: f.get("status"),
                        reason: f.get("reason"),
                      })
                    }
                    onDone={(question) => {
                      updated(question);
                      setSaved("검토 상태를 저장했어요.");
                    }}
                  >
                    <Field label="검토 결과">
                      <Select
                        name="status"
                        defaultValue={
                          needsCorrection(q) ? "needs_review" : q.status
                        }
                        options={
                          needsCorrection(q)
                            ? ["needs_review", "retired"]
                            : ["usable", "needs_review", "retired"]
                        }
                      />
                    </Field>
                    <Field label="검토 사유">
                      <textarea name="reason" required rows={2} />
                    </Field>
                  </SubmitForm>
                </details>
                <details className="spaced">
                  <summary>과거 응시 재채점</summary>
                  <Notice tone="info">
                    사용 가능으로 검토된 최신 정답을 제출 완료된 과거 응시에
                    적용합니다. 본문·보기·배점이 같은 객관식은 자동 재채점하고,
                    내용이 달라졌거나 주관식이면 수동 검토 대기로 변경됩니다.
                    기존 시험 원문은 유지됩니다.
                  </Notice>
                  {q.status !== "usable" ? (
                    <p className="muted">
                      먼저 위에서 최신 버전을 검토하고 ‘사용 가능’으로 변경해
                      주세요.
                    </p>
                  ) : (
                    <SubmitForm
                      key={q.revisionId}
                      submit="확인한 정답으로 과거 응시 재채점"
                      onSubmit={(f) => {
                        const reason = String(f.get("reason") ?? "").trim();
                        if (!reason)
                          throw new Error("정정 사유를 입력해 주세요.");
                        return api(`/questions/${q.id}/regrade`, "POST", {
                          revisionId: q.revisionId,
                          reason,
                        });
                      }}
                      onDone={setRegraded}
                    >
                      <Field label="정정 사유">
                        <textarea
                          name="reason"
                          required
                          maxLength={5000}
                          rows={2}
                          placeholder="예: 원문 정답표를 확인하여 정답을 수정했습니다."
                        />
                      </Field>
                      <label className="editor-check">
                        <input type="checkbox" required />
                        과거 점수와 복습 일정이 다시 계산되는 것을 확인했어요.
                      </label>
                    </SubmitForm>
                  )}
                  {regraded && (
                    <section className="excerpt" role="status">
                      <strong>
                        {regraded.affected.length
                          ? `${regraded.affected.length}개 응시 문항에 정정을 적용했어요.`
                          : "새로 정정할 과거 응시가 없어요."}
                      </strong>
                      {!!regraded.affected.length && (
                        <p>
                          자동 확정{" "}
                          {
                            regraded.affected.filter(
                              (r) => r.status === "confirmed",
                            ).length
                          }
                          개 · 수동 검토{" "}
                          {
                            regraded.affected.filter(
                              (r) => r.status === "pending",
                            ).length
                          }
                          개
                        </p>
                      )}
                      {regraded.affected.map((r) => (
                        <p key={`${r.attemptId}-${r.slot}`}>
                          <a
                            className="text-link"
                            href={`#/result/${r.attemptId}`}
                            onClick={onClose}
                          >
                            응시 {r.attemptId.slice(0, 8)} · {r.slot}번 결과
                            확인
                          </a>
                        </p>
                      ))}
                    </section>
                  )}
                </details>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
export function safeUrl(url: string) {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function AssetLink({
  id,
  title = "문제 원본",
}: {
  id: string;
  title?: string;
}) {
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true,
      url: string | undefined;
    const controller = new AbortController();
    setPreview(undefined);
    setError("");
    void fetch("/api/assets/" + encodeURIComponent(id), {
      signal: controller.signal,
      headers: browserHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("원본 자료를 불러오지 못했어요.");
        if (res.headers.get("Content-Type")?.split(";")[0] !== "image/png") {
          await res.body?.cancel();
          return;
        }
        const blob = await res.blob();
        if (live) {
          url = URL.createObjectURL(blob);
          setPreview(url);
        }
      })
      .catch((e) => {
        if (live && e.name !== "AbortError") setError(e.message);
      });
    return () => {
      live = false;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, reload]);
  return (
    <div className="source-page-asset">
      {preview && (
        <figure>
          <a href={preview} target="_blank" rel="noreferrer">
            <img
              src={preview}
              alt={`${title} PDF 페이지: 그래프와 수식을 확인하세요`}
            />
          </a>
          <figcaption>{title} · 누르면 크게 볼 수 있어요.</figcaption>
        </figure>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            다시 불러오기
          </button>
        </p>
      )}
      <Action
        variant="secondary"
        run={async () => {
          const res = await fetch("/api/assets/" + encodeURIComponent(id), {
            headers: browserHeaders(),
          });
          if (!res.ok) throw new Error("첨부파일을 가져오지 못했어요.");
          const blob = await res.blob(),
            url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = id + (blob.type === "application/pdf" ? ".pdf" : "");
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        <Download size={15} /> 첨부 자료
      </Action>
    </div>
  );
}
