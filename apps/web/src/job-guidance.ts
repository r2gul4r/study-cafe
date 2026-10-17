type ErrorInfo = { code?: string; details?: { code?: string } | string };
export function jobGuidance(error: ErrorInfo | null) {
  const code =
    typeof error?.details === "object"
      ? (error.details.code ?? error.code)
      : error?.code;
  if (["CODEX_RATE_LIMITED", "CODEX_USAGE_LIMIT"].includes(code ?? ""))
    return {
      text: "Codex 사용 한도에 도달했어요. 한도 회복 후 ‘다시 진행’을 누르면 완료된 단계는 반복하지 않고 이어가요.",
      href: "/settings",
      label: "연결 상태 확인",
      restart: false,
    };
  if (code === "CODEX_AUTH_REQUIRED")
    return {
      text: "Codex에 다시 로그인한 뒤 이 작업을 재개하세요. 저장된 학습 기록과 완료 단계는 유지돼요.",
      href: "/settings",
      label: "Codex 연결",
      restart: false,
    };
  if (code === "PYTHON_RUNTIME")
    return {
      text: "실행기 설치가 필요해 채점을 보류했어요. 실행기를 준비하고 다시 진행하면 돼요. 실패한 실행 환경 때문에 0점을 주지 않아요.",
      href: "/settings",
      label: "실행 환경 확인",
      restart: false,
    };
  if (code === "REVIEW_COUNT")
    return {
      text: "오늘 남은 실제 복습 문항 수로 다시 구성하세요. 같은 문제를 늘려서 회차를 채우지 않아요.",
      href: "/reviews",
      label: "오늘 복습으로 이동",
      restart: true,
    };
  if (code && /SOURCE_CHANGED|SCOPE_CHANGED/.test(code))
    return {
      text: "작업 도중 자료나 범위 버전이 바뀌었어요. 기존 결과는 남기고 자료 화면에서 새 추출을 시작하세요.",
      href: "/sources",
      label: "자료에서 새 작업 시작",
      restart: true,
    };
  if (code && /REVIEW|QUESTION_REJECTED/.test(code))
    return {
      text: "문항의 원문·정답·검토 사유를 확인하세요. 수정한 문항을 다시 검증한 뒤 작업을 재개할 수 있어요.",
      href: "/bank",
      label: "문제은행에서 검토",
      restart: false,
    };
  if (code && /SOURCE|MATERIAL|INSUFFICIENT|OCR|PDF|IMAGE|LINK_ONLY/.test(code))
    return {
      text: "필요한 자료·정답표·페이지가 부족하거나 읽지 못했어요. 자료 화면에서 원본과 이용 근거를 확인하고 부족한 자료를 보충하세요.",
      href: "/sources",
      label: "자료 확인·추가",
      restart: false,
    };
  return {
    text: "연결과 오류 내용을 확인한 뒤 다시 진행하세요. 이미 완료한 단계와 저장한 답안은 유지돼요.",
    href: "/settings",
    label: "연결 상태 확인",
    restart: false,
  };
}
