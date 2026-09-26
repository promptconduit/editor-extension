// Whether the CLI is already sending events to the cloud. Mirrors
// client.FileConfig.GetCurrentConfig + Config.ShouldSend: an API key on the
// active environment, and local-only mode off. The extension only reads the
// file so it can hide the login prompt; it never transmits events itself.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CloudEnvConfig {
  api_key?: string;
  local_only?: boolean;
}

export interface CloudConfigFile {
  current_env?: string;
  environments?: Record<string, CloudEnvConfig | undefined>;
  api_key?: string;
  local_only?: boolean;
}

/** ~/.config/promptconduit/config.json, honoring XDG_CONFIG_HOME. */
export function cloudConfigPath(home = os.homedir(), xdg = process.env.XDG_CONFIG_HOME): string {
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(home, ".config");
  return path.join(base, "promptconduit", "config.json");
}

/**
 * True when the active config would send events to the platform. A missing
 * file, a missing key, or local-only mode all mean the login prompt may show.
 */
export function isCloudSyncEnabled(fc: CloudConfigFile | null | undefined): boolean {
  if (!fc) {
    return false;
  }
  const named = fc.current_env && fc.environments ? fc.environments[fc.current_env] : undefined;
  const apiKey = (named ? named.api_key : fc.api_key) ?? "";
  const localOnly = Boolean(named?.local_only) || Boolean(fc.local_only);
  return apiKey.trim() !== "" && !localOnly;
}

export function readCloudSyncEnabled(filePath = cloudConfigPath()): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  try {
    return isCloudSyncEnabled(JSON.parse(raw) as CloudConfigFile);
  } catch {
    return false;
  }
}
