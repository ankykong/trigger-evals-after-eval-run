// Arize remote evaluator: https://arize.com/docs/ax/evaluate/remote-evaluators
// Always returns label "evaluated" / score 1; the explanation is a JSON string
// with three criteria: output_matches_expected, is_question_answered, length_of_response.

const REFUSAL_PATTERNS = [
  /\bi (?:can(?:'|no)?t|cannot|am unable to|won't) (?:help|answer|assist|provide)/i,
  /\bi don'?t know\b/i,
  /\bnot sure\b/i,
  /\bas an ai\b/i,
];

function toText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Remote-agent experiment outputs are the agent's full JSON body; score its answer field.
function unwrapAgentOutput(value) {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return value; }
  }
  if (v && typeof v === "object") {
    for (const key of ["final_response", "output", "answer", "response"]) {
      if (typeof v[key] === "string") return v[key];
    }
  }
  return value;
}

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokens(text) {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

function outputMatchesExpected(output, expected) {
  if (!expected.trim()) {
    return { result: false, similarity: 0, reason: "No expected_output provided." };
  }
  const a = normalize(output);
  const b = normalize(expected);
  if (a === b) return { result: true, similarity: 1, reason: "Output exactly matches expected_output (normalized)." };
  if (a && b && (a.includes(b) || b.includes(a))) {
    return { result: true, similarity: 1, reason: "One of output / expected_output contains the other." };
  }
  const ta = tokens(output);
  const tb = tokens(expected);
  const overlap = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const similarity = union ? Number((overlap / union).toFixed(3)) : 0;
  const result = similarity >= 0.6;
  return {
    result,
    similarity,
    reason: `Token Jaccard similarity ${similarity} (${result ? ">=" : "<"} 0.6 threshold).`,
  };
}

function isQuestionAnswered(input, output) {
  const out = output.trim();
  if (!out) return { result: false, reason: "Output is empty." };
  if (REFUSAL_PATTERNS.some((re) => re.test(out))) {
    return { result: false, reason: "Output reads as a refusal or non-answer." };
  }
  const stop = new Set(["the", "a", "an", "is", "are", "what", "how", "why", "who", "when", "where", "which", "do", "does", "to", "of", "in", "for", "and", "or", "i", "you", "my", "can"]);
  const keywords = [...tokens(input)].filter((t) => t.length > 2 && !stop.has(t));
  const outTokens = tokens(out);
  const hits = keywords.filter((t) => outTokens.has(t));
  const coverage = keywords.length ? Number((hits.length / keywords.length).toFixed(3)) : 1;
  return {
    result: true,
    input_keyword_coverage: coverage,
    reason: `Non-empty, non-refusal answer; covers ${hits.length}/${keywords.length} input keywords.`,
  };
}

function lengthOfResponse(output) {
  const characters = output.length;
  const words = output.trim() ? output.trim().split(/\s+/).length : 0;
  const bucket = words === 0 ? "empty" : words < 20 ? "short" : words <= 150 ? "medium" : "long";
  return { characters, words, bucket };
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", usage: "POST JSON with input, output, expected_output" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.REMOTE_EVAL_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};
  // Mapped fields may arrive top-level or nested under `input`.
  const fields = body.input && typeof body.input === "object" ? body.input : body;

  const input = toText(fields.input);
  const output = toText(unwrapAgentOutput(fields.output));
  const expected = toText(fields.expected_output);

  const explanation = {
    output_matches_expected: outputMatchesExpected(output, expected),
    is_question_answered: isQuestionAnswered(input, output),
    length_of_response: lengthOfResponse(output),
  };

  return res.status(200).json({
    label: "evaluated",
    score: 1,
    explanation: JSON.stringify(explanation),
  });
};
