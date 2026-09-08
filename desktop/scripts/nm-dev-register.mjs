// Development-only Native Messaging registration.
//
// This exists so a real Chrome or Edge can reach the host during development. Production
// installation, the official extension id and uninstall belong to D13 — nothing here is
// part of a shipped build.
//
// Two rules shape the whole script:
//   1. It never overwrites a manifest it did not write. A developer machine may already
//      have a real registration, and clobbering it is not something an unregister can put
//      back.
//   2. Every change is written to a receipt first, so `unregister` removes exactly what
//      was added and restores what was replaced, rather than deleting by name.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOST_NAME = "com.resumepro.desktop";

/// Chrome extension ids are exactly 32 characters from a-p.
const EXTENSION_ID = /^[a-p]{32}$/;

export const BROWSERS = ["chrome", "edge"];

/// Where each browser looks for a user-level manifest, and — on Windows, where the
/// manifest itself may live anywhere — the registry key that points at it.
export function targetsFor({ platform, home, localAppData, browsers = BROWSERS }) {
  const unknown = browsers.filter((b) => !BROWSERS.includes(b));
  if (unknown.length > 0) {
    throw new Error(`unknown browser: ${unknown.join(", ")}`);
  }
  if (platform === "win32") {
    const root = path.join(localAppData, "ResumePro", "dev-nm");
    return browsers.map((browser) => ({
      browser,
      manifestPath: path.join(root, `${browser}-${HOST_NAME}.json`),
      registryKey:
        browser === "chrome"
          ? `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
          : `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    }));
  }
  if (platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    return browsers.map((browser) => ({
      browser,
      manifestPath: path.join(
        support,
        browser === "chrome" ? path.join("Google", "Chrome") : "Microsoft Edge",
        "NativeMessagingHosts",
        `${HOST_NAME}.json`,
      ),
      registryKey: null,
    }));
  }
  throw new Error(`unsupported platform for development registration: ${platform}`);
}

/// The manifest a browser reads. `allowed_origins` names the extensions that may start
/// this host; a wildcard would let any installed extension reach the archive, so ids are
/// checked rather than trusted.
export function manifestFor(binaryPath, extensionIds) {
  if (!path.isAbsolute(binaryPath)) {
    throw new Error(`the host path must be absolute, got ${binaryPath}`);
  }
  if (extensionIds.length === 0) {
    throw new Error("at least one extension id is required");
  }
  for (const id of extensionIds) {
    if (!EXTENSION_ID.test(id)) {
      throw new Error(`not an extension id: ${id}`);
    }
  }
  return {
    name: HOST_NAME,
    description: "Resume Pro desktop archive (development registration)",
    path: binaryPath,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

export function receiptPath({ platform, home, localAppData }) {
  const root =
    platform === "win32"
      ? path.join(localAppData, "ResumePro", "dev-nm")
      : path.join(home, "Library", "Application Support", "ResumePro", "dev-nm");
  return path.join(root, "receipt.json");
}

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadReceipt(file, io) {
  if (!io.exists(file)) {
    return { entries: [] };
  }
  try {
    return JSON.parse(io.read(file));
  } catch {
    // A receipt that cannot be parsed is worse than none: acting on it would delete by
    // guesswork. Starting empty means nothing already registered is touched.
    return { entries: [] };
  }
}

export function readReceipt(file) {
  return loadReceipt(file, realIo);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/// Read the value a registry key currently points at, or null when the key is absent.
/// Injected in tests, because the real one talks to the machine the tests run on.
export function readRegistry(key) {
  try {
    // stderr is silenced: a missing key is the normal case and reg.exe reports it as an
    // error, which would otherwise print noise over the script's own output.
    const out = execFileSync("reg", ["query", key, "/ve"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/REG_SZ\s+(.*)\r?\n/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export function writeRegistry(key, value) {
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], {
    stdio: "ignore",
  });
}

export function deleteRegistry(key) {
  execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
}

const realIo = {
  exists: (file) => fs.existsSync(file),
  read: (file) => fs.readFileSync(file, "utf8"),
  write: writeJson,
  remove: (file) => fs.rmSync(file, { force: true }),
  readRegistry,
  writeRegistry,
  deleteRegistry,
};

/// Add the manifest and, on Windows, the key that points at it.
///
/// A target that already carries someone else's registration is reported and skipped: an
/// unregister cannot restore a file it never saw, so overwriting one would leave the
/// developer's real setup broken with no way back.
export function register(
  { platform, home, localAppData, browsers, binaryPath, extensionIds, dryRun = false },
  io = realIo,
) {
  const manifest = manifestFor(binaryPath, extensionIds);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const file = receiptPath({ platform, home, localAppData });
  const receipt = loadReceipt(file, io);
  const planned = [];
  const skipped = [];

  for (const target of targetsFor({ platform, home, localAppData, browsers })) {
    const ours = receipt.entries.find((e) => e.manifestPath === target.manifestPath);
    if (io.exists(target.manifestPath) && !ours) {
      skipped.push({
        ...target,
        reason: "a manifest is already registered here and was not written by this script",
      });
      continue;
    }
    const previousRegistryValue =
      target.registryKey && !ours ? io.readRegistry(target.registryKey) : (ours?.previousRegistryValue ?? null);
    planned.push({ ...target, previousRegistryValue });
  }

  if (dryRun) {
    return { planned, skipped, manifest, applied: false };
  }

  const entries = receipt.entries.filter(
    (e) => !planned.some((p) => p.manifestPath === e.manifestPath),
  );
  for (const target of planned) {
    io.write(target.manifestPath, manifest);
    if (target.registryKey) {
      io.writeRegistry(target.registryKey, target.manifestPath);
    }
    entries.push({
      browser: target.browser,
      manifestPath: target.manifestPath,
      registryKey: target.registryKey,
      previousRegistryValue: target.previousRegistryValue,
      sha256: digest(body),
    });
  }
  io.write(file, { entries });
  return { planned, skipped, manifest, applied: true };
}

/// Remove exactly what `register` added.
///
/// A manifest whose content has changed since it was written is left alone: something
/// else now owns it, and deleting it would be destroying a file this script did not
/// produce. A registry key that pointed somewhere before is restored rather than deleted.
export function unregister({ platform, home, localAppData, dryRun = false }, io = realIo) {
  const file = receiptPath({ platform, home, localAppData });
  const receipt = loadReceipt(file, io);
  const removed = [];
  const left = [];

  for (const entry of receipt.entries) {
    if (!io.exists(entry.manifestPath)) {
      removed.push({ ...entry, note: "already gone" });
      continue;
    }
    if (digest(io.read(entry.manifestPath)) !== entry.sha256) {
      left.push({ ...entry, reason: "the manifest changed after it was registered" });
      continue;
    }
    if (!dryRun) {
      io.remove(entry.manifestPath);
      if (entry.registryKey) {
        if (entry.previousRegistryValue) {
          io.writeRegistry(entry.registryKey, entry.previousRegistryValue);
        } else {
          io.deleteRegistry(entry.registryKey);
        }
      }
    }
    removed.push(entry);
  }

  if (!dryRun) {
    io.write(file, { entries: left });
  }
  return { removed, left, applied: !dryRun };
}

function parseArgs(argv) {
  const args = { browsers: BROWSERS, extensionIds: [], dryRun: false };
  let i = 0;
  args.command = argv[i++];
  while (i < argv.length) {
    const flag = argv[i++];
    if (flag === "--extension-id") {
      args.extensionIds.push(argv[i++]);
    } else if (flag === "--binary") {
      args.binaryPath = path.resolve(argv[i++]);
    } else if (flag === "--browser") {
      args.browsers = argv[i++] === "both" ? BROWSERS : [argv[i - 1]];
    } else if (flag === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

const USAGE = `Development-only Native Messaging registration.

  node scripts/nm-dev-register.mjs register --extension-id <id> [--extension-id <id>]
                                            [--binary <path to resume-pro-desktop>]
                                            [--browser chrome|edge|both] [--dry-run]
  node scripts/nm-dev-register.mjs unregister [--dry-run]

Production registration is D13's, not this script's.`;

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const env = {
    platform: process.platform,
    home: os.homedir(),
    localAppData: process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    dryRun: args.dryRun,
  };

  if (args.command === "unregister") {
    const result = unregister(env);
    for (const entry of result.removed) {
      console.log(`removed ${entry.browser}: ${entry.manifestPath}`);
    }
    for (const entry of result.left) {
      console.log(`left alone ${entry.browser}: ${entry.manifestPath} — ${entry.reason}`);
    }
    return 0;
  }

  if (args.command !== "register") {
    console.error(USAGE);
    return 2;
  }

  try {
    const result = register({
      ...env,
      browsers: args.browsers,
      binaryPath: args.binaryPath ?? defaultBinary(),
      extensionIds: args.extensionIds,
      dryRun: args.dryRun,
    });
    const verb = result.applied ? "registered" : "would register";
    for (const target of result.planned) {
      console.log(`${verb} ${target.browser}: ${target.manifestPath}`);
    }
    for (const target of result.skipped) {
      console.log(`skipped ${target.browser}: ${target.manifestPath} — ${target.reason}`);
    }
    if (result.skipped.length > 0) {
      console.log("\nRemove those registrations yourself if you meant to replace them.");
    }
    return 0;
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
}

function defaultBinary() {
  const name = process.platform === "win32" ? "resume-pro-desktop.exe" : "resume-pro-desktop";
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.resolve(here, "..", "src-tauri", "target", "debug", name);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
