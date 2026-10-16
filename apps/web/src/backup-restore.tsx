import { useState } from "react";
import { StudyText } from "./study-content";
import { Action, Button, Field, Notice } from "./ui";
import { api } from "./api";
import { restoreCommands } from "./restore-commands";

export type RestorePlan = {
  id: string;
  createdAt: string;
  verifiedAt: string;
  directory: string;
  currentDataDirectory: string;
  counts: {
    goals: number;
    sources: number;
    questions: number;
    questionRevisions: number;
    exams: number;
    attempts: number;
    assets: number;
  };
};
export function BackupRestore({ id }: { id: string }) {
  const [plan, setPlan] = useState<RestorePlan>();
  const [destination, setDestination] = useState("");
  const [sourceDirectory, setSourceDirectory] = useState("");
  const [checked, setChecked] = useState(false);
  return (
    <div>
      <Action
        variant="secondary"
        run={() => api<RestorePlan>(`/backups/${id}/restore-plan`)}
        onDone={(p) => {
          setPlan(p);
          setSourceDirectory(p.directory);
          setChecked(false);
        }}
      >
        복원 전 내용 확인
      </Action>
      {plan && (
        <section className="restore-guide spaced" aria-label="백업 복원 안내">
          <div className="row between wrap">
            <h3>이 백업에 담긴 기록</h3>
            <Button variant="ghost" onClick={() => setPlan(undefined)}>
              안내 닫기
            </Button>
          </div>
          <p>
            목표 {plan.counts.goals}개 · 자료 {plan.counts.sources}개 · 문항{" "}
            {plan.counts.questions}개 ({plan.counts.questionRevisions}개 버전) ·
            시험 {plan.counts.exams}개 · 응시 {plan.counts.attempts}개 · 첨부{" "}
            {plan.counts.assets}개
          </p>
          <p className="muted small">
            백업 {new Date(plan.createdAt).toLocaleString("ko-KR")} · 무결성
            확인 {new Date(plan.verifiedAt).toLocaleString("ko-KR")}
          </p>
          <Notice tone="info">
            이 화면은 내용을 확인하고 명령을 준비해요. 실제 복원은 서버를 종료한
            뒤 프로젝트 폴더의 터미널에서 진행합니다. 다른 컴퓨터로 옮길 때는 이
            백업 폴더 전체(DB·assets·manifest.json)를 함께 복사하세요.
          </Notice>
          <p className="small">
            현재 공부방 폴더:{" "}
            <code className="path-text">{plan.currentDataDirectory}</code>
          </p>
          <Field
            label="복사한 백업 폴더 경로"
            hint="다른 컴퓨터에서는 복사해 둔 위치로 바꾸세요."
          >
            <input
              value={sourceDirectory}
              onChange={(e) => {
                setSourceDirectory(e.target.value);
                setChecked(false);
              }}
            />
          </Field>
          <Field
            label="복원할 새 데이터 폴더 경로"
            hint="기존 공부방과 다른 새 폴더를 권장해요. 이 화면은 해당 경로의 존재 여부를 검사하지 않습니다."
          >
            <input
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                setChecked(false);
              }}
              placeholder="예: C:\study-cafe-restored"
            />
          </Field>
          <label className="row">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            서버 종료가 필요하며, 복원은 기록 병합이 아니라 선택한 백업으로
            교체하는 과정임을 확인했어요.
          </label>
          <p className="muted small">
            기존 대상 DB가 있으면 CLI가 교체 전 백업을 만듭니다. 앱 세션 토큰과
            Codex 로그인은 백업에 없으므로 새 컴퓨터에서 다시 연결하세요.
          </p>
          {checked && sourceDirectory.trim() && destination.trim() && (
            <>
              <h4>PowerShell에서 실행할 명령</h4>
              <StudyText
                text={`\`\`\`powershell\n${restoreCommands(sourceDirectory, destination)}\n\`\`\``}
              />
              <p className="muted small">
                복원 후 서버를 시작하면 자동으로 열린 브라우저에서 공부방 기록을
                확인할 수 있어요. 복원 시점에 무결성을 다시 검사합니다.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
