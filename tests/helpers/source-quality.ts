// Contract fixture only, not a semantic evaluator.
export const cleanSourceCheck = () => ({
  questionUnambiguous: true,
  finalAnswerMatches: true,
  independentAnswer: "Independently verified fixture answer",
  issues: [],
});
