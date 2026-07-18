import { Channel, invoke } from "@tauri-apps/api/core";

import type { RemoteUpdate } from "../types/remote-config";

type SemanticVersion = {
  build: string[];
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export type AvailableAppUpdate = RemoteUpdate & {
  currentVersion: string;
};

export type AppUpdateProgress = {
  downloadedBytes: number;
  phase: "downloading" | "installing" | "restarting";
  totalBytes?: number | null;
};

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = SEMANTIC_VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    build: match[5]?.split(".") ?? [],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function compareSemanticVersions(leftValue: string, rightValue: string) {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);
  if (!left || !right) {
    return null;
  }
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function resolveAvailableAppUpdate(
  update: RemoteUpdate,
  currentVersion: string,
): AvailableAppUpdate | null {
  return compareSemanticVersions(currentVersion, update.version) === -1
    ? { ...update, currentVersion }
    : null;
}

export async function installAppUpdate(
  onProgress: (progress: AppUpdateProgress) => void,
) {
  const onEvent = new Channel<AppUpdateProgress>();
  onEvent.onmessage = onProgress;
  await invoke("install_app_update", { onEvent });
}
