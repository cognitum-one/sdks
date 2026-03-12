import type { HttpClient } from "./client.js";
import type { DeviceRegisterParams, DeviceUpdateCheck } from "./types.js";

/** Manage OTA devices and firmware updates. */
export class DevicesResource {
  constructor(private readonly client: HttpClient) {}

  /** Register a new device with its Ed25519 public key. */
  async register(params: DeviceRegisterParams): Promise<void> {
    await this.client.request<void>("POST", "/seedRegisterDevice", params);
  }

  /** Check if a firmware update is available for the given device. */
  async checkUpdate(deviceId: string): Promise<DeviceUpdateCheck> {
    const params = new URLSearchParams({ deviceId });
    return this.client.request<DeviceUpdateCheck>(
      "GET",
      `/seedCheckUpdate?${params}`,
    );
  }

  /** Send a device heartbeat / health check. */
  async heartbeat(deviceId: string): Promise<void> {
    await this.client.request<void>("POST", "/seedHeartbeat", { deviceId });
  }
}
