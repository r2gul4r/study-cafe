// HTML text extraction inserts line breaks around links and inline elements.
// Ignore only whitespace differences; never fuzzy-match or paraphrase a quote.
export function containsVerbatimQuote(text: string, quote: string) {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const expected = normalize(quote);
  return expected.length > 0 && normalize(text).includes(expected);
}
