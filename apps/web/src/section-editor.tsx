import { Button, Field } from "./ui";
import type { ExamSection, Concept } from "./types";
export function SectionEditor({
  value,
  change,
  concepts,
}: {
  value: ExamSection[];
  change: (value: ExamSection[]) => void;
  concepts: Concept[];
}) {
  const update = (i: number, patch: Partial<ExamSection>) =>
    change(value.map((v, j) => (i === j ? { ...v, ...patch } : v)));
  return (
    <details className="spaced">
      <summary>섹션별 진행 설정 (선택)</summary>
      <p className="small muted">
        섹션을 끝내면 이전 답안을 수정할 수 없어요. 각 섹션 시간이 끝나면 다음
        섹션으로 넘어가며 마지막에는 자동 제출돼요.
      </p>
      {value.map((s, i) => (
        <div key={i} className="panel spaced">
          <div className="form-grid thirds">
            <Field label={`${i + 1}섹션 이름`}>
              <input
                value={s.title}
                required
                onChange={(e) => update(i, { title: e.target.value })}
              />
            </Field>
            <Field label="문항 수">
              <input
                type="number"
                min={1}
                value={s.count}
                onChange={(e) => update(i, { count: Number(e.target.value) })}
              />
            </Field>
            <Field label="섹션 시간 (분)">
              <input
                type="number"
                min={1}
                value={s.minutes}
                onChange={(e) => update(i, { minutes: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="출제 개념 (미선택 시 전체)">
            <select
              multiple
              value={s.conceptIds}
              onChange={(e) =>
                update(i, {
                  conceptIds: [...e.target.selectedOptions].map((o) => o.value),
                })
              }
            >
              {concepts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Button
            type="button"
            variant="ghost"
            onClick={() => change(value.filter((_, j) => j !== i))}
          >
            섹션 삭제
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        disabled={value.length >= 10}
        onClick={() =>
          change([
            ...value,
            {
              title: `${value.length + 1}섹션`,
              count: 1,
              minutes: 10,
              conceptIds: [],
            },
          ])
        }
      >
        섹션 추가
      </Button>
      {!!value.length && (
        <p>
          합계 {value.reduce((n, s) => n + s.count, 0)}문항 ·{" "}
          {value.reduce((n, s) => n + s.minutes, 0)}분
        </p>
      )}
    </details>
  );
}
