import { Fragment } from "react";
import { studyBlocks, studyInline, type TextReferences } from "./study-text";

export function StudyText({
  text,
  className = "",
  references,
  readable = false,
  headingLevel,
}: {
  text: string;
  className?: string;
  references?: TextReferences;
  readable?: boolean;
  headingLevel?: "h2" | "h3";
}) {
  const inline = (value: string) =>
    studyInline(value, references).map((part, i) =>
      part.code ? (
        <code className="inline-code" key={i}>
          {part.text}
        </code>
      ) : part.references ? (
        <Fragment key={i}>
          {part.references.length
            ? part.references.map((ref, j) => (
                <Fragment key={ref.href}>
                  {j > 0 && " / "}
                  <a className="text-link" href={ref.href}>
                    {ref.label}
                  </a>
                </Fragment>
              ))
            : part.text}
        </Fragment>
      ) : (
        <Fragment key={i}>{part.text}</Fragment>
      ),
    );
  return (
    <div className={`study-text ${className}`}>
      {studyBlocks(text).map((block, i) =>
        block.kind === "code" ? (
          <div className="code-block" key={i}>
            <div className="code-language">{block.language || "코드"}</div>
            <pre
              tabIndex={0}
              aria-label={`${block.language || "텍스트"} 코드 블록`}
            >
              <code>{block.content}</code>
            </pre>
          </div>
        ) : (
          block.content
            .split(/\n\s*\n/)
            .filter((p) => p.trim())
            .flatMap((paragraph, p) => {
              const sentences =
                readable && !paragraph.includes("`")
                  ? paragraph.split(/(?<=[.!?。])\s+(?=\S)/)
                  : [paragraph];
              const groups: string[] = [];
              for (let s = 0; s < sentences.length; s += 2)
                groups.push(sentences.slice(s, s + 2).join(" "));
              return groups.map((group, g) => {
                const Tag =
                  i === 0 && p === 0 && g === 0 && headingLevel
                    ? headingLevel
                    : "p";
                return <Tag key={`${i}-${p}-${g}`}>{inline(group)}</Tag>;
              });
            })
        ),
      )}
    </div>
  );
}
