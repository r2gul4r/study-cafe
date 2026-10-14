import test from "node:test";
import assert from "node:assert/strict";
import { studyBlocks, studyInline } from "../apps/web/src/study-text.js";

test("fenced study code preserves indentation, blank lines, HTML and nested shorter fences", () => {
  const content =
    "설명\r\n\r\n````python\r\nfor n in range(3):\r\n    print('<script>alert(1)</script>')\r\n\r\n```\r\n````\r\n끝";
  const blocks = studyBlocks(content);
  assert.equal(blocks[1]?.language, "python");
  assert.equal(
    blocks[1]?.content,
    "for n in range(3):\n    print('<script>alert(1)</script>')\n\n```",
  );
  assert.equal(blocks[2]?.content, "끝");
  assert.deepEqual(studyBlocks("~~~js\n  x < 2\n~~~"), [
    { kind: "code", content: "  x < 2", language: "js" },
  ]);
  assert.equal(
    studyBlocks("```python\n    incomplete")[0]?.content,
    "    incomplete",
  );
  assert.deepEqual(studyBlocks("일반 독해 지문\n  두 번째 줄"), [
    { kind: "text", content: "일반 독해 지문\n  두 번째 줄" },
  ]);
});

test("note IDs resolve only in prose; unknown IDs have no guessed links and code stays exact", () => {
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const ref = { label: "3번 문항", href: "#/result/known?slot=3" };
  assert.deepEqual(studyInline(id, { [id]: [ref] }), [
    { text: "참고 기록", references: [ref] },
  ]);
  assert.deepEqual(studyInline(id, {}), [
    { text: "참고 기록", references: [] },
  ]);
  assert.deepEqual(studyInline(id), [{ text: id }]);
  assert.deepEqual(studyInline(`문항 ${id}`, { [id]: [ref] }), [
    { text: "참고 기록", references: [ref] },
  ]);
  assert.deepEqual(studyInline(`segmentId ${id}`, { [id]: [ref] }), [
    { text: "참고 기록", references: [ref] },
  ]);
  assert.deepEqual(studyInline(`\`${id}\``, {}), [{ text: id, code: true }]);
  assert.equal(
    studyInline("<img src=x onerror=alert(1)>")[0]?.text,
    "<img src=x onerror=alert(1)>",
  );
});
