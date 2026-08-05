#!/usr/bin/env node

// Drives the PUBLISHED SDK against the LIVE api.cognitum.one as an end user
// would, from a clean install off the public registry.
//
// Everything else in CI tests the SDK against mocks. That proves the client
// is internally consistent; it cannot notice the gateway changing a route, a
// response shape, or an auth rule underneath us. This is the only check that
// exercises the seam where the published artifact meets the deployed service.
//
// Assertions are on SEMANTICS, not status codes. A 200 carrying an empty
// completion is a failure worth catching; asserting `status === 200` would
// call it a pass.
//
// Usage: node live-smoke.mjs            (reads COGNITUM_API_KEY, COGNITUM_API_BASE_URL)

import { createRequire } from "node:module";

// The SDK is resolved from the CURRENT WORKING DIRECTORY, not from this
// file's location. This script lives in the repo while the package under test
// is installed into a throwaway directory elsewhere, so a static top-level
// `import "@cognitum-one/sdk/..."` resolves against scripts/ and dies with
// ERR_MODULE_NOT_FOUND no matter how correctly the package was published --
// the smoke test would report a failure that says nothing about the release.
// (Module resolution itself, ESM and CJS, is covered by
// smoke-published-package.mjs; this script's job is the network contract.)
const require = createRequire(`${process.cwd()}/`);
const { StaticApiKeyCredentialProvider } = require("@cognitum-one/sdk/agentic");
const { MetaLlmClient } = require("@cognitum-one/sdk/meta-llm");

const baseUrl = process.env.COGNITUM_API_BASE_URL ?? "https://api.cognitum.one";
const apiKey = process.env.COGNITUM_API_KEY;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started}ms)`);
    return null;
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    return `${name}: ${error.message}`;
  }
}

function currentMonth() {
  // Not `new Date()` for cleanliness -- the usage window just needs to be a
  // month the account plausibly has data in, and "now" is the right one.
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  assert(apiKey, "COGNITUM_API_KEY is not set");
  const client = new MetaLlmClient({
    baseUrl,
    credentialProvider: new StaticApiKeyCredentialProvider({
      apiKey,
      product: "meta-llm",
      normalizedOrigin: baseUrl,
      audience: baseUrl,
    }),
  });

  console.log(`live smoke against ${baseUrl}`);
  const failures = [];

  failures.push(await check("health reports healthy", async () => {
    const { data } = await client.health();
    assert(data?.status === "healthy", `expected status "healthy", got ${JSON.stringify(data?.status)}`);
  }));

  failures.push(await check("models lists the tier aliases", async () => {
    const { data } = await client.models();
    const ids = (data?.data ?? []).map((model) => model.id);
    assert(ids.length > 0, "model list is empty");
    for (const required of ["cognitum-low"]) {
      assert(ids.includes(required), `model list is missing ${required}; got ${ids.join(", ")}`);
    }
  }));

  failures.push(await check("whoami returns authenticated identity", async () => {
    const { data } = await client.whoami();
    assert(data && typeof data === "object", `identity response is empty: ${JSON.stringify(data)}`);
  }));

  failures.push(await check("chat.completions returns real content", async () => {
    const { data } = await client.chat.completions({
      model: "cognitum-low",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 8,
    });
    const content = data?.choices?.[0]?.message?.content;
    assert(typeof content === "string" && content.trim().length > 0, `empty completion content: ${JSON.stringify(data?.choices?.[0])}`);
    assert(data?.usage?.total_tokens > 0, "completion reported zero total_tokens -- usage accounting is not wired");
  }));

  failures.push(await check("messages.create returns real content", async () => {
    const { data } = await client.messages.create({
      model: "cognitum-low",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 8,
    });
    const text = data?.content?.find((block) => block.type === "text")?.text;
    assert(typeof text === "string" && text.trim().length > 0, `empty message content: ${JSON.stringify(data?.content)}`);
  }));

  failures.push(await check("usage returns non-empty monthly accounting", async () => {
    const month = currentMonth();
    const { data } = await client.usage({ from: month, to: month });
    assert(data?.totals?.totalTokens > 0, `usage reports zero or missing totalTokens: ${JSON.stringify(data?.totals)}`);
    assert(data.totals.requests > 0, "usage reports zero monthly requests");
  }));

  const real = failures.filter(Boolean);
  if (real.length > 0) {
    console.error(`\n${real.length} live check(s) failed:\n- ${real.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`\nall live checks passed against ${baseUrl}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
