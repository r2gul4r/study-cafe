import { useRef, useState } from "react";
import { Cpu, Check, LoaderCircle } from "lucide-react";
import { api, message, useQuery } from "./api";
import { Button, Loading, Notice } from "./ui";
import {
  ModelPicker,
  ReasoningControl,
  type SessionModel,
} from "./session-controls";

type Configuration = { model: string; effort: string };
type Settings = {
  configuration: Configuration | null;
  sessionStarted: boolean;
};

export function SessionSettings({
  goalId,
  title,
}: {
  goalId: string;
  title: string;
}) {
  const query = useQuery<Settings>(`/goals/${goalId}/agent-settings`);
  const catalog = useQuery<{ data: SessionModel[] }>("/agent/models");
  const [pending, setPending] = useState<Configuration | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const saving = useRef(false);
  const configuration = pending ??
    query.data?.configuration ?? { model: "", effort: "" };
  const models = catalog.data?.data.filter((m) => !m.hidden) ?? [];
  const selected = models.find((m) => m.model === configuration.model);
  const error = saveError || query.error || catalog.error;
  const loading = query.loading || catalog.loading;

  const save = async (next: Configuration) => {
    if (
      saving.current ||
      (next.model === query.data?.configuration?.model &&
        next.effort === query.data?.configuration?.effort)
    )
      return;
    saving.current = true;
    setPending(next);
    setSaved(false);
    setSaveError("");
    try {
      const result = await api<Settings>(
        `/goals/${goalId}/agent-settings`,
        "PUT",
        next,
      );
      query.setData(result);
      setSaved(true);
    } catch (e) {
      // A lost response can leave the commit outcome unknown. Read before
      // editing again instead of claiming the old value is still saved.
      setSaveError(`${message(e)} 저장 상태를 다시 불러와 확인해 주세요.`);
    } finally {
      setPending(null);
      saving.current = false;
    }
  };
  const reload = () => {
    setSaveError("");
    setSaved(false);
    query.reload();
    catalog.reload();
  };

  return (
    <section
      className="session-settings"
      aria-label={`${title} AI 세션`}
      aria-busy={!!pending}
    >
      <div className="session-settings-heading">
        <h3>
          <Cpu size={18} /> 이 목표의 AI 세션
        </h3>
        {!query.loading && query.data && (
          <span className="muted small">
            {query.data.sessionStarted
              ? "기존 대화 이어 사용"
              : "첫 AI 작업에서 대화 시작"}
          </span>
        )}
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <>
          <Notice>{error}</Notice>
          <Button variant="secondary" onClick={reload}>
            설정 다시 불러오기
          </Button>
        </>
      ) : (
        <>
          {!models.length && (
            <Notice>
              선택 가능한 모델이 없어요. Codex 로그인 상태를 확인해 주세요.
            </Notice>
          )}
          <div className="session-settings-fields">
            <ModelPicker
              models={models}
              value={configuration.model}
              disabled={!!pending}
              choose={(model) =>
                void save({
                  model: model.model,
                  effort: model.defaultReasoningEffort,
                })
              }
            />
            <ReasoningControl
              model={selected}
              value={configuration.effort}
              disabled={!!pending}
              choose={(effort) => void save({ ...configuration, effort })}
            />
          </div>
          <div className="session-settings-feedback">
            <span role="status" className="small">
              {pending ? (
                <>
                  <LoaderCircle size={14} className="spin" /> 저장 중…
                </>
              ) : saved ? (
                <>
                  <Check size={14} /> 저장됨 · 다음 AI 호출부터 적용
                </>
              ) : (
                "선택하면 이 목표에 자동 저장돼요."
              )}
            </span>
            <Button variant="ghost" disabled={!!pending} onClick={reload}>
              목록 새로고침
            </Button>
          </div>
        </>
      )}
      <p className="muted small">
        모델을 바꿔도 같은 목표 대화와 학습 기록을 이어가요. 진행 중인 응답은
        기존 모델로 마치고, 다음 AI 호출부터 새 설정을 사용해요.
      </p>
      <details className="session-settings-help">
        <summary>이 세션에서 처리하는 작업</summary>
        <p>
          범위 설계 · 자료 조사 · 문제 생성/추출 · 변형 · 오답 요약은 이 목표의
          전담 대화를 함께 사용해요.
        </p>
        <p>
          문항 검증 · 채점 · 재검토는 같은 모델·추론 설정으로 별도 대화에서
          처리해요.
        </p>
        <p>
          범위 설계와 자료 조사는 고정 시간 제한 없이 진행해요. 중단하려면
          에이전트 작업에서 일시정지하거나 취소할 수 있어요.
        </p>
      </details>
    </section>
  );
}
