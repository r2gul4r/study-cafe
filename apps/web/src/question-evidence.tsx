import { useQuery } from "./api";
import { StudyText } from "./study-content";
import { Loading, Notice } from "./ui";
import type { Question } from "./types";

type Evidence = {
  segmentId: string;
  quote: string;
  title: string;
  url: string | null;
  acquiredAt: string;
  text: string;
  role: string;
  locator: { pdfPage?: number; charStart?: number; charEnd?: number };
};
export function QuestionEvidence({ question }: { question: Question }) {
  const evidence = useQuery<Evidence[]>(
    `/questions/${question.id}/evidence?revisionId=${encodeURIComponent(question.revisionId)}`,
  );
  return (
    <section className="spaced" aria-label="문항 원문 근거">
      <h3>원문 근거 대조</h3>
      {question.sourceMatch && (
        <p className="small">
          원문 문항 {question.sourceMatch.questionReference} · 정답{" "}
          {question.sourceMatch.answerReference}
          {question.sourceMatch.edition
            ? ` · ${question.sourceMatch.edition}`
            : " · 같은 자료의 정답"}
        </p>
      )}
      {evidence.loading ? (
        <Loading />
      ) : evidence.error ? (
        <Notice>{evidence.error}</Notice>
      ) : (
        evidence.data?.map((item, index) => (
          <div
            className="excerpt evidence-card"
            key={`${item.segmentId}:${index}`}
          >
            <strong>{item.title}</strong>
            <p className="muted small">
              {{
                question: "문제 본문",
                answer: "정답 근거",
                edition: "판본·회차",
                support: "학습 근거",
              }[item.role] ?? "학습 근거"}{" "}
              · {item.locator.pdfPage ? `PDF ${item.locator.pdfPage}쪽 · ` : ""}
              구간 {(item.locator.charStart ?? 0) + 1}–
              {item.locator.charEnd ?? item.text.length} · 수집{" "}
              {new Date(item.acquiredAt).toLocaleString("ko-KR")}
            </p>
            <blockquote>
              <StudyText text={item.quote} />
            </blockquote>
            <details>
              <summary>저장된 원문 구간 보기</summary>
              <div className="evidence-original">
                <StudyText text={item.text} />
              </div>
            </details>
            {item.url && /^https?:\/\//i.test(item.url) && (
              <a href={item.url} target="_blank" rel="noreferrer">
                원문 사이트 열기
              </a>
            )}
          </div>
        ))
      )}
      <p className="muted small">
        이 문항이 인용한 당시 원문을 표시합니다. 인용문이 있어도 정답을
        뒷받침하는지 직접 확인할 수 있어요.
      </p>
    </section>
  );
}
