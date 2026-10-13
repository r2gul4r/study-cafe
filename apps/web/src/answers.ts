import { useEffect, useRef, useState } from "react";
import { api, ApiError, message } from "./api";
import type { Answer, Attempt } from "./types";
type Draft = Answer & {
  dirty?: boolean;
  error?: string;
  conflict?: Answer;
  sequence?: number;
};
export function useAnswers(attempt: Attempt) {
  const [, render] = useState(0),
    drafts = useRef<Record<number, Draft>>({}),
    timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({}),
    tasks = useRef(new Map<number, Promise<void>>());
  const storageKey = "study-cafe-drafts:" + attempt.id;
  const update = () => {
    sessionStorage.setItem(storageKey, JSON.stringify(drafts.current));
    render((n) => n + 1);
  };
  useEffect(() => {
    let saved: Record<number, Draft> = {};
    try {
      saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
    } catch {}
    for (const item of attempt.exam.items) {
      const server = attempt.answers.find((a) => a.slot === item.slot) ?? {
        slot: item.slot,
        version: 0,
        value: item.type === "short" ? "" : [],
        flagged: false,
        uncertain: false,
        hintUsed: false,
        recall: null,
      };
      const local = saved[item.slot];
      drafts.current[item.slot] = local?.dirty
        ? {
            ...local,
            conflict: local.version !== server.version ? server : undefined,
          }
        : server;
    }
    update();
    if (attempt.status === "active") {
      for (const draft of Object.values(drafts.current)) {
        if (draft.dirty && !draft.conflict)
          timers.current[draft.slot] = setTimeout(
            () => void save(draft.slot),
            600,
          );
      }
    }
    return () => {
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, [attempt.id]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (Object.values(drafts.current).some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    addEventListener("beforeunload", guard);
    return () => removeEventListener("beforeunload", guard);
  }, []);
  async function save(slot: number): Promise<void> {
    const existing = tasks.current.get(slot);
    if (existing) {
      await existing;
      return save(slot);
    }
    const draft = drafts.current[slot];
    if (!draft?.dirty || draft.conflict) return;
    const sequence = draft.sequence;
    const task = (async () => {
      try {
        const { value, version, flagged, uncertain, hintUsed, recall } = draft;
        const result = await api<Answer>(
          `/attempts/${attempt.id}/answers/${slot}`,
          "PUT",
          { value, version, flagged, uncertain, hintUsed, recall },
        );
        const latest = drafts.current[slot];
        drafts.current[slot] = {
          ...latest,
          version: result.version,
          dirty: latest.sequence !== sequence,
          error: undefined,
        };
      } catch (e) {
        if (e instanceof ApiError && e.code === "ANSWER_CONFLICT") {
          try {
            const current = await api<Attempt>(`/attempts/${attempt.id}`);
            drafts.current[slot].conflict = current.answers.find(
              (a) => a.slot === slot,
            );
          } catch {
            drafts.current[slot].error =
              "답안 충돌을 확인하지 못했어요. 연결 후 저장을 다시 시도해 주세요.";
            return;
          }
        }
        drafts.current[slot].error = message(e);
      } finally {
        tasks.current.delete(slot);
        update();
      }
    })();
    tasks.current.set(slot, task);
    await task;
    if (
      drafts.current[slot]?.dirty &&
      !drafts.current[slot].error &&
      !drafts.current[slot].conflict
    )
      await save(slot);
  }
  function change(slot: number, patch: Partial<Answer>) {
    const old = drafts.current[slot];
    if (!old) return;
    drafts.current[slot] = {
      ...old,
      ...patch,
      dirty: true,
      error: undefined,
      sequence: (old.sequence ?? 0) + 1,
    };
    update();
    clearTimeout(timers.current[slot]);
    timers.current[slot] = setTimeout(() => void save(slot), 600);
  }
  async function flush() {
    Object.values(timers.current).forEach(clearTimeout);
    await Promise.all([...tasks.current.values()]);
    for (const draft of Object.values(drafts.current))
      if (draft.dirty) await save(draft.slot);
    if (Object.values(drafts.current).some((d) => d.dirty || d.conflict))
      throw new Error(
        "저장되지 않은 답안이 있습니다. 연결 또는 답안 충돌을 확인해 주세요.",
      );
  }
  function resolve(slot: number, keepLocal: boolean) {
    const local = drafts.current[slot],
      server = local.conflict;
    if (!server) return;
    drafts.current[slot] = keepLocal
      ? {
          ...local,
          version: server.version,
          conflict: undefined,
          error: undefined,
          dirty: true,
        }
      : { ...server, dirty: false };
    update();
    if (keepLocal) void save(slot);
  }
  return {
    drafts: drafts.current,
    change,
    flush,
    resolve,
    retry: () => flush(),
    dirty: Object.values(drafts.current).some((d) => d.dirty),
  };
}
