"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/seed/discovery/mdns.ts
var mdns_exports = {};
__export(mdns_exports, {
  MdnsDiscovery: () => MdnsDiscovery
});
module.exports = __toCommonJS(mdns_exports);

// src/errors.ts
var CognitumError = class extends Error {
  /** Machine-readable error code. */
  code;
  /** HTTP status code, if applicable. */
  statusCode;
  constructor(message, code, statusCode) {
    super(message);
    this.name = "CognitumError";
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var ConfigError = class extends CognitumError {
  constructor(message = "Invalid configuration") {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
};

// src/seed/discovery/mdns.ts
var DEFAULT_SERVICE_TYPE = "_cognitum._tcp.local";
var DEFAULT_TIMEOUT_MS = 500;
var DEFAULT_PORT = 8443;
var MdnsDiscovery = class _MdnsDiscovery {
  serviceType;
  timeoutMs;
  defaultPort;
  scheme;
  mdnsFactory;
  /** Lazily instantiated mDNS wire handle — reused across `discover()` calls. */
  instance;
  constructor(opts = {}) {
    this.serviceType = opts.serviceType ?? DEFAULT_SERVICE_TYPE;
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new ConfigError(
        `MdnsDiscovery.timeoutMs must be a positive number (got ${timeout})`
      );
    }
    this.timeoutMs = timeout;
    this.defaultPort = opts.defaultPort ?? DEFAULT_PORT;
    this.scheme = opts.scheme ?? "https";
    this.mdnsFactory = opts.mdnsFactory;
  }
  /**
   * Convenience constructor matching the ADR example surface —
   * `MdnsDiscovery.default()` reads as "use the seed's published
   * defaults" at call-sites.
   */
  static default() {
    return new _MdnsDiscovery();
  }
  async discover() {
    const mdns = await this.ensureInstance();
    const seen = /* @__PURE__ */ new Map();
    const collector = (packet) => {
      const records = [
        ...packet.answers ?? [],
        ...packet.additionals ?? []
      ];
      for (const rec of records) {
        if (rec.type !== "TXT") continue;
        if (!this.matchesService(rec.name)) continue;
        const parsed = parseTxtRecord(rec.data);
        if (!parsed) continue;
        const peer = this.peerFromTxt(parsed, rec.name);
        if (peer && !seen.has(peer.url)) {
          seen.set(peer.url, peer);
        }
      }
    };
    mdns.on("response", collector);
    mdns.query({
      questions: [{ name: this.serviceType, type: "PTR" }]
    });
    await sleep(this.timeoutMs);
    const off = mdns.removeListener;
    off?.call(mdns, "response", collector);
    return Array.from(seen.values());
  }
  async close() {
    const inst = this.instance;
    this.instance = void 0;
    if (!inst) return;
    await new Promise((resolve) => {
      try {
        inst.destroy(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  // ------------------------------------------------------------------ //
  // internals                                                           //
  // ------------------------------------------------------------------ //
  async ensureInstance() {
    if (this.instance) return this.instance;
    const factory = this.mdnsFactory ?? await loadMdnsFactory();
    this.instance = factory();
    return this.instance;
  }
  matchesService(recordName) {
    return recordName === this.serviceType || recordName.endsWith(`.${this.serviceType}`);
  }
  peerFromTxt(txt, recordName) {
    const port = Number.parseInt(txt.port ?? "", 10) || this.defaultPort;
    const host = hostFromRecordName(recordName) ?? txt.host;
    if (!host) return void 0;
    const url = `${this.scheme}://${host}:${port}`;
    return {
      url,
      deviceId: txt.id
    };
  }
};
function parseTxtRecord(data) {
  const entries = Array.isArray(data) ? data : [data];
  const out = {};
  let any = false;
  const decoder = new TextDecoder("utf-8");
  for (const e of entries) {
    let s;
    if (typeof e === "string") {
      s = e;
    } else if (e instanceof Uint8Array) {
      s = decoder.decode(e);
    } else if (e !== null && typeof e === "object" && "toString" in e && typeof e.toString === "function") {
      s = String(e);
    }
    if (!s) continue;
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim().toLowerCase();
    const val = s.slice(idx + 1);
    if (!key) continue;
    out[key] = val;
    any = true;
  }
  return any ? out : void 0;
}
function hostFromRecordName(recordName) {
  const m = recordName.match(/^([^.]+)\._[^.]+\._tcp\.(.+)$/);
  if (!m) return void 0;
  return `${m[1]}.${m[2]}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function loadMdnsFactory() {
  try {
    const spec = "multicast-dns";
    const mod = await import(spec);
    const factory = mod.default ?? mod;
    if (typeof factory !== "function") {
      throw new Error("multicast-dns module did not export a factory");
    }
    return factory;
  } catch (err) {
    throw new ConfigError(
      `mDNS discovery requires the optional 'multicast-dns' dependency. Install it: npm install multicast-dns (original error: ${err instanceof Error ? err.message : String(err)})`
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MdnsDiscovery
});
//# sourceMappingURL=mdns.cjs.map