import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, RotateCcw, Zap } from "lucide-react";

export type SessionModel = {
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  hidden?: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};

export function ModelPicker({
  models,
  value,
  disabled,
  choose,
}: {
  models: SessionModel[];
  value: string;
  disabled: boolean;
  choose: (model: SessionModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = models.find((model) => model.model === value);
  useEffect(() => {
    if (!open) return;
    const options = menu.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    const index = Math.max(
      0,
      models.findIndex((model) => model.model === value),
    );
    options?.[index]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div
      className="model-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="session-control-label" id={`${id}-label`}>
        모델
      </span>
      <button
        type="button"
        className="model-picker-trigger"
        ref={trigger}
        aria-label={`모델 선택: ${selected?.displayName ?? (value || "Codex 기본 설정")}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled || !models.length}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>
          {selected?.displayName ??
            (value ? `${value} · 목록에 없음` : "Codex 기본 설정")}
        </span>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div
          className="model-picker-menu"
          role="menu"
          aria-labelledby={`${id}-label`}
          id={id}
          ref={menu}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
              return;
            }
            const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const options = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]',
              ),
            );
            const index = options.findIndex(
              (option) => option === document.activeElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      options.length) %
                    options.length;
            options[next]?.focus();
          }}
        >
          <p className="model-picker-caption">CODEX · 사용 가능한 모델</p>
          {models.map((model) => (
            <button
              type="button"
              key={model.model}
              role="menuitemradio"
              aria-checked={value === model.model}
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                choose(model);
              }}
            >
              <span>{model.displayName}</span>
              {value === model.model && <Check size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const effortLabel = (effort: string) =>
  ({
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
    ultra: "Ultra",
  })[effort] ?? effort;

export function ReasoningControl({
  model,
  value,
  disabled,
  choose,
}: {
  model?: SessionModel;
  value: string;
  disabled: boolean;
  choose: (effort: string) => void;
}) {
  const options = model?.supportedReasoningEfforts ?? [];
  const current = options.findIndex(
    (option) => option.reasoningEffort === value,
  );
  const [draft, setDraft] = useState(Math.max(0, current));
  useEffect(() => setDraft(Math.max(0, current)), [current, model?.model]);
  const shown = options[draft];
  const id = useId();
  const commit = () => {
    if (!disabled && shown && shown.reasoningEffort !== value)
      choose(shown.reasoningEffort);
  };
  return (
    <div className="reasoning-control">
      <span className="session-control-label" id={id}>
        추론 강도
      </span>
      <div className="reasoning-card">
        <div className="reasoning-heading">
          <Zap size={17} aria-hidden="true" />
          <div>
            <strong>
              {shown ? effortLabel(shown.reasoningEffort) : "모델을 먼저 선택"}
            </strong>
            <span>{model?.displayName ?? "모델별 지원 단계"}</span>
          </div>
          <button
            type="button"
            className="reasoning-reset"
            aria-label="추론 강도를 모델 기본값으로 복원"
            title="모델 기본값으로 복원"
            disabled={
              disabled || !model || value === model.defaultReasoningEffort
            }
            onClick={() => model && choose(model.defaultReasoningEffort)}
          >
            <RotateCcw size={16} />
          </button>
        </div>
        <div
          className="reasoning-track"
          style={
            {
              "--reasoning-progress": `${options.length > 1 ? (draft / (options.length - 1)) * 100 : 0}%`,
            } as CSSProperties
          }
        >
          <div className="reasoning-dots" aria-hidden="true">
            {options.map((option) => (
              <i key={option.reasoningEffort} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(1, options.length - 1)}
            step={1}
            value={draft}
            disabled={options.length < 2}
            aria-disabled={disabled || options.length < 2}
            aria-labelledby={id}
            aria-valuetext={
              shown ? effortLabel(shown.reasoningEffort) : "모델을 먼저 선택"
            }
            onChange={(event) => {
              if (!disabled) setDraft(Number(event.target.value));
            }}
            onPointerUp={commit}
            onBlur={commit}
            onPointerCancel={() => setDraft(Math.max(0, current))}
            onKeyUp={(event) => {
              if (
                [
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                  "PageUp",
                  "PageDown",
                ].includes(event.key)
              )
                commit();
            }}
          />
        </div>
        <div className="reasoning-scale" aria-hidden="true">
          <span>{options[0] && effortLabel(options[0].reasoningEffort)}</span>
          <span>
            {options.length > 1 &&
              effortLabel(options[options.length - 1].reasoningEffort)}
          </span>
        </div>
      </div>
      {model && current < 0 && (
        <p className="small muted">
          현재 설정은 지원 목록에 없어요. 새 추론 강도를 선택해 주세요.
        </p>
      )}
    </div>
  );
}
