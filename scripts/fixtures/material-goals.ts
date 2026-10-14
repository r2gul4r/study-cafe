// Evaluation data only: the application has no branches for these subjects.
export const materialGoals = [
  {
    id: "astronomy",
    kind: "general" as const,
    title: "달의 모양이 바뀌는 이유 이해하기",
    concept: "달의 위상",
    area: "천문",
    references: [
      "https://science.nasa.gov/moon/moon-phases/",
      "https://aa.usno.navy.mil/faq/moon_phases",
    ],
    detail:
      "달의 위상이 생기는 원리와 변화 순서만 다룹니다. NASA 또는 USNO의 설명 본문을 우선합니다. 삽화·사진은 이번 수집과 출제 대상에서 제외합니다.",
    paper:
      "검증 연습판 2026-A2\n1번. 상현달 이후 보름달에 이르기까지 지구에서 보이는 달의 밝은 부분은 어떻게 변하는가?\na. 점점 커진다.\nb. 점점 작아진다.",
    answers:
      "검증 연습판 2026-A2\n1번 정답: a. 상현달에서 보름달로 갈수록 밝은 부분이 커진다.",
    expectedAnswer: "점점 커진다.",
  },
  {
    id: "css",
    kind: "skill" as const,
    title: "CSS 박스 크기와 여백을 설명하고 계산하기",
    concept: "CSS box model",
    area: "웹 화면 구현",
    references: [
      "https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics/Box_model",
    ],
    detail:
      "content, padding, border, margin과 box-sizing의 관계를 다룹니다. MDN 설명 본문을 우선합니다.",
    paper:
      "검증 연습판 2026-B\n1번. CSS 박스의 테두리 바깥 여백을 지정하는 속성은?\na. margin\nb. padding",
    answers: "검증 연습판 2026-B\n1번 정답: a. margin은 테두리 바깥 여백이다.",
    expectedAnswer: "margin",
  },
  {
    id: "statistics",
    kind: "exam" as const,
    title: "기초 통계 자료 해석 평가 준비",
    concept: "평균과 중앙값",
    area: "기초 통계",
    references: [
      "https://openstax.org/books/introductory-statistics-2e/pages/2-5-measures-of-the-center-of-the-data",
    ],
    detail:
      "특정 자격시험이 아닌 개인 학습 평가입니다. 시험 기관이나 실제 기출을 지어내지 마세요. 평균과 중앙값 계산 및 이상값의 영향을 다룹니다. OpenStax의 설명 본문을 우선합니다.",
    paper: "검증 연습판 2026-C\n1번. 자료 2, 4, 9의 중앙값은?\na. 4\nb. 5",
    answers: "검증 연습판 2026-C\n1번 정답: a. 정렬된 세 값 가운데는 4이다.",
    expectedAnswer: "4",
  },
];
