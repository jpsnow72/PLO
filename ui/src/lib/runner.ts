// Local-runner data layer: types + runtime shape guards for the catalog,
// queue and runner-status endpoints of the job service (api/, RUN-1/RUN-2):
//
//   GET  /api/catalog        spot catalog annotated per spot
//   GET  /api/queue          queue items + concurrency + paused
//   POST /api/queue          enqueue catalog spots [admin]
//   POST /api/queue/control  pause/resume/remove/set_concurrency [admin]
//   GET  /api/runner/status  queue switches + upload configuration presence
//
// Everything here is parsed defensively (the same discipline as
// solveTree.ts / preflop.ts): the page renders only what validated, and
// a malformed payload becomes a visible "malformed response" state,
// never a silently wrong table.

export type QueueItemState = 'queued' | 'running' | 'done' | 'failed';
export type QueueUploadStatus = 'pending' | 'uploaded' | 'failed' | 'skipped';

export interface CatalogEntry {
  id: string;
  group: string;
  table_size: string;
  matchup: string;
  oop_position: string;
  ip_position: string;
  board: string;
  board_family: string;
  street: 'flop' | 'turn' | 'river';
  /** Root line for turn/river entries; null for flop roots. */
  line: string | null;
  pot_type: string;
  tier: string;
  status: string;
  status_reason: string | null;
  coverage_oop_pct: number;
  coverage_ip_pct: number;
  cap_per_side: number;
  /** Estimated single-core hours, or null when the plan gives no per-entry bound. */
  est_core_hours: { minimum: number; maximum: number } | null;
  /** Annotated by GET /api/catalog: is this spot already in the local library? */
  library_status: 'present' | 'absent';
  /** Annotated by GET /api/catalog: queue state here, when queued at all. */
  queue_status: QueueItemState | null;
  queue_upload_status: QueueUploadStatus | null;
}

export interface CatalogResponse {
  name: string | null;
  entries: CatalogEntry[];
}

export interface QueueItem {
  spot_id: string;
  state: QueueItemState;
  added_at: string;
  started_at: string | null;
  finished_at: string | null;
  job_id: string | null;
  upload_status: QueueUploadStatus;
  /** Ingest outcome detail ("created" | "exists" | "updated") once uploaded. */
  upload_detail: string | null;
  upload_error: string | null;
  uploaded_at: string | null;
  error: string | null;
  /** Set when the item finishes; null/absent until then. */
  nash_distance_pct: number | null;
  iterations: number | null;
}

export interface QueueResponse {
  items: QueueItem[];
  concurrency: number;
  paused: boolean;
  enabled: boolean;
}

export interface EnqueueResult {
  added: string[];
  skipped: { spot_id: string; reason: string }[];
  items: QueueItem[];
}

export interface RunnerStatus {
  queue_enabled: boolean;
  concurrency: number;
  paused: boolean;
  upload_configured: boolean;
  central_url: string | null;
}

// ---------- guards ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringOrNull(v: unknown): v is string | null {
  return typeof v === 'string' || v === null;
}

function isQueueItemState(v: unknown): v is QueueItemState {
  return v === 'queued' || v === 'running' || v === 'done' || v === 'failed';
}

function isQueueUploadStatus(v: unknown): v is QueueUploadStatus {
  return v === 'pending' || v === 'uploaded' || v === 'failed' || v === 'skipped';
}

function parseEstCoreHours(v: unknown): { minimum: number; maximum: number } | null {
  if (!isRecord(v)) return null;
  if (isNumber(v.minimum) && isNumber(v.maximum)) {
    return { minimum: v.minimum, maximum: v.maximum };
  }
  return null;
}

export function isCatalogEntry(v: unknown): v is CatalogEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.group === 'string' &&
    typeof v.table_size === 'string' &&
    typeof v.matchup === 'string' &&
    typeof v.oop_position === 'string' &&
    typeof v.ip_position === 'string' &&
    typeof v.board === 'string' &&
    typeof v.board_family === 'string' &&
    (v.street === 'flop' || v.street === 'turn' || v.street === 'river') &&
    isStringOrNull(v.line) &&
    typeof v.pot_type === 'string' &&
    typeof v.tier === 'string' &&
    typeof v.status === 'string' &&
    isStringOrNull(v.status_reason) &&
    isNumber(v.coverage_oop_pct) &&
    isNumber(v.coverage_ip_pct) &&
    isNumber(v.cap_per_side) &&
    // Deep-checked by parseEstCoreHours when the response is assembled.
    (v.est_core_hours === undefined || v.est_core_hours === null || isRecord(v.est_core_hours)) &&
    (v.library_status === 'present' || v.library_status === 'absent') &&
    (v.queue_status === null || isQueueItemState(v.queue_status)) &&
    (v.queue_upload_status === null || isQueueUploadStatus(v.queue_upload_status))
  );
}

/** Parse a GET /api/catalog body; returns null when the shape is wrong. */
export function parseCatalogResponse(v: unknown): CatalogResponse | null {
  if (!isRecord(v) || !Array.isArray(v.entries)) return null;
  const entries: CatalogEntry[] = [];
  for (const raw of v.entries) {
    if (!isCatalogEntry(raw)) return null;
    entries.push({
      ...raw,
      est_core_hours: parseEstCoreHours(raw.est_core_hours),
    });
  }
  return {
    name: typeof v.name === 'string' ? v.name : null,
    entries,
  };
}

export function isQueueItem(v: unknown): v is QueueItem {
  if (!isRecord(v)) return false;
  return (
    typeof v.spot_id === 'string' &&
    isQueueItemState(v.state) &&
    typeof v.added_at === 'string' &&
    isStringOrNull(v.started_at) &&
    isStringOrNull(v.finished_at) &&
    isStringOrNull(v.job_id) &&
    isQueueUploadStatus(v.upload_status) &&
    // These three are set dynamically by the worker/uploader, so they
    // may be absent on a fresh item — but never a wrong type when present.
    (v.upload_detail === undefined || isStringOrNull(v.upload_detail)) &&
    (v.upload_error === undefined || isStringOrNull(v.upload_error)) &&
    (v.uploaded_at === undefined || isStringOrNull(v.uploaded_at)) &&
    isStringOrNull(v.error) &&
    (v.nash_distance_pct === undefined ||
      v.nash_distance_pct === null ||
      isNumber(v.nash_distance_pct)) &&
    (v.iterations === undefined || v.iterations === null || isNumber(v.iterations))
  );
}

/** Normalise a validated queue item: absent optional fields become null. */
export function normaliseQueueItem(item: QueueItem): QueueItem {
  return {
    ...item,
    upload_detail: item.upload_detail ?? null,
    upload_error: item.upload_error ?? null,
    uploaded_at: item.uploaded_at ?? null,
    nash_distance_pct: item.nash_distance_pct ?? null,
    iterations: item.iterations ?? null,
  };
}

/** Parse a GET /api/queue (or queue-control response) body. */
export function parseQueueResponse(v: unknown): QueueResponse | null {
  if (!isRecord(v) || !Array.isArray(v.items)) return null;
  if (!isNumber(v.concurrency) || typeof v.paused !== 'boolean' || typeof v.enabled !== 'boolean') {
    return null;
  }
  const items: QueueItem[] = [];
  for (const raw of v.items) {
    if (!isQueueItem(raw)) return null;
    items.push(normaliseQueueItem(raw));
  }
  return { items, concurrency: v.concurrency, paused: v.paused, enabled: v.enabled };
}

/** Parse a POST /api/queue body. */
export function parseEnqueueResult(v: unknown): EnqueueResult | null {
  if (!isRecord(v) || !Array.isArray(v.added) || !Array.isArray(v.skipped) || !Array.isArray(v.items)) {
    return null;
  }
  if (!v.added.every((id) => typeof id === 'string')) return null;
  const skipped: { spot_id: string; reason: string }[] = [];
  for (const raw of v.skipped) {
    if (!isRecord(raw) || typeof raw.spot_id !== 'string' || typeof raw.reason !== 'string') {
      return null;
    }
    skipped.push({ spot_id: raw.spot_id, reason: raw.reason });
  }
  const items: QueueItem[] = [];
  for (const raw of v.items) {
    if (!isQueueItem(raw)) return null;
    items.push(normaliseQueueItem(raw));
  }
  return { added: v.added, skipped, items };
}

/** Parse a GET /api/runner/status body. */
export function parseRunnerStatus(v: unknown): RunnerStatus | null {
  if (!isRecord(v)) return null;
  if (
    typeof v.queue_enabled !== 'boolean' ||
    !isNumber(v.concurrency) ||
    typeof v.paused !== 'boolean' ||
    typeof v.upload_configured !== 'boolean' ||
    !isStringOrNull(v.central_url)
  ) {
    return null;
  }
  return {
    queue_enabled: v.queue_enabled,
    concurrency: v.concurrency,
    paused: v.paused,
    upload_configured: v.upload_configured,
    central_url: v.central_url,
  };
}

// ---------- display helpers ----------

/** The one status a catalog row shows, in priority order. */
export type SpotDisplayStatus =
  | 'in-library'
  | 'running'
  | 'queued'
  | 'done'
  | 'failed'
  | 'not-queued';

export function spotDisplayStatus(entry: CatalogEntry): SpotDisplayStatus {
  if (entry.queue_status === 'running') return 'running';
  if (entry.queue_status === 'queued') return 'queued';
  if (entry.queue_status === 'failed') return 'failed';
  if (entry.library_status === 'present') return 'in-library';
  if (entry.queue_status === 'done') return 'done';
  return 'not-queued';
}

export const SPOT_STATUS_LABEL: Record<SpotDisplayStatus, string> = {
  'in-library': 'In library',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  'not-queued': 'Not queued',
};

/** "49.5%" / "0.226%" — coverage is small by construction; keep 3 significant digits. */
export function formatCoverage(pct: number): string {
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

/** "5–9 h" for a flop-style estimate, "—" when the plan gives none. */
export function formatEstHours(est: { minimum: number; maximum: number } | null): string {
  if (!est) return '—';
  if (est.minimum === est.maximum) return `${est.minimum} h`;
  return `${est.minimum}–${est.maximum} h`;
}

/** Elapsed wall time between an ISO timestamp and now, e.g. "2 h 14 m", "45 s". */
export function formatElapsed(startIso: string | null, nowMs: number): string {
  if (!startIso) return '—';
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return '—';
  const secs = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (secs < 60) return `${secs} s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} m ${secs % 60} s`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ${mins % 60} m`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/** Duration between two ISO timestamps (finished items), e.g. "1 h 03 m". */
export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—';
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  return formatElapsed(startIso, end);
}
