import { assertConnectorDriverContract } from "@goodjob/integration-connector-sdk";
import type { WorkerConnectorManifest } from "../repository.js";
import type { ConnectorDriver } from "./connector-driver.js";

export class ConnectorDriverRegistry {
  private readonly drivers = new Map<string, ConnectorDriver>();

  constructor(drivers: ConnectorDriver[]) {
    for (const driver of drivers) {
      assertConnectorDriverContract(driver);
      if (this.drivers.has(driver.type)) throw new Error(`连接器 Driver 重复注册: ${driver.type}`);
      this.drivers.set(driver.type, driver);
    }
  }

  resolve(manifest: WorkerConnectorManifest) {
    const type = manifest.driver || "native_mcp";
    const driver = this.drivers.get(type);
    if (!driver) throw new Error(`INTEGRATION_CONNECTOR_INVALID: 未注册连接器 Driver ${type}`);
    return driver;
  }

  async closeConnection(connectionId: string) {
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.closeConnection(connectionId)));
  }
}
