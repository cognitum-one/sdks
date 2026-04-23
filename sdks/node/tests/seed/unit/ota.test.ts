import { describe, it, expect, vi } from "vitest";
import { makeOtaResource } from "../../../src/seed/resources/ota.js";

describe("ota resource", () => {
  it("checkNow posts to kebab-case /api/v1/ota/check-now (not camelCase)", async () => {
    const request = vi.fn(async () => ({}));
    const ota = makeOtaResource(request as never);

    await ota.checkNow();

    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, opts] = request.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/api/v1/ota/check-now");
    // Must NOT be the old camelCase path that returns 404 on the seed.
    expect(path).not.toBe("/api/v1/ota/checkNow");
    expect(opts).toEqual({ idempotent: true });
  });

  it("config gets /api/v1/ota/config (regression guard)", async () => {
    const request = vi.fn(async () => ({}));
    const ota = makeOtaResource(request as never);

    await ota.config();

    const [method, path] = request.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/api/v1/ota/config");
  });
});
