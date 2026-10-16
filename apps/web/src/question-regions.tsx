import { useEffect, useRef, useState } from "react";
import { api, browserHeaders } from "./api";
import { Button, Field, Notice, SubmitForm } from "./ui";
import type { Question } from "./types";

type Bounds = { x: number; y: number; width: number; height: number };
const full: Bounds = { x: 0, y: 0, width: 1, height: 1 };
const round = (n: number) => Math.round(n * 10000) / 10000;

function RegionPage({
  assetId,
  value,
  onChange,
  index,
}: {
  assetId: string;
  value: Bounds;
  onChange: (b: Bounds) => void;
  index: number;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const start = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let active = true,
      objectUrl = "";
    const controller = new AbortController();
    void fetch(`/api/assets/${encodeURIComponent(assetId)}`, {
      signal: controller.signal,
      headers: browserHeaders(),
    })
      .then(async (res) => {
        if (!res.ok)
          throw new Error(
            "원본 페이지를 불러오지 못했어요. 창을 닫고 다시 시도해 주세요.",
          );
        const blob = await res.blob();
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch((e) => {
        if (active && e.name !== "AbortError") setError(e.message);
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);
  const position = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };
  return (
    <section className="region-page">
      <h4>문제 원본 {index + 1}</h4>
      {error && <Notice>{error}</Notice>}
      {url && (
        <div
          className="region-canvas"
          tabIndex={0}
          aria-label={`문제 원본 ${index + 1}에서 드래그하여 표시 영역 선택`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.focus({ preventScroll: true });
            start.current = position(e);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            const end = position(e),
              a = start.current;
            const x = round(Math.min(a.x, end.x)),
              y = round(Math.min(a.y, end.y));
            const width = round(Math.abs(a.x - end.x)),
              height = round(Math.abs(a.y - end.y));
            if (width >= 0.01 && height >= 0.01)
              onChange({
                x,
                y,
                width: Math.min(width, round(1 - x)),
                height: Math.min(height, round(1 - y)),
              });
          }}
          onPointerUp={() => {
            start.current = null;
          }}
          onPointerCancel={() => {
            start.current = null;
          }}
        >
          <img
            src={url}
            alt={`문제 원본 ${index + 1}. 아래 백분율 입력으로도 영역을 지정할 수 있어요.`}
            draggable={false}
          />
          <div
            className="region-selection"
            style={{
              left: `${value.x * 100}%`,
              top: `${value.y * 100}%`,
              width: `${value.width * 100}%`,
              height: `${value.height * 100}%`,
            }}
          />
        </div>
      )}
      <div className="region-fields">
        {(
          [
            ["x", "왼쪽"],
            ["y", "위쪽"],
            ["width", "너비"],
            ["height", "높이"],
          ] as const
        ).map(([key, title]) => (
          <Field key={key} label={`${title} (%)`}>
            <input
              type="number"
              min={key === "x" || key === "y" ? 0 : 1}
              max={100}
              step="0.01"
              required
              value={Math.round(value[key] * 10000) / 100}
              onChange={(e) =>
                onChange({ ...value, [key]: Number(e.target.value) / 100 })
              }
            />
          </Field>
        ))}
      </div>
      <Button type="button" variant="ghost" onClick={() => onChange(full)}>
        이 페이지 전체 표시
      </Button>
    </section>
  );
}

export function QuestionRegions({
  question,
  onSaved,
}: {
  question: Question;
  onSaved: (q: Question) => void;
}) {
  const pages = [
    ...new Map(
      (question.visualEvidence ?? [])
        .filter((v) => v.role === "question")
        .map((v) => [v.assetId, v]),
    ).values(),
  ];
  const [bounds, setBounds] = useState<Record<string, Bounds>>(() =>
    Object.fromEntries(
      pages.map((v) => [
        v.assetId,
        question.learnerRegions?.find((r) => r.sourceAssetId === v.assetId)
          ?.bounds ?? full,
      ]),
    ),
  );
  return (
    <details className="spaced">
      <summary>PDF 문제 표시 영역 설정</summary>
      <Notice tone="info">
        원본에서 문제·공통 지문·그래프·보기를 빠짐없이 선택하세요. 드래그하거나
        백분율을 입력할 수 있어요. 저장하면 새 버전이 검토 대기가 됩니다. 원본
        근거와 기존 시험은 유지됩니다.
      </Notice>
      <SubmitForm
        submit="표시 영역을 새 버전으로 저장"
        onSubmit={() => {
          const regions = pages.flatMap((v) => {
            const b = bounds[v.assetId]!;
            if (
              Object.values(b).some((n) => !Number.isFinite(n)) ||
              b.x < 0 ||
              b.y < 0 ||
              b.width < 0.01 ||
              b.height < 0.01 ||
              b.x + b.width > 1 ||
              b.y + b.height > 1
            )
              throw new Error(
                "선택 영역이 페이지 안에 있도록 위치와 크기를 확인하세요.",
              );
            return b.x === 0 && b.y === 0 && b.width === 1 && b.height === 1
              ? []
              : [{ segmentId: v.segmentId, bounds: b }];
          });
          return api<Question>(`/questions/${question.id}/regions`, "POST", {
            expectedRevisionId: question.revisionId,
            regions,
          });
        }}
        onDone={onSaved}
      >
        {pages.map((v, i) => (
          <RegionPage
            key={v.assetId}
            assetId={v.assetId}
            value={bounds[v.assetId]!}
            index={i}
            onChange={(b) => setBounds((old) => ({ ...old, [v.assetId]: b }))}
          />
        ))}
      </SubmitForm>
    </details>
  );
}
