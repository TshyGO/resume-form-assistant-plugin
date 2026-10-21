// #305 command contract for #306. Contains no getter for either secret.
import type { Invoke, RestorePreview, RestoreReport } from "./api";

export interface CloudConnection {
  connectionId: string;
  endpoint: string;
  username: string;
}
export interface CloudOptions {
  root?: string[];
  encrypted?: boolean; // default true; false is an explicit plaintext choice
  maxUploadBytes?: number; // <= 500,000,000 final transmitted bytes
  keepLast?: number | null; // default 5; null disables ALL automatic deletion
  preferMove?: boolean; // false by default, true requests an isolated capability probe
}
export interface CloudMetadata {
  format: "resume-pro.cloud-backup";
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  archiveId: string;
  deviceId: string;
  package: string;
  sizeBytes: number;
  packageSha256: string;
  encryptionFormat: "ageV1Scrypt" | "none";
}
export type CloudPhase = "packing" | "encrypting" | "uploading" | "confirming"
  | "succeeded" | "cleanupWarning" | "failed" | "cancelled" | "interrupted" | "skipped";
export interface CloudJob {
  id: string;
  scope: string;
  options: Required<CloudOptions>;
  metadata: CloudMetadata;
  phase: CloudPhase;
  candidateReady: boolean;
  moveVerified: boolean;
  partIntent: boolean;
  packageIntent: boolean;
  metaIntent: boolean;
  published: boolean;
  errorCode: string | null;
  warnings: string[];
}
export interface CloudStatus {
  cleanupWarning: boolean;
  deviceId: string;
  job: CloudJob | null;
  retryPackage: string | null;
  latestPackage: string | null; // local plaintext .rpbak; the UI must label this
  latestMetadata: CloudMetadata | null;
}
export interface CloudPlan {
  minute: number; everyDays: number; utcOffsetMinutes: number;
  budgetBytes: number; pauseAtBudget: boolean;
}
export interface CloudScheduleStatus {
  enabled: boolean; requiresConfirmation: boolean;
  recentSize: number | null; estimatedCycleBytes: number | null;
  state: {
    plan: CloudPlan | null; nextAt: number | null; paused: string | null;
    message: string | null; retryAt: number | null; retries: number;
    cycleStartedAt: number | null; uploadBytes: number; budgetWarning: boolean;
  };
}
export interface CloudConfig {
  connection: CloudConnection;
  options: CloudOptions;
  automaticEnabled: boolean;
  requiresConfirmation: boolean;
}
export interface CloudPreview { token: string; backupId: string; expiresAt: string; preview: RestorePreview }
export interface CloudNamespace { archiveId: string; deviceId: string }
export interface CloudDiscovery { sources: CloudNamespace[]; warnings: string[] }
export interface CloudRestoreOutcome { report: RestoreReport; cleanupWarning: boolean; refreshWarning: boolean }
// #322: a row read from the folder listing only (names and sizes). The backend
// reads the remote metadata, including the content hash, when previewing it.
export type CloudListed = Pick<CloudMetadata, "backupId" | "createdAt" | "archiveId" | "deviceId" | "package" | "sizeBytes" | "encryptionFormat">;
export interface CloudPage {
  entries: CloudListed[]; // whole months, newest first
  next: string | null; // pass back as `before` for older months; null when done
  contentHashVerified: false; // listing sizes are not a content hash check
}

export function cloudBackupApi(invoke: Invoke) {
  return {
    scheduleStatus: () => invoke<CloudScheduleStatus>("cloud_backup_schedule_status"),
    configureSchedule: (plan: CloudPlan | null) => invoke<void>("cloud_backup_schedule_configure", { plan }),
    config: () => invoke<CloudConfig | null>("cloud_backup_config"),
    saveConfig: (config: CloudConfig) => invoke<void>("cloud_backup_save_config", { config }),
    credentialStatus: (connection: CloudConnection) => invoke<{ hasWebdavPassword: boolean; hasBackupPassphrase: boolean }>("cloud_backup_credential_status", { connection }),
    setCredential: (connection: CloudConnection, kind: "webdavPassword" | "backupPassphrase", value: string) => invoke<void>("set_cloud_backup_credential", { connection, kind, value }),
    clearCredential: (connection: CloudConnection, kind: "webdavPassword" | "backupPassphrase") => invoke<void>("clear_cloud_backup_credential", { connection, kind }),
    test: (connection: CloudConnection, options: CloudOptions) => invoke<void>("cloud_backup_test", { connection, options }),
    discover: (connection: CloudConnection, options: CloudOptions) => invoke<CloudDiscovery>("cloud_backup_discover", { connection, options }),
    preview: (connection: CloudConnection, options: CloudOptions, entry: CloudListed) => invoke<CloudPreview>("cloud_backup_preview", { connection, options, entry }),
    restore: (token: string) => invoke<CloudRestoreOutcome>("cloud_backup_restore", { token }),
    clearPreview: () => invoke<void>("cloud_backup_clear_preview"),
    start: (connection: CloudConnection, options: CloudOptions = {}) =>
      invoke<CloudJob>("cloud_backup_start", { connection, options }),
    retry: (connection: CloudConnection, options: CloudOptions) =>
      invoke<CloudJob>("cloud_backup_retry", { connection, options }),
    status: () => invoke<CloudStatus>("cloud_backup_status"),
    cancel: () => invoke<void>("cloud_backup_cancel"),
    discard: () => invoke<void>("cloud_backup_discard"),
    list: (connection: CloudConnection, options: CloudOptions, archiveId: string, deviceId: string, before: string | null = null) =>
      invoke<CloudPage>("cloud_backup_list", { connection, options, archiveId, deviceId, before }),
  };
}
