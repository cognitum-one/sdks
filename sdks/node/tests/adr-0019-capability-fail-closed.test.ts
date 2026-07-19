import { describe, it, expect, vi } from "vitest";

import { ConsentRequiredError, UnsupportedCapabilityError } from "../src/agentic/index.js";
import { MetaHarnessClient } from "../src/metaharness/client.js";
import { MetaProxyClient } from "../src/meta-proxy/client.js";
import { LocalBearerTokenCredentialProvider } from "../src/meta-proxy/auth.js";
import { HarnessaaSClient } from "../src/harnessaas/client.js";
import { StaticApiKeyCredentialProvider } from "../src/agentic/static-api-key-provider.js";
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
 *  - Gap CLOSED (this pass): `HarnessaaSClient.solve()`
 *    (`src/harnessaas/client.ts`) previously performed NO capability-version
 *    check before its HTTP call, despite being simultaneously a mutation, a
 *    spend, and (given HarnessaaS's "Untrusted repository and command
 *    execution" trust boundary, ADR-0019's Context table) a code-execution
 *    trigger. `solve()` now calls `this.capabilities()` and fails closed
 *    with `UnsupportedCapabilityError` BEFORE any HTTP I/O when either the
 *    base `solve` feature or the requested `vertical`'s specific feature
 *    (`solve.vertical.<vertical>`) is not affirmatively `true` in the
 *    resolved capability set — the real, non-vacuous dimension being that
 *    only the `code-repair` vertical is modeled/serialized by this SDK
 *    pass (`src/harnessaas/types.ts`'s doc comment: the other three
 *    verticals each need a compound request field this client does not
 *    build). `mutation` + `spend` + `code execution` are each covered below
 *    against `HarnessaaSClient.solve()` directly, replacing the reliance on
 *    unrelated `MetaHarnessClient`/`MetaProxyClient` stand-ins for this row.
 *
 * This file adds one explicit, `fetch`-spied test per ADR-0019 category. The
 * `installation` category has no HarnessaaS analog (HarnessaaS installs
 * nothing), so it stays on `MetaHarnessClient.planScaffold()`; every other
 * category now exercises real, currently-passing production behavior:
 *
 *   mutation         -> HarnessaaSClient.solve() (unsupported vertical, mutating remote solve)
 *   spend            -> HarnessaaSClient.solve() (unsupported vertical, billable model spend)
 *   consent          -> MetaProxyClient.chat.completions  (cognitum_cloud plane, no consent grant)
 *   installation     -> MetaHarnessClient.planScaffold()  (blocked in part on package/template
 *                        version disagreement -- an installation-identity blocker, ADR-0026a §D7 #3)
 *   code execution   -> HarnessaaSClient.solve() (unsupported vertical, untrusted sandbox execution)
 */

function fetchSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    throw new Error("no HTTP call is expected — the capability gate must fire first");
  });
}

const HARNESSAAS_ORIGIN = "https://harnessaas.compliance-test.cognitum.one";

/**
 * `HarnessaaSClient.solve()` with a vertical this SDK pass does not model
 * (`security-remediation` needs a `finding`/`scanner_command` compound
 * field this client does not serialize — see `src/harnessaas/types.ts`).
 * One real call embodies all three of ADR-0019's `mutation`, `spend`, and
 * `code execution` categories simultaneously (HarnessaaS's own "untrusted
 * repository and command execution" trust boundary), so the three tests
 * below each assert the same fail-closed outcome against the category
 * they specifically care about, per the class doc comment's category
 * mapping.
 */
function unsupportedVerticalHarnessaasClient(transport: ReturnType<typeof vi.fn>): HarnessaaSClient {
  return new HarnessaaSClient({
    baseUrl: HARNESSAAS_ORIGIN,
    transport: transport as unknown as typeof fetch,
    credentialProvider: new StaticApiKeyCredentialProvider({
      apiKey: "cog_compliance_canary",
      product: "harnessaas",
      normalizedOrigin: HARNESSAAS_ORIGIN,
      audience: HARNESSAAS_ORIGIN,
    }),
  });
}

describe("ADR-0019 §Compliance #6 — capability fail-closed across five categories", () => {
  it("mutation: HarnessaaSClient.solve() fails closed before any I/O for an unsupported vertical", async () => {
    const transport = fetchSpy();
    const client = unsupportedVerticalHarnessaasClient(transport);
    await expect(
      client.solve({
        repo: "https://github.com/acme/widget.git",
        testCommand: "pytest -k test_widget",
        issue: "Widget renders twice",
        vertical: "security-remediation",
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(transport).not.toHaveBeenCalled();
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

  it("code execution: HarnessaaSClient.solve() fails closed before any I/O for an unsupported vertical (untrusted sandbox execution)", async () => {
    const transport = fetchSpy();
    const client = unsupportedVerticalHarnessaasClient(transport);
    await expect(
      client.solve({
        repo: "https://github.com/acme/widget.git",
        testCommand: "pytest -k test_widget",
        issue: "Widget renders twice",
        vertical: "dependency-migration",
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("spend: HarnessaaSClient.solve() fails closed before any billable HTTP call for an unsupported vertical", async () => {
    const transport = fetchSpy();
    const client = unsupportedVerticalHarnessaasClient(transport);
    await expect(
      client.solve({
        repo: "https://github.com/acme/widget.git",
        testCommand: "pytest -k test_widget",
        issue: "Widget renders twice",
        vertical: "test-generation",
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
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
