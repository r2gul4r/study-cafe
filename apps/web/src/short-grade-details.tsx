import { StudyText } from "./study-content";
import type { ResultItem } from "./types";

const verdicts: Record<string, string> = {
  met: "요구 충족",
  equivalent: "같은 의미로 인정",
  partial: "일부 충족",
  missing: "요구한 내용 누락",
  contradiction: "내용 불일치",
  uncertain: "검토 필요",
};

export function ShortGradeDetails({ item }: { item: ResultItem }) {
  const { assessment } = item;
  const review = assessment.gradingReview;
  if (!review && !assessment.criteria?.length) return null;
  return (
    <details
      className="short-grade-details"
      open={assessment.status === "pending"}
    >
      <summary>채점 기준과 판단 근거</summary>
      <p className="muted small">
        {review
          ? review.secondPass
            ? "문제 요구사항 확인 · 감점 근거 재검토 완료"
            : "문제 요구사항 확인"
          : "이전 채점 기록이에요. 요구사항 대조·재검토 정보는 없어요."}
      </p>
      {(item.rubric ?? []).map((r) => {
        const criterion = assessment.criteria?.find((c) => c.id === r.id);
        const audit = review?.rubricAudit.criteria.find((c) => c.id === r.id);
        return (
          <div className="grade-criterion" key={r.id}>
            <div className="row between wrap">
              <strong>{r.description}</strong>
              <span className="small">
                {assessment.status === "pending"
                  ? "검토 중"
                  : criterion
                    ? `${criterion.score} / ${r.points}점`
                    : "기록 없음"}
              </span>
            </div>
            {audit && (
              <>
                {audit.promptQuote && (
                  <>
                    <span className="small muted">문제에서 요구한 내용</span>
                    <StudyText
                      className="grade-quote"
                      text={audit.promptQuote}
                    />
                  </>
                )}
                {!audit.aligned && (
                  <p className="grade-issue">기준 확인 필요: {audit.reason}</p>
                )}
              </>
            )}
            {criterion && (
              <>
                {criterion.verdict && (
                  <strong className="small">
                    {verdicts[criterion.verdict] ?? "판단 근거"}
                  </strong>
                )}
                {criterion.evidence && (
                  <>
                    <span className="small muted">내 답안 근거</span>
                    <StudyText
                      className="grade-quote"
                      text={criterion.evidence}
                    />
                  </>
                )}
                <StudyText className="small" text={criterion.reason} />
              </>
            )}
          </div>
        );
      })}
    </details>
  );
}
