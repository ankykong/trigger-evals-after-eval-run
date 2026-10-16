// Chained evals: once the upstream evaluator (default `output-quality-remote-eval`)
// has written results onto an experiment's runs, trigger the downstream code
// evaluators on that same experiment. Runs on a Vercel Cron (see vercel.json) and
// can also be called manually: GET/POST /api/chain-evals?experiment_id=...&dry_run=1
//
// Uses the Arize REST API: https://arize.com/docs/api-reference/experiments/list-experiments

const API = process.env.ARIZE_API_HOST || "https://api.arize.com";
const UPSTREAM = process.env.UPSTREAM_EVALUATOR || "output-quality-remote-eval";
const CHAINED = (process.env.CHAINED_EVALUATORS ||
  "remote-eval-output_matches_expected,remote-eval-is_question_answered,remote-eval-length_of_response")
  .split(",").map((s) => s.trim()).filter(Boolean);
// Tag added to an experiment once its chained evals are triggered, so it is never triggered twice.
// Remove the tag from the experiment in Arize to make it eligible again.
const TAG_ID = process.env.CHAIN_TAG_ID || "";
const TASK_PREFIX = "auto-chain";
const ACTIVE = new Set(["PENDING", "RUNNING"]);

async function arize(method, path, body) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.ARIZE_API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(`${method} ${path} -> ${resp.status}: ${data.detail || text.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Follows cursor pagination and concatenates the `key` array of every page.
async function listAll(path, key, limit = 100) {
  const out = [];
  let cursor;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page = await arize("GET", `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(page[key] || []));
    cursor = page.pagination?.has_more ? page.pagination.next_cursor : null;
  } while (cursor);
  return out;
}

const enc = encodeURIComponent;

// Maps evaluator_id -> eval column name (e.g. "eval.is_question_answered") for every
// eval that has written results onto at least one run. Code-eval columns are named
// after the eval, not the evaluator, so the evaluator_id in `.metadata` is the reliable key.
function evalsOnRuns(runs) {
  const found = new Map();
  for (const run of runs) {
    for (const [col, val] of Object.entries(run)) {
      if (!col.startsWith("eval.") || !col.endsWith(".metadata") || !val) continue;
      try {
        const meta = typeof val === "string" ? JSON.parse(val) : val;
        if (meta.evaluator_id) found.set(meta.evaluator_id, col.slice(0, -".metadata".length));
      } catch { /* not JSON; ignore */ }
    }
  }
  return found;
}

async function chain({ experimentId, dryRun }) {
  const evaluators = await listAll("/v2/evaluators", "evaluators");
  const byName = new Map(evaluators.map((e) => [e.name, e]));
  const upstream = byName.get(UPSTREAM);
  if (!upstream) throw new Error(`Upstream evaluator "${UPSTREAM}" not found`);
  const chained = CHAINED.map((name) => {
    const e = byName.get(name);
    if (!e) throw new Error(`Chained evaluator "${name}" not found`);
    return e;
  });

  const tasks = await listAll("/v2/tasks", "tasks");
  const chainTasks = new Map(); // `${dataset_id}|${evaluator_id}` -> task
  for (const t of tasks) {
    if (!t.name.startsWith(TASK_PREFIX) || !t.dataset_id) continue;
    for (const e of t.evaluators || []) chainTasks.set(`${t.dataset_id}|${e.evaluator_id}`, t);
  }

  // Don't act on a dataset while an upstream eval task is still writing results to it.
  const busyDatasets = new Set();
  const upstreamTasks = tasks.filter((t) => t.dataset_id && (t.evaluators || []).some((e) => e.evaluator_id === upstream.id));
  await Promise.all(upstreamTasks.map(async (t) => {
    const { task_runs = [] } = await arize("GET", `/v2/tasks/${enc(t.id)}/runs?limit=5`);
    if (task_runs.some((r) => ACTIVE.has(r.status))) busyDatasets.add(t.dataset_id);
  }));

  const experiments = experimentId
    ? [await arize("GET", `/v2/experiments/${enc(experimentId)}`)]
    : await listAll("/v2/experiments", "experiments");

  const results = [];
  for (const exp of experiments) {
    const r = { experiment_id: exp.id, name: exp.name, dataset_id: exp.dataset_id };
    results.push(r);
    try {
      if (busyDatasets.has(exp.dataset_id)) { r.status = "upstream_running"; continue; }

      if (TAG_ID && !experimentId) {
        const { tags = [] } = await arize("GET", `/v2/experiments/${enc(exp.id)}/tags`);
        if (tags.some((t) => t.id === TAG_ID)) { r.status = "already_chained"; continue; }
      }

      const runs = await listAll(`/v2/experiments/${enc(exp.id)}/runs`, "experiment_runs", 500);
      const present = evalsOnRuns(runs);
      const upstreamCol = present.get(upstream.id);
      if (!upstreamCol) { r.status = "waiting_for_upstream"; continue; }

      const missing = chained.filter((e) => !present.has(e.id));
      if (missing.length === 0) {
        r.status = "complete";
      } else {
        const mappings = JSON.parse(process.env.CHAIN_COLUMN_MAPPINGS || '{"explanation":"{upstream}.explanation"}');
        const columnMappings = Object.fromEntries(
          Object.entries(mappings).map(([k, v]) => [k, v.replace("{upstream}", upstreamCol)]));
        r.triggered = [];
        for (const ev of missing) {
          if (dryRun) { r.triggered.push({ evaluator: ev.name, dry_run: true }); continue; }
          const key = `${exp.dataset_id}|${ev.id}`;
          let task = chainTasks.get(key);
          if (!task) {
            task = await arize("POST", "/v2/tasks", {
              type: "CODE_EVALUATION",
              name: `${TASK_PREFIX} · ${ev.name} · ${exp.dataset_id}`,
              dataset_id: exp.dataset_id,
              experiment_ids: [exp.id],
              evaluators: [{ evaluator_id: ev.id, column_mappings: columnMappings }],
            });
            chainTasks.set(key, task);
          }
          const run = await arize("POST", `/v2/tasks/${enc(task.id)}/trigger`, { experiment_ids: [exp.id] });
          r.triggered.push({ evaluator: ev.name, task_id: task.id, task_run_id: run.id, status: run.status });
        }
        r.status = dryRun ? "would_trigger" : "triggered";
      }

      if (TAG_ID && !dryRun) {
        await arize("POST", `/v2/experiments/${enc(exp.id)}/tags`, { tag_ids: [TAG_ID] });
      }
    } catch (err) {
      r.status = "error";
      r.error = err.message;
    }
  }
  return results;
}

module.exports = async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; manual callers must send the same.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!process.env.ARIZE_API_KEY) {
    return res.status(500).json({ error: "ARIZE_API_KEY is not set" });
  }
  const q = req.query || {};
  try {
    const results = await chain({
      experimentId: q.experiment_id,
      dryRun: q.dry_run === "1" || q.dry_run === "true",
    });
    const summary = {};
    for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
    console.log(JSON.stringify({ summary, acted: results.filter((r) => r.triggered || r.error) }));
    return res.status(200).json({ upstream: UPSTREAM, chained: CHAINED, summary, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.chain = chain;
