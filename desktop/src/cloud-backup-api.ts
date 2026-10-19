// #305 command contract for #306. Contains no getter for either secret.
import type { Invoke } from "./api";

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
  | "succeeded" | "cleanupWarning" | "failed" | "cancelled" | "interrupted";
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
  deviceId: string;
  job: CloudJob | null;
  retryPackage: string | null;
  latestPackage: string | null; // local plaintext .rpbak; the UI must label this
}
export interface CloudCatalog {
  entries: CloudMetadata[];
  cleanupSafe: boolean;
  contentHashVerified: false; // catalog HEAD/length checks are not a content hash check
}

export function cloudBackupApi(invoke: Invoke) {
  return {
    start: (connection: CloudConnection, options: CloudOptions = {}) =>
      invoke<CloudJob>("cloud_backup_start", { connection, options }),
    retry: (connection: CloudConnection, options: CloudOptions) =>
      invoke<CloudJob>("cloud_backup_retry", { connection, options }),
    status: () => invoke<CloudStatus>("cloud_backup_status"),
    cancel: () => invoke<void>("cloud_backup_cancel"),
    discard: () => invoke<void>("cloud_backup_discard"),
    list: (connection: CloudConnection, options: CloudOptions, archiveId: string, deviceId: string) =>
      invoke<CloudCatalog>("cloud_backup_list", { connection, options, archiveId, deviceId }),
    // Returns only a fully verified local package. Call the existing restore
    // preview and explicit confirmation flow afterwards; never auto-restore.
    download: (connection: CloudConnection, options: CloudOptions, metadata: CloudMetadata) =>
      invoke<string>("cloud_backup_download", { connection, options, metadata }),
  };
}
