import { useState } from "react";
import { Archive, RotateCcw, Pencil, Trash2 } from "lucide-react";
import { api, useQuery } from "./api";
import {
  Action,
  Button,
  Loading,
  Modal,
  Notice,
  SubmitForm,
} from "./ui";
import type { Goal } from "./types";

export function GoalActions({
  goal,
  close,
  edit,
  changed,
}: {
  goal: Goal;
  close: () => void;
  edit: () => void;
  changed: () => void;
}) {
  const [mode, setMode] = useState<"menu" | "archive" | "delete">("menu");
  return (
    <Modal
      title={
        mode === "delete"
          ? "목표 영구 삭제"
          : mode === "archive"
            ? "목표 보관"
            : "목표 관리"
      }
      onClose={close}
    >
      <div className="modal-body">
        <p className="goal-action-title">{goal.title}</p>
        {mode === "menu" && (
          <div className="goal-action-list">
            <Button variant="secondary" onClick={edit}>
              <Pencil size={17} /> 목표 수정
            </Button>
            {goal.archived ? (
              <Action
                variant="secondary"
                run={() =>
                  api(`/goals/${goal.id}/archive`, "POST", { archived: false })
                }
                onDone={changed}
              >
                <RotateCcw size={17} /> 목표 복원
              </Action>
            ) : (
              <Button variant="secondary" onClick={() => setMode("archive")}>
                <Archive size={17} /> 목표 보관
              </Button>
            )}
            <Button variant="danger" onClick={() => setMode("delete")}>
              <Trash2 size={17} /> 영구 삭제
            </Button>
          </div>
        )}
        {mode === "archive" && (
          <>
            <Notice tone="info">
              학습 기록을 유지하면서 공부 중인 목록에서 숨깁니다. 보관함에서
              언제든 복원할 수 있어요. 이미 시작한 에이전트 작업은 계속
              진행됩니다.
            </Notice>
            <div className="row wrap spaced">
              <Button variant="secondary" onClick={close}>
                취소
              </Button>
              <Action
                run={() =>
                  api(`/goals/${goal.id}/archive`, "POST", { archived: true })
                }
                onDone={changed}
              >
                보관하기
              </Action>
            </div>
          </>
        )}
        {mode === "delete" && (
          <DeleteGoal goal={goal} changed={changed} close={close} />
        )}
      </div>
    </Modal>
  );
}

function DeleteGoal({
  goal,
  changed,
  close,
}: {
  goal: Goal;
  changed: () => void;
  close: () => void;
}) {
  const preview = useQuery<{
    title: string;
    counts: Record<string, number>;
    blocked: boolean;
    confirmation: string;
  }>(`/goals/${goal.id}/deletion-preview`);
  if (preview.loading) return <Loading />;
  if (preview.error || !preview.data)
    return (
      <Notice>
        {preview.error || "삭제 범위를 불러올 수 없어요."}
        <Button variant="secondary" onClick={preview.reload}>
          다시 확인
        </Button>
      </Notice>
    );
  const data = preview.data;
  return (
    <>
      <Notice>
        목표와 아래 학습 기록을 영구 삭제합니다. 이 작업은 되돌릴 수 없어요.
      </Notice>
      <dl className="goal-delete-counts">
        {Object.entries({
          sources: "학습 자료",
          questions: "문제 (수정 이력 포함)",
          exams: "시험",
          attempts: "응시 (답안·채점 포함)",
          notes: "오답 노트",
          reviews: "복습 일정",
          jobs: "에이전트 작업 기록",
        }).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{data.counts[key]}개</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">
        학습 범위·개념·복습 이력도 함께 삭제됩니다. 공용 첨부파일, 시험 템플릿,
        기존 백업은 유지됩니다.
      </p>
      {data.blocked ? (
        <Notice>
          대기·실행 중인 작업이 있어요. 에이전트 작업 화면에서 완료되기를
          기다리거나 취소한 뒤 다시 확인해 주세요.
          <Button variant="secondary" onClick={preview.reload}>
            다시 확인
          </Button>
        </Notice>
      ) : (
        <SubmitForm
          submit="목표와 기록 영구 삭제"
          submitVariant="danger"
          onSubmit={() =>
            api(`/goals/${goal.id}`, "DELETE", {
              title: data.title,
              confirmation: data.confirmation,
            })
          }
          onDone={changed}
        >
          <Button type="button" variant="secondary" onClick={close}>
            취소
          </Button>
        </SubmitForm>
      )}
    </>
  );
}
