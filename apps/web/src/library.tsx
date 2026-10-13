import { useState } from "react";
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
import { api, go, TOKEN_KEY, useQuery } from "./api";
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
import { label, type Goal, type Source, type Question } from "./types";
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
            onDone={() => {
              setAdd(false);
              q.reload();
            }}
          >
            <Field label="자료 제목">
              <input
                autoFocus
                name="title"
                required
                maxLength={300}
                placeholder="예: JLPT N2 공식 연습문제"
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
            setSelected(null);
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
  q: Question;
  answer?: boolean;
}) {
  return (
    <>
      <div className="row wrap">
        <Badge value={q.type} />
        <Badge value={q.origin} />
        <span className="muted small">{q.points}점</span>
      </div>
      {q.passage && <div className="passage pre-wrap">{q.passage}</div>}
      <h3 className="question-stem pre-wrap">{q.stem}</h3>
      {q.choices?.length > 0 && (
        <ol className="answer-choices">
          {q.choices.map((c) => (
            <li
              key={c.id}
              className={answer && q.answer?.includes(c.id) ? "correct" : ""}
            >
              {c.text}
              {answer && q.answer?.includes(c.id) && <Badge>정답</Badge>}
            </li>
          ))}
        </ol>
      )}
      {answer && (
        <div className="explanation">
          <h4>정답과 해설</h4>
          <p className="pre-wrap">
            {q.modelAnswer || q.explanation || "등록된 해설이 없어요."}
          </p>
          {q.modelAnswer && q.explanation && (
            <p className="pre-wrap">{q.explanation}</p>
          )}
        </div>
      )}
      {!!q.requiredAssetIds?.length && (
        <div className="row wrap">
          {q.requiredAssetIds.map((id) => (
            <AssetLink key={id} id={id} />
          ))}
        </div>
      )}
    </>
  );
}
function QuestionDetail({
  question: q,
  onClose,
  refresh,
}: {
  question: Question;
  onClose: () => void;
  refresh: () => void;
}) {
  return (
    <Modal title="문제 상세" wide onClose={onClose}>
      <div className="modal-body">
        <QuestionBody q={q} answer />
        {q.evidence?.map((e, i) => (
          <blockquote key={i}>
            {e.quote}
            <small>원문 근거 · {e.segmentId.slice(0, 8)}</small>
          </blockquote>
        ))}
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
            onDone={refresh}
          >
            <Field label="검토 결과">
              <Select
                name="status"
                defaultValue={q.status}
                options={["usable", "needs_review", "retired"]}
              />
            </Field>
            <Field label="검토 사유">
              <textarea name="reason" required rows={2} />
            </Field>
          </SubmitForm>
        </details>
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
export function AssetLink({ id }: { id: string }) {
  return (
    <Action
      variant="secondary"
      run={async () => {
        const res = await fetch("/api/assets/" + encodeURIComponent(id), {
          headers: {
            Authorization: "Bearer " + sessionStorage.getItem(TOKEN_KEY),
          },
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
  );
}
