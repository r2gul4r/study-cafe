import test from "node:test";
import assert from "node:assert/strict";
import { containsVerbatimQuote } from "../src/evidence.js";
test("permission evidence tolerates only whitespace, not paraphrases or missing restrictions", () => {
  assert.equal(
    containsVerbatimQuote(
      "Documentation is licensed under the\nPSF License.",
      "Documentation is licensed under the PSF License.",
    ),
    true,
  );
  assert.equal(
    containsVerbatimQuote(
      "Reproduction is not permitted.",
      "Reproduction is permitted.",
    ),
    false,
  );
  assert.equal(
    containsVerbatimQuote(
      "Use for noncommercial purposes only.",
      "Use for any purpose.",
    ),
    false,
  );
  assert.equal(containsVerbatimQuote("License", " \n"), false);
});
