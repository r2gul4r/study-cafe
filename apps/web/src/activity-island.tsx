import { useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  LoaderCircle,
  Workflow,
} from "lucide-react";
import { go } from "./api";
import { label, type Job } from "./types";

// Original implementation of SmoothUI's expandable status-pill pattern.
// Only server-reported jobs are shown; opening this never starts an agent.
export function ActivityIsland({
  jobs,
  error,
  loading,
}: {
  jobs: Job[];
  error?: string;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = jobs.filter((job) =>
    ["queued", "running"].includes(job.status),
  );
  const waiting = jobs.filter((job) =>
    ["waiting_user", "failed"].includes(job.status),
  );
  const relevant = [...active, ...waiting].slice(0, 4);
  const title = error
    ? "작업 상태 연결 확인"
    : loading
      ? "작업 상태 확인 중"
      : active.length
        ? `${active.length}개 작업 진행 중`
        : waiting.length
          ? `${waiting.length}개 작업 확인 필요`
          : "지금은 공부에 집중할 시간";
  return (
    <div className={`activity-island ${open ? "expanded" : ""}`}>
      <button
        className="activity-trigger"
        aria-expanded={open}
        aria-controls="activity-details"
        onClick={() => setOpen(!open)}
      >
        {error || waiting.length ? (
          <AlertCircle size={17} />
        ) : active.length || loading ? (
          <LoaderCircle size={17} className="spin" />
        ) : (
          <CheckCircle2 size={17} />
        )}
        <span>{title}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div id="activity-details" className="activity-details">
          <p>
            {error ||
              (relevant.length
                ? "요청한 작업의 현재 상태예요."
                : "진행 중이거나 확인할 작업이 없어요.")}
          </p>
          {relevant.map((job) => (
            <div className="activity-job" key={job.id}>
              <span>{label(job.kind)}</span>
              <span>{label(job.status)}</span>
            </div>
          ))}
          <button
            className="activity-link"
            onClick={() => {
              setOpen(false);
              go("/jobs");
            }}
          >
            <Workflow size={15} /> 전체 작업 보기
          </button>
        </div>
      )}
    </div>
  );
}
