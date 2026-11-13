import { costEnvelope, costRequest, v2Envelope } from "../../dev/fixtures";

// A real "publish the blog post" prompt (claude-opus-5-5, 1h cache), replayed
// as the CLI captured it: each Stop's cost slug carries the PREVIOUS turn's
// final reply and misses its own (flushed late), PostToolUse and PostToolBatch
// both report every tool, and a background task wakes the agent ~9 minutes
// after the prompt ended.
export const S = "sess-blog";
const RATES = { input: 4e-6, output: 2e-5, cache_read: 2e-7, cache_write: 8e-6 };

export function req(id: string, ts: string, [input, output, cache_read, cache_write]: number[]) {
  const usd = {
    input: input * RATES.input,
    output: output * RATES.output,
    cache_read: cache_read * RATES.cache_read,
    cache_write: cache_write * RATES.cache_write,
  };
  return costRequest({
    request_id: id,
    ts,
    model: "claude-opus-5-5",
    tokens: { input, output, cache_read, cache_write },
    usd: { ...usd, total: usd.input + usd.output + usd.cache_read + usd.cache_write, currency: "USD" },
  });
}

const PREV_FINAL = req("r0", "2026-11-08T12:53:34.311Z", [2, 481, 388822, 214]);
const CALLS: [string, number[]][] = [
  ["2026-11-08T12:53:55.175Z", [4, 294, 389517, 8]],
  ["2026-11-08T12:54:01.736Z", [2, 316, 389525, 348]],
  ["2026-11-08T12:59:05.226Z", [2, 364, 389873, 509]],
  ["2026-11-08T12:59:10.111Z", [2, 353, 390382, 1087]],
  ["2026-11-08T12:59:14.153Z", [2, 245, 391469, 533]],
  ["2026-11-08T12:59:19.098Z", [2, 174, 392002, 305]],
  ["2026-11-08T12:59:21.298Z", [4, 121, 392307, 353]],
  ["2026-11-08T12:59:29.514Z", [2, 464, 392660, 213]],
];
const BLOG = CALLS.map(([ts, t], i) => req(`r${i + 1}`, ts, t));
const WAKE = req("r9", "2026-11-08T13:08:46.513Z", [2, 68, 393337, 10968]);

// [captured_at, name, duration_ms, tool_use_id]
const TOOLS: [string, string, number, string][] = [
  ["2026-11-08T12:53:58Z", "Bash", 2109, "t1"],
  ["2026-11-08T12:59:02Z", "Bash", 300396, "t2"],
  ["2026-11-08T12:59:05Z", "TaskStop", 31, "t3"],
  ["2026-11-08T12:59:07Z", "Bash", 891, "t4"],
  ["2026-11-08T12:59:12Z", "Bash", 910, "t5"],
  ["2026-11-08T12:59:17Z", "Bash", 1855, "t6"],
  ["2026-11-08T12:59:19Z", "ToolSearch", 3, "t7"],
  ["2026-11-08T12:59:23Z", "mcp__bing-webmaster__submit_url", 2534, "t8"],
];

export function lines(opts: { followUpCall?: boolean } = {}): string[] {
  const out = [
    v2Envelope("claude-code", "UserPromptSubmit", "2026-11-08T12:51:46Z", {
      sessionId: S,
      promptId: "p-ci",
      raw: { prompt: "can you ensure all cicd ran succesfully" },
    }),
    v2Envelope("claude-code", "UserPromptSubmit", "2026-11-08T12:53:52Z", {
      sessionId: S,
      promptId: "p-blog",
      raw: { prompt: "publish the blog post" },
    }),
  ];
  for (const [at, name, dur, id] of TOOLS) {
    out.push(
      v2Envelope("claude-code", "PostToolUse", at, {
        sessionId: S,
        promptId: "p-blog",
        raw: { tool_name: name, tool_use_id: id },
        enrichments: { tools: { total: 1, calls: [{ name, ok: true, duration_ms: dur }] } },
      }),
      // The batch event repeats the same call (no duration) — must not double count.
      v2Envelope("claude-code", "PostToolBatch", at, {
        sessionId: S,
        promptId: "p-blog",
        raw: { tool_calls: [{ tool_use_id: id }] },
        enrichments: { tools: { total: 1, calls: [{ name, ok: true }] } },
      }),
    );
  }
  out.push(
    // Stop of the blog prompt: carries the previous turn's final call, misses its own.
    costEnvelope("claude-code", "2026-11-08T12:59:29Z", S, [PREV_FINAL, ...BLOG.slice(0, 7)], {
      promptId: "p-blog",
    }),
    v2Envelope("claude-code", "UserPromptSubmit", "2026-11-08T13:13:00Z", {
      sessionId: S,
      promptId: "p-next",
      raw: { prompt: "yes please" },
    }),
    // The next Stop picks up the blog prompt's final reply and the wake-up.
    costEnvelope("claude-code", "2026-11-08T13:14:00Z", S, [BLOG[7], WAKE, ...(opts.followUpCall === false ? [] : [req("r10", "2026-11-08T13:13:05.000Z", [2, 100, 404000, 300])])], {
      promptId: "p-next",
    }),
  );
  return out;
}

