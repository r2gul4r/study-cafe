import { api } from "./api";
import { StudyText } from "./study-content";
import { Field, Notice, SubmitForm } from "./ui";
import type { Question } from "./types";

export const needsCorrection = (q: Question) =>
  !!q.review?.answerCorrection ||
  !!q.review?.sourceCheck?.issues.some((i) => i.kind === "answer_error");

function AnswerSummary({ question }: { question: Question }) {
  return (
    <>
      <StudyText
        text={
          question.modelAnswer ??
          question.choices
            .filter((c) => question.answer?.includes(c.id))
            .map((c) => c.text)
            .join(" / ")
        }
      />
      <strong>해설</strong>
      <StudyText text={question.explanation ?? "없음"} />
      {!!question.rubric?.length && (
        <details>
          <summary>채점 기준</summary>
          {question.rubric.map((r) => (
            <p key={r.id}>
              {r.description} · {r.points}점 ·{" "}
              {r.required === false ? "선택" : "필수"}
            </p>
          ))}
        </details>
      )}
    </>
  );
}

export function AnswerCorrection({
  question: q,
  original,
  canConfirm,
  onUpdated,
}: {
  question: Question;
  original?: Question;
  canConfirm: boolean;
  onUpdated: (q: Question) => void;
}) {
  const correction = q.review?.answerCorrection;
  const issues =
    (correction?.originalAudit ?? q.review?.sourceCheck)?.issues ?? [];
  return (
    <section className="spaced" aria-label="원본 정답 정정 검토">
      <h3>{correction ? "원본과 정정안 비교" : "원본 정답 오류 확인"}</h3>
      <Notice tone="info">
        원본 근거 확인 → 정정안 저장 → AI 검토 → 정정 확정 순서로 진행해요.
        정정안은 공식 정답표의 수정본이 아니라 이 공부방에서 검토한 별도
        버전이에요. 기존 시험과 점수는 자동으로 바뀌지 않아요.
      </Notice>
      {issues
        .filter((i) => i.kind === "answer_error")
        .map((i, n) => (
          <div className="excerpt" key={n}>
            <strong>확인된 원본 오류</strong>
            <StudyText text={i.description} />
            <blockquote>
              <StudyText text={i.evidence.quote} />
            </blockquote>
          </div>
        ))}
      {correction && (
        <>
          <div className="correction-comparison">
            <div className="excerpt">
              <h4>원본 버전 {original?.version}</h4>
              {original ? (
                <AnswerSummary question={original} />
              ) : (
                <p>수정 이력에서 원본을 불러오는 중이에요.</p>
              )}
            </div>
            <div className="excerpt">
              <h4>정정 버전 {q.version}</h4>
              <AnswerSummary question={q} />
            </div>
          </div>
          <p>
            <strong>정정 사유</strong>
          </p>
          <StudyText text={correction.reason} />
          <Notice tone="info">
            {correction.confirmedAt
              ? "사용자가 정정 확정한 버전입니다."
              : correction.verification?.passed
                ? "AI 검토 통과 · 사용자 확정 전까지 출제되지 않습니다."
                : correction.verification
                  ? "AI 검토 보류 · 아래 근거를 확인하고 정정안을 수정해 주세요."
                  : "정정안 저장 완료 · AI 검토를 실행해 주세요."}
            {correction.verification && (
              <StudyText
                text={
                  correction.confirmedAt
                    ? `AI 검토: ${correction.verification.reason}\n사용자 확정: ${q.review?.reason}`
                    : (q.review?.reason ?? correction.verification.reason)
                }
              />
            )}
          </Notice>
          {canConfirm &&
            q.status === "needs_review" &&
            correction.verification?.passed &&
            original && (
              <SubmitForm
                key={q.correctionReviewToken}
                submit="정정 확정 · 새 시험에 사용"
                onSubmit={(f) =>
                  api<Question>(
                    `/questions/${q.id}/corrections/confirm`,
                    "POST",
                    {
                      revisionId: q.revisionId,
                      reviewToken: q.correctionReviewToken,
                      reason: f.get("reason"),
                    },
                  )
                }
                onDone={onUpdated}
              >
                <Field label="확정 근거">
                  <textarea
                    required
                    name="reason"
                    rows={2}
                    maxLength={5000}
                    placeholder="원본과 정정안을 대조한 결과를 기록해 주세요."
                  />
                </Field>
                <label className="editor-check">
                  <input type="checkbox" required />
                  원본 근거, 정정 답안·해설·채점 기준과 AI 검토 결과를
                  확인했어요.
                </label>
              </SubmitForm>
            )}
        </>
      )}
    </section>
  );
}
