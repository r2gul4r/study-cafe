import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "./api";
import { Button, Field, Notice, Select, SubmitForm } from "./ui";
import { label, type Question } from "./types";
import { revisionInput } from "./question-input";

export function QuestionEditor({
  question,
  onSaved,
  onCancel,
}: {
  question: Question;
  onSaved: (question: Question) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(question));
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Question>();
  const [loadingError, setLoadingError] = useState("");
  const update = (patch: Partial<Question>) =>
    setDraft((q) => ({ ...q, ...patch }));
  const rubric = draft.rubric ?? [];
  return (
    <>
      <Notice tone="info">
        수정 기준: 버전 {draft.version}. 저장하면 새 버전이 검토 대기 상태로
        생성됩니다. 기존 시험의 문제와 점수는 자동으로 바뀌지 않아요.
      </Notice>
      <SubmitForm
        submit="새 버전 저장"
        onSubmit={async () => {
          if (conflict)
            throw new Error("최신 버전을 확인하고 수정 기준을 갱신해 주세요.");
          if (
            draft.type === "short" &&
            Math.abs(
              rubric.reduce((sum, r) => sum + r.points, 0) - draft.points,
            ) > 1e-8
          )
            throw new Error("채점 기준의 점수 합계를 문항 배점과 맞춰 주세요.");
          try {
            return await api<Question>(
              `/questions/${question.id}/revisions`,
              "POST",
              revisionInput(draft),
            );
          } catch (error) {
            if (error instanceof ApiError && error.code === "REVISION_CONFLICT")
              setConflict(true);
            throw error;
          }
        }}
        onDone={onSaved}
      >
        <div className="row between wrap">
          <span className="muted small">
            {label(draft.type)} · 출처·근거·문항 유형은 유지됩니다.
          </span>
          <Button type="button" variant="ghost" onClick={onCancel}>
            수정 취소
          </Button>
        </div>
        <Field label="문제 본문">
          <textarea
            required
            rows={4}
            maxLength={100000}
            value={draft.stem}
            onChange={(e) => update({ stem: e.target.value })}
          />
        </Field>
        <Field label="공통 지문">
          <textarea
            rows={3}
            maxLength={50000}
            value={draft.passage ?? ""}
            onChange={(e) => update({ passage: e.target.value || null })}
          />
        </Field>
        <div className="form-grid">
          <Field label="문항 배점">
            <input
              type="number"
              min="0.01"
              max="100"
              step="any"
              required
              value={draft.points}
              onChange={(e) => update({ points: Number(e.target.value) })}
            />
          </Field>
          <Field label="난이도">
            <Select
              options={["easy", "medium", "hard"]}
              value={draft.difficulty}
              onChange={(e) => update({ difficulty: e.target.value })}
            />
          </Field>
        </div>
        {draft.type !== "short" ? (
          <fieldset className="editor-section">
            <legend>보기와 정답</legend>
            <p className="muted small">
              {draft.type === "single"
                ? "정답 하나를 선택하세요."
                : "정답을 모두 선택하세요."}
            </p>
            {draft.choices.map((choice, index) => (
              <div className="choice-editor" key={choice.id}>
                <label className="editor-check">
                  <input
                    type={draft.type === "single" ? "radio" : "checkbox"}
                    name="correct-answer"
                    aria-label={`보기 ${index + 1} 정답`}
                    checked={draft.answer?.includes(choice.id) ?? false}
                    onChange={(e) =>
                      update({
                        answer:
                          draft.type === "single"
                            ? [choice.id]
                            : e.target.checked
                              ? [...(draft.answer ?? []), choice.id]
                              : draft.answer?.filter((id) => id !== choice.id),
                      })
                    }
                  />
                  <span>{index + 1}</span>
                </label>
                <textarea
                  aria-label={`보기 ${index + 1} 내용`}
                  required
                  rows={2}
                  value={choice.text}
                  onChange={(e) =>
                    update({
                      choices: draft.choices.map((c) =>
                        c.id === choice.id ? { ...c, text: e.target.value } : c,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`보기 ${index + 1} 삭제`}
                  disabled={draft.choices.length <= 2}
                  onClick={() =>
                    update({
                      choices: draft.choices.filter((c) => c.id !== choice.id),
                      answer: draft.answer?.filter((id) => id !== choice.id),
                    })
                  }
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={draft.choices.length >= 10}
              onClick={() =>
                update({
                  choices: [
                    ...draft.choices,
                    { id: crypto.randomUUID(), text: "" },
                  ],
                })
              }
            >
              <Plus size={16} /> 보기 추가
            </Button>
          </fieldset>
        ) : (
          <fieldset className="editor-section">
            <legend>모범답안과 채점 기준</legend>
            <Field label="모범답안">
              <textarea
                required
                rows={4}
                maxLength={20000}
                value={draft.modelAnswer ?? ""}
                onChange={(e) => update({ modelAnswer: e.target.value })}
              />
            </Field>
            {rubric.map((criterion, index) => (
              <div className="rubric-editor" key={criterion.id}>
                <Field label={`기준 ${index + 1} 설명`}>
                  <textarea
                    required
                    rows={2}
                    value={criterion.description}
                    onChange={(e) =>
                      update({
                        rubric: rubric.map((r) =>
                          r.id === criterion.id
                            ? { ...r, description: e.target.value }
                            : r,
                        ),
                      })
                    }
                  />
                </Field>
                <div className="row wrap">
                  <Field label={`기준 ${index + 1} 점수`}>
                    <input
                      type="number"
                      min="0.01"
                      max="100"
                      step="any"
                      required
                      value={criterion.points}
                      onChange={(e) =>
                        update({
                          rubric: rubric.map((r) =>
                            r.id === criterion.id
                              ? { ...r, points: Number(e.target.value) }
                              : r,
                          ),
                        })
                      }
                    />
                  </Field>
                  <label className="editor-check">
                    <input
                      type="checkbox"
                      checked={criterion.required !== false}
                      onChange={(e) =>
                        update({
                          rubric: rubric.map((r) =>
                            r.id === criterion.id
                              ? { ...r, required: e.target.checked }
                              : r,
                          ),
                        })
                      }
                    />
                    필수 기준
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={rubric.length <= 1}
                    onClick={() =>
                      update({
                        rubric: rubric.filter((r) => r.id !== criterion.id),
                      })
                    }
                  >
                    기준 {index + 1} 삭제
                  </Button>
                </div>
              </div>
            ))}
            <p className="muted small">
              기준 합계 {rubric.reduce((sum, r) => sum + r.points, 0)}점 / 문항
              배점 {draft.points}점
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={rubric.length >= 20}
              onClick={() =>
                update({
                  rubric: [
                    ...rubric,
                    {
                      id: crypto.randomUUID(),
                      description: "",
                      points: 1,
                      required: true,
                    },
                  ],
                })
              }
            >
              <Plus size={16} /> 채점 기준 추가
            </Button>
          </fieldset>
        )}
        <Field label="해설">
          <textarea
            rows={5}
            maxLength={30000}
            value={draft.explanation ?? ""}
            onChange={(e) => update({ explanation: e.target.value })}
          />
        </Field>
      </SubmitForm>
      {conflict && (
        <section className="editor-section spaced">
          <Notice>
            다른 창에서 수정된 버전이 있어요. 입력 내용은 그대로 보존했어요.
            최신 내용을 비교한 뒤 계속할 수 있어요.
          </Notice>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                setLatest(await api<Question>(`/questions/${question.id}`));
                setLoadingError("");
              } catch (e) {
                setLoadingError((e as Error).message);
              }
            }}
          >
            최신 버전 확인
          </Button>
          {loadingError && <Notice>{loadingError}</Notice>}
          {latest && (
            <>
              <div className="excerpt">
                <strong>최신 버전 {latest.version}</strong>
                <p className="pre-wrap">{latest.stem}</p>
                {latest.passage && <p className="pre-wrap">{latest.passage}</p>}
                {latest.choices.map((c) => (
                  <p key={c.id}>
                    {latest.answer?.includes(c.id) ? "✓ " : ""}
                    {c.text}
                  </p>
                ))}
                {latest.modelAnswer && (
                  <p className="pre-wrap">모범답안: {latest.modelAnswer}</p>
                )}
                {latest.rubric?.map((r) => (
                  <p key={r.id}>
                    {r.description} · {r.points}점 ·{" "}
                    {r.required === false ? "선택" : "필수"}
                  </p>
                ))}
                <p className="pre-wrap">해설: {latest.explanation}</p>
                <p>
                  배점 {latest.points}점 · {label(latest.difficulty)}
                </p>
              </div>
              <div className="row wrap">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraft(structuredClone(latest));
                    setConflict(false);
                    setLatest(undefined);
                  }}
                >
                  최신 내용으로 교체
                </Button>
                <Button
                  onClick={() => {
                    setDraft((d) => ({
                      ...latest,
                      stem: d.stem,
                      passage: d.passage,
                      choices: d.choices,
                      answer: d.answer,
                      modelAnswer: d.modelAnswer,
                      rubric: d.rubric,
                      explanation: d.explanation,
                      points: d.points,
                      difficulty: d.difficulty,
                    }));
                    setConflict(false);
                    setLatest(undefined);
                  }}
                >
                  내 수정 내용 유지하고 다시 저장 준비
                </Button>
              </div>
              <p className="muted small">
                두 선택 모두 바로 저장하지 않습니다. 내용을 확인하고 ‘새 버전
                저장’을 눌러 주세요.
              </p>
            </>
          )}
        </section>
      )}
    </>
  );
}
