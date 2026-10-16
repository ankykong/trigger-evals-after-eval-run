// Arize remote agent: https://arize.com/docs/ax/improve/remote-agent-experiments
// Arize POSTs the templated body (e.g. {"question": "{{dataset.input}}"}) plus a reserved
// `arize_metadata` key; whatever JSON we return is stored as the experiment run output.
// The LLM call goes through Vercel AI Gateway, authenticated with the deployment's OIDC token.

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const SYSTEM_PROMPT =
  "You are a concise question-answering assistant. Answer the user's question directly and " +
  "accurately in one or two sentences. Do not add preamble.";

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", usage: 'POST {"question": "..."}' });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.REMOTE_AGENT_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};
  const question = String(body.question ?? body.input ?? "").trim();
  if (!question) return res.status(400).json({ error: "Missing 'question'" });

  const model = body.config?.model || DEFAULT_MODEL;
  const token = req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN;
  if (!token) return res.status(500).json({ error: "No Vercel OIDC token available for AI Gateway" });

  const started = Date.now();
  const llm = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
    }),
  });

  if (!llm.ok) {
    const detail = await llm.text();
    // 5xx so Arize treats gateway failures as transient and retries.
    return res.status(502).json({ error: "LLM call failed", status: llm.status, detail: detail.slice(0, 500) });
  }

  const data = await llm.json();
  const answer = data.choices?.[0]?.message?.content?.trim() ?? "";

  return res.status(200).json({
    final_response: answer,
    model,
    latency_ms: Date.now() - started,
    usage: data.usage ?? null,
    tool_calls: [],
  });
};
