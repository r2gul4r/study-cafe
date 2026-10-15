export type Concept = {
  id: string;
  name: string;
  area: string;
  weight: number;
  status?: string;
  attempts?: number;
  independentSuccessDays?: number;
};
export type Scope = {
  id: string;
  version: number;
  title: string;
  concepts: Concept[];
  references: string[];
  examFormat?: { total: number; minutes: number; evidenceUrl: string } | null;
};
export type Goal = {
  id: string;
  title: string;
  description: string;
  kind: string;
  level: string | null;
  targetDate: string | null;
  minutesPerDay: number | null;
  archived: boolean;
  createdAt: string;
  scope: Scope | null;
};
export type Template = {
  id: string;
  name: string;
  total: number;
  single: number;
  multiple: number;
  short: number;
  mode: string;
  policy: string;
  minutes: number | null;
  difficulty: string;
};
export type Question = {
  id: string;
  revisionId: string;
  version?: number;
  createdAt?: string;
  familyId?: string;
  parentId?: string | null;
  groupId?: string | null;
  pastExamEvidence?: string | null;
  goalId: string;
  scopeId: string;
  stem: string;
  type: string;
  origin: string;
  difficulty: string;
  status: string;
  conceptIds: string[];
  review?: {
    reason: string;
    sourceCheck?: SourceAudit;
    answerCorrection?: {
      originalRevisionId: string;
      originalAudit: SourceAudit;
      reason: string;
      evidence: { segmentId: string; quote: string }[];
      verification?: { passed: boolean; reason: string; at: string };
      confirmedAt?: string;
    };
  };
  correctionReviewToken?: string;
  choices: { id: string; text: string }[];
  explanationChoiceOrder?: string[];
  passage: string | null;
  points: number;
  answer?: string[];
  modelAnswer?: string | null;
  explanation?: string;
  requiredAssetIds: string[];
  visualTranscription?: boolean;
  visualEvidence?: {
    segmentId: string;
    assetId: string;
    role: "question" | "answer";
  }[];
  evidence?: { segmentId: string; quote: string }[];
  sourceMatch?: {
    questionReference: string;
    answerReference: string;
    edition: string | null;
    questionEvidence: { segmentId: string; quote: string };
    answerEvidence: { segmentId: string; quote: string };
    answerContinuationEvidence?: { segmentId: string; quote: string }[];
    editionEvidence: { segmentId: string; quote: string }[];
  } | null;
  rubric?: {
    id: string;
    description: string;
    points: number;
    required?: boolean;
  }[];
};
export type SourceAudit = {
  questionUnambiguous: boolean;
  issues: {
    kind: string;
    location: string;
    description: string;
    evidence: { segmentId: string; quote: string };
  }[];
};
export type Exam = {
  id: string;
  goalId: string;
  status: string;
  template: Template;
  items: (Question & { slot: number })[];
  slots: { slot: number; type: string; conceptId: string }[];
};
export type Answer = {
  slot: number;
  version: number;
  value: string | string[];
  flagged: boolean;
  uncertain: boolean;
  hintUsed: boolean;
  recall: "hard" | "good" | "easy" | null;
  savedAt?: string;
};
export type Attempt = {
  id: string;
  examId: string;
  status: string;
  startedAt: string;
  deadline: string | null;
  submittedAt: string | null;
  remainingMs: number | null;
  exam: Exam;
  answers: Answer[];
};
export type Assessment = {
  criteria?: {
    id: string;
    score: number;
    evidence: string;
    reason: string;
    verdict?: string;
  }[];
  gradingReview?: {
    policyVersion: number;
    rubricAudit: {
      criteria: {
        id: string;
        aligned: boolean;
        promptField: "stem" | "passage";
        promptQuote: string;
        reason: string;
      }[];
      explanation: string;
    };
    secondPass: boolean;
    issue: string | null;
  };
  correctionRevision?: string;
  correctedAnswer?: string[];
  correctedExplanation?: string;
  version: number;
  score: number | null;
  passed: boolean;
  status: string;
  reason: string;
  explanation: string;
};
export type ResultItem = Question & {
  slot: number;
  answerGiven: Answer | null;
  assessment: Assessment;
  attemptId?: string;
};
export type Result = {
  attemptId: string;
  goalId: string;
  earned: number;
  confirmedPossible: number;
  totalPossible: number;
  pending: number;
  finalScore: number | null;
  items: ResultItem[];
};
export type Job = {
  id: string;
  kind: string;
  status: string;
  input: Record<string, any>;
  result: any;
  error: any;
  createdAt: string;
  updatedAt: string;
};
export type Source = {
  id: string;
  title: string;
  url: string | null;
  kind: string;
  rights: string;
  rightsBasis: string;
  publisher: string;
  status: string;
  revisions?: any[];
  [key: string]: any;
};
export type Home = {
  goals: { id: string; title: string; progress: Concept[] }[];
  continueAttempts: { id: string; exam_id: string; status: string }[];
  dueReviews: number;
  jobs: Job[];
};
export const labels: Record<string, string> = {
  general: "일반 학습",
  exam: "자격시험",
  skill: "실무 역량",
  single: "단일 선택",
  multiple: "복수 선택",
  short: "주관식",
  past_exam: "실제 기출",
  official_practice: "공식 연습",
  external_practice: "외부 연습",
  ai_generated: "AI 생성",
  ai_variant: "AI 변형",
  reference: "참고 자료",
  user_material: "내 자료",
  usable: "사용 가능",
  needs_review: "검토 필요",
  retired: "사용 중지",
  queued: "대기 중",
  running: "진행 중",
  succeeded: "완료",
  waiting_user: "확인 필요",
  paused: "일시정지",
  failed: "실패",
  cancelled: "취소됨",
  active: "풀이 중",
  submitted: "제출 완료",
  ready: "준비 완료",
  preparing: "문항 준비",
  practice: "일반 학습",
  weakness: "약점 집중",
  review: "오답 복습",
  mock: "실전 모의시험",
  past_only: "기출만",
  official_first: "공식 문제 우선",
  mixed: "기존 문제 + AI",
  ai_only: "AI 생성",
  easy: "쉬움",
  medium: "보통",
  hard: "어려움",
  any: "혼합",
  plan_goal: "목표 설계",
  research: "자료 조사",
  ingest_source: "자료 가져오기",
  extract_questions: "문제 추출",
  prepare_exam: "시험 준비",
  verify_question: "문항 검토",
  generate_variant: "변형 문제 생성",
  grade_attempt: "주관식 채점",
  summarize_wrong: "오답 요약",
  unseen: "아직 학습 전",
  review_needed: "복습 필요",
  learning: "학습 중",
  confirmed_multiple_times: "반복 확인",
  confirmed: "채점 확정",
  pending: "채점 보류",
  link_only: "링크만 보관",
  allowed: "이용 허용",
  user_provided: "직접 제공",
  discovered: "발견",
  ingested: "내용 확보",
  extracted: "본문 추출 완료",
  blocked: "수집 보류",
};
export const label = (v: string) => labels[v] ?? v;
export const date = (v?: string | null) =>
  v
    ? new Date(v).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
    : "기한 없음";
