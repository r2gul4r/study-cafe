import { useState } from "react";
import { Action, Notice } from "./ui";
import { api } from "./api";
import type { Question } from "./types";
type Run = {
  name: string;
  status: string;
  stdout?: string;
  stderr?: string;
  hidden?: boolean;
};
const names: Record<string, string> = {
  passed: "통과",
  wrong_output: "출력 불일치",
  runtime_error: "실행 오류",
  timeout: "시간 초과",
  output_limit: "출력 제한",
};
export function PythonResults({ runs }: { runs: Run[] }) {
  return (
    <div className="spaced">
      {runs.map((r, i) => (
        <details key={i}>
          <summary>
            {r.name} · {names[r.status] ?? r.status}
            {r.hidden ? " · 비공개 테스트" : ""}
          </summary>
          {!r.hidden && (
            <>
              {r.stdout && <pre className="pre-wrap">{r.stdout}</pre>}
              {r.stderr && <pre className="pre-wrap">{r.stderr}</pre>}
              {!r.stdout && !r.stderr && <p>출력 없음</p>}
            </>
          )}
        </details>
      ))}
    </div>
  );
}
export function PythonPanel({
  question,
  attemptId,
  code,
  disabled,
}: {
  question: Question & { slot: number };
  attemptId: string;
  code: string;
  disabled: boolean;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  if (!question.python) return null;
  return (
    <div>
      <Notice tone="info">
        Python 표준입출력 문제 · 테스트별 동일 배점 · 실행 제한{" "}
        {question.python.timeoutMs / 1000}초. 파일·네트워크·추가 패키지는 사용할
        수 없어요.
      </Notice>
      {question.python.tests
        .filter((t) => !t.hidden)
        .map((t, i) => (
          <details key={i}>
            <summary>예제: {t.name}</summary>
            <strong>입력</strong>
            <pre>{t.stdin || "없음"}</pre>
            <strong>예상 출력</strong>
            <pre>{t.stdout}</pre>
          </details>
        ))}
      <Action
        variant="secondary"
        disabled={disabled || !code.trim()}
        run={() =>
          api<Run[]>(`/attempts/${attemptId}/python/${question.slot}`, "POST", {
            code,
          })
        }
        onDone={setRuns}
      >
        예제 실행
      </Action>
      <PythonResults runs={runs} />
    </div>
  );
}
