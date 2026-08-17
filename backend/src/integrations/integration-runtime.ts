import type { MysqlIntegrationControlRepository } from "./integration-control-repository.js";
import type { IntegrationControlPlaneService } from "./integration-service.js";
import type { LocalRunnerService } from "./local-runner-service.js";

let repository: MysqlIntegrationControlRepository | null = null;
let service: IntegrationControlPlaneService | null = null;
let localRunnerService: LocalRunnerService | null = null;

export function setIntegrationRepository(value: MysqlIntegrationControlRepository | null) {
  repository = value;
}

export function getIntegrationRepository() {
  return repository;
}

export function setIntegrationControlPlaneService(value: IntegrationControlPlaneService | null) {
  service = value;
}

export function getIntegrationControlPlaneService() {
  return service;
}

export function setLocalRunnerService(value: LocalRunnerService | null) {
  localRunnerService = value;
}

export function getLocalRunnerService() {
  return localRunnerService;
}
