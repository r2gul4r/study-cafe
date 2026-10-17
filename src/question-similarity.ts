export function nearDuplicate(a: string, b: string) {
  const clean = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\d+(?:\.\d+)?/g, "#")
      .replace(/\s+/g, " ")
      .trim();
  const left = clean(a),
    right = clean(b);
  if (Math.min(left.length, right.length) < 80) return false;
  const grams = (s: string) =>
    new Set(Array.from({ length: s.length - 2 }, (_, i) => s.slice(i, i + 3)));
  const x = grams(left),
    y = grams(right);
  const overlap = [...x].filter((g) => y.has(g)).length;
  return (2 * overlap) / (x.size + y.size) >= 0.94;
}
