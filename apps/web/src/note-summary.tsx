import { StudyText } from "./study-content";
import type { TextReferences } from "./study-text";
import { Badge } from "./ui";

type NoteReference = {
  questionId: string;
  attemptId: string;
  slot: number;
  examTitle: string;
  submittedAt: string;
  segmentIds: string[];
};
export function NoteSummary({
  concept,
  goalId,
}: {
  concept: {
    summary: string;
    example?: string;
    reasonIsInferred?: boolean;
    references?: NoteReference[];
  };
  goalId: string;
}) {
  const refs = concept.references ?? [];
  const links: TextReferences = {};
  const href = (ref: NoteReference) =>
    `#/result/${ref.attemptId}?slot=${ref.slot}&goalId=${goalId}`;
  for (const ref of refs) {
    const link = { label: `${ref.slot}번 문항`, href: href(ref) };
    (links[ref.questionId] ??= []).push(link);
    links[ref.attemptId] = [
      {
        label: ref.examTitle,
        href: `#/result/${ref.attemptId}?goalId=${goalId}`,
      },
    ];
    for (const segmentId of ref.segmentIds)
      links[segmentId] = [
        { label: "학습 자료", href: `#/sources?goalId=${goalId}` },
      ];
  }
  return (
    <>
      {concept.reasonIsInferred && <Badge>오답 원인은 AI의 추정이에요</Badge>}
      <h4>핵심 정리</h4>
      <StudyText text={concept.summary} references={links} readable />
      {concept.example && (
        <div className="summary-example">
          <h4>비교 예시</h4>
          <StudyText text={concept.example} references={links} readable />
        </div>
      )}
      <div className="summary-references">
        <h4>근거 문항</h4>
        {refs.length ? (
          <ul>
            {refs.map((ref) => (
              <li key={`${ref.attemptId}:${ref.slot}`}>
                <a className="text-link" href={href(ref)}>
                  {ref.slot}번 문항 보기
                </a>
                <span>
                  {ref.examTitle} ·{" "}
                  {new Date(ref.submittedAt).toLocaleString("ko-KR")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">연결할 수 있는 원래 채점 기록이 없어요.</p>
        )}
      </div>
    </>
  );
}
