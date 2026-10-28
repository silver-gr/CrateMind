export type ExchangeManifest = {
  snapshot_id: string;
  parent_snapshot_id: string | null;
  lineage_id: string;
  logical_roots: { root_key: string; logical_prefix: string; logical_flavor: "posix" | "windows" }[];
};
export type ExchangeExport = { canceled?: boolean; path?: string; manifest?: ExchangeManifest };
export type ExchangePreview = {
  preview_id: string;
  status: "ready" | "replay" | "stale" | "conflict";
  conflict: boolean;
  reason: string;
  local_digest: string | null;
  local_lineage_id?: string | null;
  local_snapshot_id?: string | null;
  change_summary?: { database: string; table: string; label: string; local_rows: number; incoming_rows: number; local_only: number; incoming_only: number }[];
  manifest: ExchangeManifest;
  expires_at_unix: number;
};

export function canApplyExchange(preview: ExchangePreview | null, confirmed: boolean, now = Date.now()): boolean {
  return !!preview && preview.expires_at_unix * 1000 > now && ["ready", "replay", "conflict"].includes(preview.status) &&
    (preview.status !== "conflict" || (confirmed && !!preview.local_digest));
}
