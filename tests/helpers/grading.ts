// Contract fixtures only: this helper does not evaluate natural language.
export function alignedAudit(question: any) {
  return {
    criteria: question.rubric.map((r: any) => ({
      id: r.id,
      aligned: true,
      promptField: "stem",
      promptQuote: question.stem,
      reason: "모의 요구사항 대조",
    })),
    explanation: "모의 기준 검토",
  };
}
