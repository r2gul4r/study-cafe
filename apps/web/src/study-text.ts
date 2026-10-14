export type StudyBlock = {
  kind: "text" | "code";
  content: string;
  language?: string;
};
export type TextReference = { label: string; href: string };
export type TextReferences = Record<string, TextReference[]>;

// Deliberately supports fenced code and inline code, not executable HTML/Markdown.
export function studyBlocks(text: string): StudyBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: StudyBlock[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) blocks.push({ kind: "text", content: prose.join("\n") });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i]!.match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
    if (!opening) {
      prose.push(lines[i]!);
      continue;
    }
    flush();
    const fence = opening[1]!;
    const code: string[] = [];
    while (++i < lines.length) {
      const close = lines[i]!.trim();
      if (
        close.length >= fence.length &&
        [...close].every((c) => c === fence[0])
      )
        break;
      code.push(lines[i]!);
    }
    const language = opening[2]!.trim().split(/\s/)[0];
    blocks.push({
      kind: "code",
      content: code.join("\n"),
      language:
        language && /^[\w+#.-]{1,30}$/.test(language) ? language : undefined,
    });
  }
  flush();
  return blocks;
}

export type InlinePart = {
  text: string;
  code?: boolean;
  references?: TextReference[];
};
export function studyInline(
  text: string,
  references?: TextReferences,
): InlinePart[] {
  const parts: InlinePart[] = [];
  // Only note prose resolves IDs. Code and ordinary learning content stay literal.
  const pattern =
    /(`+)([^\n]*?)\1|(?:segmentId\s*[:=]?\s*|문항\s+)?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > end) parts.push({ text: text.slice(end, match.index) });
    if (match[1]) parts.push({ text: match[2]!, code: true });
    else if (references)
      parts.push({
        text: "참고 기록",
        references: references[match[3]!] ?? [],
      });
    else parts.push({ text: match[0] });
    end = match.index! + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}
