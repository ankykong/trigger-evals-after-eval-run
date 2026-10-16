# arize-remote-eval

A proof of concept that hosts the pieces of an Arize AX experiment on Vercel Functions:

| Endpoint | What it does |
| --- | --- |
| `api/agent.js` → `/api/agent` | A [remote agent](https://arize.com/docs/ax/improve/remote-agent-experiments). Arize calls it once per dataset example, and the JSON it returns becomes the experiment run output. |
| `api/evaluate.js` → `/api/evaluate` | A [remote evaluator](https://arize.com/docs/ax/evaluate/remote-evaluators). It scores a run against three rule-based criteria. |
| `api/chain-evals.js` → `/api/chain-evals` | A cron job. After an upstream evaluator has written results onto an experiment, it triggers the downstream code evaluators on that same experiment. |

There are no dependencies and no build step. Each file is a plain CommonJS Vercel Function running on Node 22.

## `/api/agent`: remote agent

A question-answering agent that sends each question to an LLM through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

**Request:** `POST` with `{"question": "..."}`. An `input` key also works, and so does the templated body Arize sends, such as `{"question": "{{dataset.input}}"}`. To override the model, pass `config.model`. The default is `anthropic/claude-haiku-5.5`.

**Response:**

```json
{
  "final_response": "…",
  "model": "anthropic/claude-haiku-5.5",
  "latency_ms": 812,
  "usage": { "...": "..." },
  "tool_calls": []
}
```

- The AI Gateway call is authenticated with the deployment's Vercel OIDC token, which comes from the `x-vercel-oidc-token` header or `VERCEL_OIDC_TOKEN`. No provider API key is needed.
- When the gateway fails, the agent returns `502` so that Arize treats the failure as temporary and retries.
- `GET` is a health check.

## `/api/evaluate`: remote evaluator

**Request:** `POST` JSON with `input`, `output` and `expected_output`. The fields can sit at the top level or be nested under `input`. When `output` is a full agent response, such as the JSON returned by `/api/agent`, the evaluator scores its `final_response`, `output`, `answer` or `response` field.

**Response:** always `label: "evaluated"` and `score: 1`. The actual results are in `explanation`, a JSON string that contains:

| Criterion | Logic |
| --- | --- |
| `output_matches_expected` | Passes if the normalized texts are equal, if one contains the other, or if their token Jaccard similarity is at least 0.6. Fails when there is no `expected_output`. |
| `is_question_answered` | Fails if the output is empty or matches a refusal pattern ("I can't help", "I don't know", "as an AI", …). Otherwise it passes and reports how many of the input's keywords appear in the output. |
| `length_of_response` | Character count, word count and a bucket: `empty`, `short` (<20 words), `medium` (≤150 words) or `long`. |

`GET` is a health check.

## `/api/chain-evals`: chained evaluations

Arize has no built-in way to run evaluator B only after evaluator A has finished on an experiment. This function fills that gap. It runs on a Vercel Cron every 5 minutes (see `vercel.json`, which allows up to 300s per run). For each experiment, it:

1. Skips the experiment if a task for the upstream evaluator is still `PENDING`/`RUNNING` on the experiment's dataset.
2. Skips the experiment if it already has the `CHAIN_TAG_ID` tag. This check only runs when the tag is configured.
3. Reads the experiment's runs and looks for the upstream eval's results. Eval columns are found through the `evaluator_id` in each `eval.*.metadata` column.
4. For each chained evaluator that has not yet written results, it creates a `CODE_EVALUATION` task named `auto-chain · <evaluator> · <dataset>` (or reuses one that already exists) and triggers it on the experiment. The task's column mappings point at the upstream eval's columns.
5. Tags the experiment so it is never chained twice.

Each experiment ends up with one of these statuses: `upstream_running`, `already_chained`, `waiting_for_upstream`, `complete`, `triggered`, `would_trigger` (dry run) or `error`.

**Manual use:**

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/chain-evals?experiment_id=<id>&dry_run=1"
```

`experiment_id` limits the run to one experiment and skips the tag check. `dry_run=1` reports what would be triggered without creating or triggering anything.

## Configuration

Set these as Vercel environment variables (`vercel env add …`).

| Variable | Used by | Default / notes |
| --- | --- | --- |
| `REMOTE_AGENT_SECRET` | agent | Optional. If set, callers must send `Authorization: Bearer <secret>`. |
| `REMOTE_EVAL_SECRET` | evaluate | Optional. If set, callers must send `Authorization: Bearer <secret>`. |
| `ARIZE_API_KEY` | chain-evals | **Required.** Arize API key. |
| `CRON_SECRET` | chain-evals | Optional. Vercel Cron sends this as a bearer token, and manual callers must send it too. |
| `ARIZE_API_HOST` | chain-evals | `https://api.arize.com` |
| `UPSTREAM_EVALUATOR` | chain-evals | `output-quality-remote-eval` |
| `CHAINED_EVALUATORS` | chain-evals | `remote-eval-output_matches_expected,remote-eval-is_question_answered,remote-eval-length_of_response` (comma-separated evaluator names) |
| `CHAIN_TAG_ID` | chain-evals | Optional. ID of the Arize tag that marks an experiment as already chained. To re-run an experiment, remove the tag from it in Arize. |
| `CHAIN_COLUMN_MAPPINGS` | chain-evals | `{"explanation":"{upstream}.explanation"}`. `{upstream}` is replaced with the upstream eval's column name. |

## Deploy

```bash
vercel link
vercel env add ARIZE_API_KEY   # plus any of the optional variables above
vercel deploy --prod
```

Then, in Arize:

- Point a remote-agent experiment at `https://<deployment>/api/agent`.
- Register `https://<deployment>/api/evaluate` as a remote evaluator. Its name should match `UPSTREAM_EVALUATOR`.
- Create the chained code evaluators under the names listed in `CHAINED_EVALUATORS`. Each one reads its criterion from the upstream `explanation` JSON.
