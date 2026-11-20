"use strict";

// Research writes a report from the live web and waits for it; Get Research Report reads one by its ID.
// Needs the build output: `npm test` builds first. No network: every HTTP call is answered here.
const assert = require("assert");
const { Specstream } = require("../dist/nodes/Specstream/Specstream.node.js");

function context(parameters, answers, calls) {
  return {
    getInputData: () => [{ json: {} }],
    getCredentials: async () => ({ apiBase: "https://api.specstream.ai" }),
    getNodeParameter: (name, _index, fallback) => (name in parameters ? parameters[name] : fallback),
    getNode: () => ({ name: "SpecStream", type: "specstream", typeVersion: 1, id: "n1", position: [0, 0], parameters: {} }),
    helpers: {
      httpRequestWithAuthentication: async (_name, options) => {
        calls.push({ method: options.method, path: options.url.replace("https://api.specstream.ai", ""), body: options.body, headers: options.headers });
        return { data: answers.shift(), error: null };
      },
    },
  };
}

const queued = { id: "rr_1", status: "queued", depth: "quick", price_usd: 0.1 };
const completed = {
  id: "rr_1",
  status: "completed",
  depth: "quick",
  report: {
    content: "The fastest train in service is the Shanghai maglev [1].",
    citations: [{ n: 1, url: "https://example.com/maglev", read_at: "2026-11-13T08:00:00Z", supported: true }],
    sources: [{ n: 1, url: "https://example.com/maglev", cited: true }],
  },
};
const research = (extra) => ({ resource: "web", operation: "research", research_input: "  Which train is fastest?  ", research_depth: "quick", ...extra });
const run = async (parameters, answers) => {
  const calls = [];
  const [items] = await new Specstream().execute.call(context(parameters, answers, calls));
  return { items, calls };
};

(async () => {
  // Starts the report with an idempotency key, waits, and returns the completed report with its price.
  let { items, calls } = await run(
    research({ researchOptions: { length: "short", include_domains: "example.com,\n example.org", exclude_domains: "" } }),
    [queued, completed],
  );
  assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /v1/research", "GET /v1/research/rr_1"]);
  assert.deepStrictEqual(calls[0].body, {
    input: "Which train is fastest?",
    depth: "quick",
    metadata: { source: "n8n" },
    length: "short",
    include_domains: ["example.com", "example.org"],
  });
  const key = calls[0].headers["Idempotency-Key"];
  assert.match(key, /^n8n-[a-f0-9]{32}$/);
  assert.strictEqual(items[0].json.status, "completed");
  assert.strictEqual(items[0].json.price_usd, 0.1);
  assert.strictEqual(items[0].json.report.citations[0].url, "https://example.com/maglev");

  // The same request gets the same key, so a retry reaches the report already started.
  ({ calls } = await run(research({ research_wait: false, researchOptions: { length: "short", include_domains: "example.com,\n example.org" } }), [queued]));
  assert.strictEqual(calls[0].headers["Idempotency-Key"], key);
  // Not waiting: one call, the Report ID back at once.
  assert.strictEqual(calls.length, 1);

  // A typed Run Key wins; a short one is refused before any call.
  ({ calls } = await run(research({ research_wait: false, researchOptions: { run_key: "my-report-0001" } }), [queued]));
  assert.strictEqual(calls[0].headers["Idempotency-Key"], "my-report-0001");
  await assert.rejects(run(research({ researchOptions: { run_key: "short" } }), []), /Run Key/);

  // Depth and question are checked before any call.
  await assert.rejects(run(research({ research_depth: "ultra" }), []), /Depth/);
  await assert.rejects(run(research({ research_input: "   " }), []), /Question/);

  // A balance too small for the price, and a failed report, stop the step with what to do.
  await assert.rejects(run(research({}), [{ ...queued, status: "payment_required" }]), /balance/);
  await assert.rejects(run(research({}), [{ ...queued, status: "failed", error: { message: "No pages answered." } }]), /No pages answered/);

  // Get Research Report takes the ID or an address that ends with it.
  ({ items, calls } = await run({ resource: "web", operation: "getResearch", report_id: " https://api.specstream.ai/v1/research/rr_1/ " }, [completed]));
  assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /v1/research/rr_1"]);
  assert.strictEqual(items[0].json.report.content, completed.report.content);
  await assert.rejects(run({ resource: "web", operation: "getResearch", report_id: "rr 1!" }, []), /Report ID/);

  const ops = new Specstream().description.properties.find((p) => p.name === "operation" && p.displayOptions.show.resource[0] === "web");
  assert.deepStrictEqual(ops.options.map((o) => o.value).sort(), ["extractPages", "getResearch", "research", "webSearch"]);
  console.log("n8n research ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
