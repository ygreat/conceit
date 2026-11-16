import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Local media lives in a content-addressed store managed by the Rust core
 * (`<app data>/assets/<sha256>.<ext>`). Boards store only the asset id, so
 * they stay small and portable; this module turns ids into loadable URLs.
 */

let assetsDir: string | null = null;
let sep = "/";

export async function initAssets() {
  if (!isTauri()) return;
  try {
    assetsDir = await invoke<string>("assets_path");
    sep = assetsDir.includes("\\") ? "\\" : "/";
  } catch (err) {
    console.warn("Asset store unavailable:", err);
  }
}

export function assetUrl(asset: string): string | undefined {
  return assetsDir ? convertFileSrc(`${assetsDir}${sep}${asset}`) : undefined;
}

/** URL to display for an image/video object, local asset first. */
export function mediaSrc(data: { url?: string; asset?: string }): string | undefined {
  return data.asset ? assetUrl(data.asset) : data.url;
}

export interface ImportedMedia {
  kind: "image" | "video";
  asset: string;
  path: string;
  name: string;
  width: number | null;
  height: number | null;
}

export interface ImportResult {
  imported: ImportedMedia[];
  skipped: [name: string, reason: string][];
}

export function importMedia(paths: string[]): Promise<ImportResult> {
  return invoke<ImportResult>("import_media", { paths });
}

// Dev only: holds the asset-store path as module state; reload rather than hot-swap.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}
