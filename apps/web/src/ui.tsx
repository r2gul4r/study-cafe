import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  LoaderCircle,
  Plus,
  X,
  Inbox,
  AlertCircle,
} from "lucide-react";
import { label } from "./types";
import { message } from "./api";
export function Button({
  children,
  variant = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button {...props} className={`button ${variant} ${props.className ?? ""}`}>
      {children}
    </button>
  );
}
export function Badge({
  value,
  children,
}: {
  value?: string;
  children?: ReactNode;
}) {
  return (
    <span className={`badge ${value ?? ""}`}>
      {children ?? label(value ?? "")}
    </span>
  );
}
export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={25} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Notice({
  children,
  tone = "error",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertCircle size={18} />
      <div>{children}</div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={20} /> 불러오는 중…
    </div>
  );
}
export function Field({
  label: caption,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{caption}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Action({
  children,
  run,
  variant = "",
  onDone,
  className,
  disabled,
}: {
  children: ReactNode;
  run: () => Promise<any>;
  variant?: string;
  onDone?: (v: any) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className={`action ${className ?? ""}`}>
      <Button
        variant={variant}
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const result = await run();
            onDone?.(result);
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <LoaderCircle size={16} className="spin" /> : null}
        {children}
      </Button>
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
export function SubmitForm({
  children,
  onSubmit,
  submit = "저장",
  submitVariant = "",
  onDone,
}: {
  children: ReactNode;
  onSubmit: (f: FormData) => Promise<any>;
  submit?: string;
  submitVariant?: string;
  onDone?: (v: any) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="form"
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        try {
          const result = await onSubmit(data);
          onDone?.(result);
        } catch (err) {
          setError(message(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && <Notice>{error}</Notice>}
      <div className="form-footer">
        <Button disabled={busy} variant={submitVariant}>
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Check size={16} />
          )}{" "}
          {submit}
        </Button>
      </div>
    </form>
  );
}
export function Select({
  options,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { options: string[] }) {
  return (
    <select {...props}>
      {options.map((v) => (
        <option key={v} value={v}>
          {label(v)}
        </option>
      ))}
    </select>
  );
}
export { ArrowRight, ChevronRight, Plus };
