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
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOST_NAME = "com.resumepro.desktop";

/// Chrome extension ids are exactly 32 characters from a-p.
const EXTENSION_ID = /^[a-p]{32}$/;

export const BROWSERS = ["chrome", "edge"];

/// Path semantics of the machine being registered, not of the machine running the code.
/// Without this a Windows layout can only be reasoned about on Windows, which is exactly
/// where a cross-platform mistake hides until the other runner finds it.
function pathFor(platform) {
  if (platform === "win32") {
    return path.win32;
  }
  if (platform === "darwin") {
    return path.posix;
  }
  throw new Error(`unsupported platform for development registration: ${platform}`);
}

/// Where each browser looks for a user-level manifest, and — on Windows, where the
/// manifest itself may live anywhere — the registry key that points at it.
export function targetsFor({ platform, home, localAppData, browsers = BROWSERS }) {
  const unknown = browsers.filter((b) => !BROWSERS.includes(b));
  if (unknown.length > 0) {
    throw new Error(`unknown browser: ${unknown.join(", ")}`);
  }
  const p = pathFor(platform);
  if (platform === "win32") {
    const root = p.join(localAppData, "ResumePro", "dev-nm");
    return browsers.map((browser) => ({
      browser,
      manifestPath: p.join(root, `${browser}-${HOST_NAME}.json`),
      registryKey:
        browser === "chrome"
          ? `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
          : `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    }));
  }
  const support = p.join(home, "Library", "Application Support");
  return browsers.map((browser) => ({
    browser,
    manifestPath: p.join(
      support,
      browser === "chrome" ? p.join("Google", "Chrome") : "Microsoft Edge",
      "NativeMessagingHosts",
      `${HOST_NAME}.json`,
    ),
    registryKey: null,
  }));
}

/// The manifest a browser reads. `allowed_origins` names the extensions that may start
/// this host; a wildcard would let any installed extension reach the archive, so ids are
/// checked rather than trusted.
export function manifestFor(binaryPath, extensionIds, platform = process.platform) {
  if (!pathFor(platform).isAbsolute(binaryPath)) {
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
  const p = pathFor(platform);
  const root =
    platform === "win32"
      ? p.join(localAppData, "ResumePro", "dev-nm")
      : p.join(home, "Library", "Application Support", "ResumePro", "dev-nm");
  return p.join(root, "receipt.json");
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
/// A target is only written when this script still owns it. Ownership means a receipt
/// entry whose digest matches what is on disk now — the entry alone is not enough, since
/// the file may have been replaced since, and overwriting it would destroy a registration
/// no unregister can put back.
export function register(
  { platform, home, localAppData, browsers, binaryPath, extensionIds, dryRun = false },
  io = realIo,
) {
  const manifest = manifestFor(binaryPath, extensionIds, platform);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const sha256 = digest(body);
  const file = receiptPath({ platform, home, localAppData });
  const receipt = loadReceipt(file, io);
  const planned = [];
  const skipped = [];

  for (const target of targetsFor({ platform, home, localAppData, browsers })) {
    const ours = receipt.entries.find((e) => e.manifestPath === target.manifestPath);
    if (io.exists(target.manifestPath)) {
      if (!ours) {
        skipped.push({
          ...target,
          reason: "a manifest is already registered here and was not written by this script",
        });
        continue;
      }
      if (digest(io.read(target.manifestPath)) !== ours.sha256) {
        skipped.push({
          ...target,
          reason: "the manifest here changed after it was registered; something else owns it",
        });
        continue;
      }
    }
    // What the key pointed at before this script first claimed it. On a re-registration
    // that is whatever the first run recorded: re-reading now would capture this
    // script's own value and have unregister restore it into the key it just cleared.
    const previousRegistryValue = ours
      ? (ours.previousRegistryValue ?? null)
      : target.registryKey
        ? io.readRegistry(target.registryKey)
        : null;
    planned.push({ ...target, previousRegistryValue });
  }

  if (dryRun) {
    return { planned, skipped, manifest, applied: false };
  }

  const entries = receipt.entries.filter(
    (e) => !planned.some((p) => p.manifestPath === e.manifestPath),
  );
  for (const target of planned) {
    entries.push({
      browser: target.browser,
      manifestPath: target.manifestPath,
      registryKey: target.registryKey,
      previousRegistryValue: target.previousRegistryValue,
      sha256,
    });
  }
  // The receipt is written before anything it describes. A failure partway through then
  // leaves a record unregister can act on, where recording afterwards would leave changes
  // nothing knows how to undo.
  io.write(file, { entries });
  for (const target of planned) {
    io.write(target.manifestPath, manifest);
    if (target.registryKey) {
      io.writeRegistry(target.registryKey, target.manifestPath);
    }
  }
  return { planned, skipped, manifest, applied: true };
}

/// Remove exactly what `register` added.
///
/// Each half is checked separately, because they can be taken over separately. The
/// registry value is only restored or cleared while it still points at this script's
/// manifest, and the file is only deleted while its content is still the one that was
/// registered. A missing file is not a reason to abandon the key: leaving it aimed at a
/// manifest that is gone is exactly the state that has no owner left to clean it.
export function unregister({ platform, home, localAppData, dryRun = false }, io = realIo) {
  const file = receiptPath({ platform, home, localAppData });
  const receipt = loadReceipt(file, io);
  const removed = [];
  const left = [];

  for (const entry of receipt.entries) {
    const present = io.exists(entry.manifestPath);
    if (present && digest(io.read(entry.manifestPath)) !== entry.sha256) {
      left.push({ ...entry, reason: "the manifest changed after it was registered" });
      continue;
    }
    const keyIsOurs =
      !entry.registryKey || io.readRegistry(entry.registryKey) === entry.manifestPath;
    if (!dryRun) {
      if (present) {
        io.remove(entry.manifestPath);
      }
      if (entry.registryKey && keyIsOurs) {
        if (entry.previousRegistryValue) {
          io.writeRegistry(entry.registryKey, entry.previousRegistryValue);
        } else {
          io.deleteRegistry(entry.registryKey);
        }
      }
    }
    removed.push({
      ...entry,
      note: present ? undefined : "the manifest was already gone",
      registry: keyIsOurs ? undefined : "the key now points elsewhere and was left alone",
    });
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
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "src-tauri", "target", "debug", name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
