// Hand-authored evaluation cases. Expected judgments stay in the runner and are
// never sent to the model. These subjects are examples, not product branches.
type ExpectedGrade = {
  status: "confirmed" | "pending";
  score: number | null;
  passed: boolean;
};
export type ShortAnswerCase = {
  id: string;
  title: string;
  kind: "general" | "skill" | "exam";
  concept: string;
  material: string;
  stem: string;
  modelAnswer: string;
  answer: string;
  rubric: {
    id: string;
    description: string;
    points: number;
    required: boolean;
  }[];
  expected: ExpectedGrade;
  alternative?: ExpectedGrade;
  verifyStatuses?: ("needs_review" | "usable")[];
};
const criterion = (id: string, description: string, points = 1) => ({
  id,
  description,
  points,
  required: true,
});
const astronomy = {
  title: "천문 개념 이해",
  kind: "general" as const,
  concept: "위성",
  material: "위성은 다른 천체의 주위를 공전하는 천체이다.",
  stem: "위성의 의미를 설명하시오.",
  modelAnswer: "다른 천체의 주위를 공전하는 천체이다.",
  rubric: [
    criterion("meaning", "다른 천체 주위를 도는 천체라는 의미를 설명한다.", 2),
  ],
};
const output = {
  title: "코드 읽기",
  kind: "skill" as const,
  concept: "반복과 출력",
  material:
    "range(3)은 0, 1, 2를 제공한다. for 문은 각 값마다 들여쓴 본문을 실행한다. print는 값 뒤에 줄바꿈을 출력한다.",
  stem: "다음 코드의 전체 출력 결과만 줄바꿈하여 쓰시오.\n\n```python\nfor n in range(3):\n    print(n)\n```",
  modelAnswer:
    "0\n1\n2\n\nrange(3)은 0, 1, 2를 차례로 제공하므로 총 세 번 출력한다.",
  answer: "0\n1\n2",
};
const units = {
  title: "기초 단위 시험 대비",
  kind: "exam" as const,
  concept: "길이 단위 변환",
  material: "1 km는 1000 m이다. 1.5 km는 1500 m이다.",
  stem: "1.5 km를 m 단위로 바꾸어 쓰시오. 숫자와 단위를 함께 쓰시오.",
  modelAnswer: "1500 m",
  rubric: [
    criterion("length", "1500 m 또는 이와 동등한 미터 단위의 값을 쓴다.", 2),
  ],
};
const historical = {
  title: "반복문 안팎의 실행 이해",
  kind: "skill" as const,
  concept: "들여쓰기와 반복",
  material:
    "range(1, 6, 2)는 1, 3, 5를 제공한다. 들여쓴 두 print는 각 반복마다 실행된다. 들여쓰지 않은 print('끝')은 반복이 끝난 뒤 한 번 실행된다.",
  stem: "다음 코드의 전체 출력 결과를 줄바꿈하여 쓰시오. 또한 print('확인')과 print('끝')의 실행 횟수가 서로 다른 이유를 들여쓰기와 관련지어 설명하시오.\n\n```python\nfor n in range(1, 6, 2):\n    print(n)\n    print('확인')\nprint('끝')\n```",
  modelAnswer:
    "1\n확인\n3\n확인\n5\n확인\n끝\n\nrange(1, 6, 2)는 1, 3, 5를 차례로 제공하므로 반복은 3번 진행된다. print('확인')은 들여쓰기되어 반복문 안에 있으므로 3번 실행된다. print('끝')은 반복문 밖에 있으므로 반복이 모두 끝난 뒤 1번 실행된다.",
  answer:
    "1\n확인\n3\n확인\n5\n확인\n끝\n들여쓰기된 print(확인)은 반복문 안이므로 3번, print(끝)은 들여쓰기 없이 반복문 밖이므로 반복 종료 후 1번 실행됩니다.",
};
const full = (score: number) => ({
  status: "confirmed" as const,
  score,
  passed: true,
});
const pending = { status: "pending" as const, score: null, passed: false };

export const shortAnswerCases: ShortAnswerCase[] = [
  {
    id: "described-method-value-only",
    title: "CSS 값과 풀이 요구 구분",
    kind: "skill",
    concept: "content-box 높이",
    material:
      "content-box의 전체 높이는 콘텐츠 높이와 위아래 padding, border의 합이다.",
    stem: "content-box 요소의 height는 90px, 위아래 padding은 10px와 15px, 위아래 border는 2px와 3px이다. 테두리 바깥쪽까지의 높이는 몇 px인가?",
    modelAnswer: "120px",
    answer: "120px",
    rubric: [
      criterion(
        "height",
        "콘텐츠 높이에 위아래 padding과 border를 더해 120px로 제시함",
        2,
      ),
    ],
    expected: full(2),
  },
  {
    id: "long-equivalent-answer",
    title: "장문에서 핵심 의미 판정",
    kind: "general",
    concept: "중앙값",
    material:
      "중앙값은 자료를 크기순으로 정렬했을 때 가운데 값이다. 자료 개수가 짝수이면 가운데 두 값의 산술평균이다.",
    stem: "자료 개수가 짝수일 때 중앙값을 구하는 방법을 설명하시오.",
    modelAnswer: "자료를 크기순으로 정렬하고 가운데 두 값의 평균을 구한다.",
    answer:
      "자료를 먼저 크기순으로 나열해야 합니다. " +
      "최댓값과 최솟값만으로는 중앙값을 정하지 못하며 자료의 순서가 중요합니다. ".repeat(
        35,
      ) +
      "짝수 개의 자료에서는 중앙의 두 수를 더한 뒤 2로 나누면 됩니다.",
    rubric: [
      criterion("sort", "자료를 크기순으로 정렬한다."),
      criterion("average", "가운데 두 값의 평균을 구한다."),
    ],
    expected: full(2),
  },
  {
    id: "alternate-valid-example",
    title: "여러 가능한 정답",
    kind: "general",
    concept: "평균",
    material: "두 수의 산술평균은 합을 2로 나눈 값이다.",
    stem: "서로 다른 정수 두 개를 써서 산술평균이 5가 되는 예를 하나 제시하시오.",
    modelAnswer: "4와 6",
    answer: "2와 8",
    rubric: [
      criterion(
        "example",
        "서로 다른 정수 두 개의 합이 10인 예를 제시한다.",
        2,
      ),
    ],
    expected: full(2),
  },
  {
    id: "contradictory-answer",
    title: "서로 모순되는 답",
    kind: "general",
    concept: "평균",
    material: "자료 2, 4, 6의 산술평균은 (2+4+6)/3=4이다.",
    stem: "자료 2, 4, 6의 산술평균을 하나의 값으로 쓰시오.",
    modelAnswer: "4",
    answer: "4 또는 12. 둘 중 어느 쪽인지는 모르겠다.",
    rubric: [criterion("value", "산술평균을 4로 확정한다.", 2)],
    expected: { status: "confirmed", score: 0, passed: false },
    alternative: pending,
  },
  {
    ...astronomy,
    id: "meaning-paraphrase",
    answer: "어떤 천체를 중심으로 그 둘레를 도는 천체다.",
    expected: full(2),
  },
  {
    ...astronomy,
    id: "negated-meaning",
    answer: "다른 천체 주위를 돌지 않는 천체다.",
    expected: { status: "confirmed", score: 0, passed: false },
  },
  {
    id: "equivalent-fraction",
    title: "수의 표현 이해",
    kind: "general",
    concept: "동등한 분수",
    material: "소수 0.5는 1/2, 2/4와 같은 값을 가진다.",
    stem: "0.5를 분수로 나타내시오.",
    modelAnswer: "1/2",
    answer: "2/4",
    rubric: [criterion("value", "0.5와 같은 값의 분수를 쓴다.", 2)],
    expected: full(2),
  },
  {
    ...output,
    id: "output-only",
    rubric: [criterion("output", "0, 1, 2를 순서대로 각각 한 줄에 쓴다.", 2)],
    expected: full(2),
  },
  {
    ...output,
    id: "unrequested-explanation",
    rubric: [
      criterion(
        "output-and-reason",
        "0, 1, 2를 순서대로 각각 한 줄에 쓰고, range가 0부터 시작하여 끝값 3을 제외하는 원리를 설명한다.",
        2,
      ),
    ],
    expected: pending,
    verifyStatuses: ["needs_review"],
  },
  {
    ...output,
    id: "requested-explanation-missing",
    stem: output.stem
      .replace("전체 출력 결과만", "전체 출력 결과를")
      .replace(
        "결과를 줄바꿈하여 쓰시오.",
        "결과를 줄바꿈하여 쓰고, 숫자 3이 출력되지 않는 이유를 설명하시오.",
      ),
    rubric: [
      criterion("output", "0, 1, 2를 순서대로 각각 한 줄에 쓴다."),
      criterion(
        "reason",
        "range의 끝값 3은 포함되지 않아 출력되지 않음을 설명한다.",
      ),
    ],
    expected: { status: "confirmed", score: 1, passed: false },
  },
  { ...units, id: "correct-unit", answer: "1,500m", expected: full(2) },
  {
    ...units,
    id: "wrong-unit",
    answer: "1500 km",
    expected: { status: "confirmed", score: 0, passed: false },
  },
  {
    id: "reordered-explanation",
    title: "사진 노출 이해",
    kind: "skill",
    concept: "조리개와 밝기",
    material:
      "셔터 속도와 감도가 같을 때 조리개 구멍이 커지면 더 많은 빛이 들어와 사진이 밝아진다.",
    stem: "셔터 속도와 감도가 같을 때 조리개 구멍을 더 크게 열면 사진의 밝기가 어떻게 변하는지와 그 이유를 설명하시오.",
    modelAnswer:
      "사진은 더 밝아진다. 구멍이 커지면 들어오는 빛의 양이 증가하기 때문이다.",
    answer: "들어오는 빛이 늘어나니까 결과 사진도 한층 밝아져요.",
    rubric: [
      criterion("brightness", "사진이 밝아진다고 설명한다."),
      criterion("light", "들어오는 빛이 증가하기 때문이라고 설명한다."),
    ],
    expected: full(2),
  },
  {
    ...historical,
    id: "historical-overstrict",
    rubric: [
      criterion(
        "output",
        "1, 확인, 3, 확인, 5, 확인, 끝을 순서대로 각각 다른 줄에 쓴다.",
        2,
      ),
      criterion(
        "inside",
        "print('확인')은 들여쓰기되어 반복문 안에 있고, range가 1, 3, 5를 제공하므로 3번 실행된다고 설명한다.",
      ),
      criterion(
        "outside",
        "print('끝')은 반복문 밖에 있어 반복 종료 후 1번 실행된다고 설명한다.",
      ),
    ],
    // Whole-answer evidence already contains 1,3,5. Full credit is valid;
    // withholding judgment on the legacy criterion is also safe, deduction isn't.
    expected: full(4),
    alternative: pending,
    verifyStatuses: ["needs_review", "usable"],
  },
  {
    ...historical,
    id: "historical-aligned",
    rubric: [
      criterion(
        "output",
        "1, 확인, 3, 확인, 5, 확인, 끝을 순서대로 각각 다른 줄에 쓴다.",
        2,
      ),
      criterion(
        "inside",
        "print('확인')이 들여쓰기되어 반복문 안에 있으므로 각 반복마다 실행됨을 설명한다.",
      ),
      criterion(
        "outside",
        "print('끝')은 반복문 밖에 있어 반복 종료 후 1번 실행된다고 설명한다.",
      ),
    ],
    expected: full(4),
  },
];
