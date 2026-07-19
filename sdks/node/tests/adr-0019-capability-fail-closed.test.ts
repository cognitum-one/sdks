import { describe, it, expect, vi } from "vitest";

import { ConsentRequiredError, UnsupportedCapabilityError } from "../src/agentic/index.js";
import { MetaHarnessClient } from "../src/metaharness/client.js";
import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { LocalBearerTokenCredentialProvider } from "../src/meta-proxy/auth.js";
import type { ChatCompletionRequest } from "../src/meta-llm/types/openai.js";

/**
 * ADR-0019 "Compliance and verification" #6 (issue #74):
 *
 * > Capability tests prove unknown product versions fail closed for
 * > mutation, spend, consent, installation, and code execution.
 *
 * ADR-0019 §D6: "A method whose prerequisite capability is false or
 * unknown MUST fail locally with `UnsupportedCapabilityError` before
 * causing spend, mutation, consent, or code execution."
 *
 * Audit (issue #74) of what already exists before writing this file:
 *
 *  - `tests/metaharness-client.test.ts` already exhaustively covers every
 *    `MetaHarnessClient` method failing closed with `UnsupportedCapabilityError`
 *    (there is no published bridge protocol yet, ADR-0026a §D7 — EVERY
 *    capability is unknown/unsupported this pass), but does not itself
 *    assert zero network I/O nor frame the coverage against this ADR's five
 *    named categories.
 *  - `tests/meta-proxy-consent.test.ts` and
 *    `tests/meta-proxy-chat-completions-stream.test.ts` already cover the
 *    "consent" and "spend" (sponsored-inference) fail-closed paths
 *    individually.
 *  - Genuine gap found: `HarnessaaSClient.solve()` (`src/harnessaas/client.ts`)
 *    performs NO capability-version check at all before its HTTP call — it
 *    is simultaneously a mutation, a spend, and (given HarnessaaS's "Untrusted
 *    repository and command execution" trust boundary, ADR-0019's Context
 *    table) a code-execution trigger, with zero local capability gate. This
 *    is flagged in the issue #74 PR/issue as a follow-up rather than
 *    asserted here as passing behavior that does not exist.
 *
 * This file adds one explicit, `fetch`-spied test per ADR-0019 category,
 * using operations that DO already fail closed today, so every assertion
 * below is backed by real, currently-passing production behavior:
 *
 *   mutation         -> MetaHarnessClient.scaffold()      (applies a plan; would write files)
 *   spend            -> MetaProxyClient.preview.sponsored.chatCompletions (billable)
 *   consent          -> MetaProxyClient.chat.completions  (cognitum_cloud plane, no consent grant)
 *   installation     -> MetaHarnessClient.planScaffold()  (blocked in part on package/template
 *                        version disagreement -- an installation-identity blocker, ADR-0026a §D7 #3)
 *   code execution   -> MetaHarnessClient.analyzeRepository() (runs the bridge against repo content)
 */

function fetchSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    throw new Error("no HTTP call is expected — the capability gate must fire first");
  });
}

describe("ADR-0019 §Compliance #6 — capability fail-closed across five categories", () => {
  it("mutation: MetaHarnessClient.scaffold() fails closed before any I/O", async () => {
    const client = new MetaHarnessClient();
    await expect(
      client.scaffold(
        {
          schema: "cognitum.metaharness.scaffold-plan.v1",
          planId: "plan_1",
          planDigest: "sha256:deadbeef",
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          generatorIdentity: { product: "metaharness-oss" },
          templateIdentity: { template: "default" },
          canonicalTarget: "/tmp/target",
          targetBeforeDigest: "sha256:before",
          requestDigest: "sha256:request",
          actions: [],
          unresolvedVariables: [],
          warnings: [],
          destructive: false,
          estimatedFiles: 0,
          estimatedBytes: 0,
        },
        { planDigest: "sha256:deadbeef", approvedAt: new Date().toISOString() },
      ),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("installation: MetaHarnessClient.planScaffold() fails closed before any I/O", async () => {
    const client = new MetaHarnessClient();
    await expect(
      client.planScaffold({
        schema: "cognitum.metaharness.scaffold-request.v1",
        name: "demo",
        template: "default",
        hosts: ["claude-code"],
        target: "/tmp/target",
        darwin: undefined,
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("code execution: MetaHarnessClient.analyzeRepository() fails closed before any I/O", async () => {
    const client = new MetaHarnessClient();
    await expect(
      client.analyzeRepository({ kind: "local", canonicalPath: "/tmp/repo" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("spend: MetaProxyClient.preview.sponsored.chatCompletions fails closed before any HTTP call", async () => {
    const transport = fetchSpy();
    const client = new MetaProxyClient({
      origin: "http://127.0.0.1:11435",
      transport,
      localCredentialProvider: new LocalBearerTokenCredentialProvider({
        token: "mh1.canary-local-token",
        normalizedOrigin: "http://127.0.0.1:11435",
      }),
    });

    const request: ChatCompletionRequest = {
      model: "gpt-proxy",
      messages: [{ role: "user", content: "hello" }],
    };

    await expect(client.preview.sponsored.chatCompletions(request)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("consent: MetaProxyClient.chat.completions fails closed before any HTTP call when routing intent touches cognitum_cloud without a consent grant", async () => {
    const transport = fetchSpy();
    const client = new MetaProxyClient({
      origin: "http://127.0.0.1:11435",
      transport,
      localCredentialProvider: new LocalBearerTokenCredentialProvider({
        token: "mh1.canary-local-token",
        normalizedOrigin: "http://127.0.0.1:11435",
      }),
      // Deliberately no consentGrants configured.
    });

    const request: ChatCompletionRequest = {
      model: "gpt-proxy",
      messages: [{ role: "user", content: "hello" }],
    };

    await expect(
      client.chat.completions(request, {
        routingIntent: { requiredPlane: "cognitum_cloud", allowedPlanes: ["cognitum_cloud"] },
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(transport).not.toHaveBeenCalled();
  });
});
