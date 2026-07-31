// ─────────────────────────────────────────────────────────────
//  lib/velocity/rollup.ts — turn content_inventory rows into the
//  serializable data the Publishing Velocity panel renders
//  (server-only; the client component imports TYPES only).
//
//  Every figure is observed: month/week counts come from dates the
//  crawler read off the pages themselves (published_source 'page')
//  or, failing that, sitemap <lastmod> hints — and the two are
//  counted separately so the UI can say exactly how much of each.
//  Undated URLs are excluded from time charts and reported in the
//  coverage line. "New since last scan" is a pure first-seen diff
//  (which scan a URL first appeared in) — independent of any date
//  the page claims. No modeled numbers anywhere.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { getInventoryByProject, type InventoryRow } from "./store";
import type { ProjectDetail } from "@/lib/db/projects";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

// Matches TrendChart's client color; competitors use COMPETITOR_COLORS by index.
const CLIENT_COLOR = "#6366f1";
const COMPETITOR_COLORS = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0284c7"];

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_SHOWN = 12;
const WEEKS_SHOWN = 26;

// ── Sitemap-lastmod trust test ────────────────────────────────
//  A sitemap <lastmod> means "this URL changed", NOT "this URL was
//  published". Sites that regenerate templates bump every lastmod at once,
//  which would read as an enormous publishing spike (observed live
//  2026-07-30: one competitor's 1,127 sitemap URLs all carried recent
//  lastmods → "375.7 pages/mo", which is modification noise, not output).
//
//  So lastmod dates are counted only when their distribution looks like
//  real publishing. Two deterministic disqualifiers, both computed from
//  stored rows — no model, no external call:
//    A. BULK — half or more land inside a single 14-day window.
//    B. NO HISTORY — 80%+ sit inside the last 180 days. A site with this
//       many URLs and no older content isn't showing publish history.
//  Page-stated dates (JSON-LD / meta / dated URL) are always trusted and
//  are never affected by this test.
const LASTMOD_MIN_SAMPLE = 25; // below this, clustering is noise
const CLUSTER_WINDOW_DAYS = 14;
const CLUSTER_SHARE = 0.5;
const HISTORY_WINDOW_DAYS = 180;
const HISTORY_SHARE = 0.8;

export type LastmodReason = "bulk" | "no_history";

export interface VelocityEntityData {
  key: string; // 'client' | competitor id
  name: string;
  siteUrl: string;
  color: string;
  isClient: boolean;
  /** URLs known for this site (crawl + sitemap union). */
  total: number;
  /** URLs counted in the charts below (page-dated, plus lastmod when trusted). */
  dated: number;
  /** Subset of `dated` whose date came from the page itself. */
  datedFromPage: number;
  /** Dated URLs in the trailing 90 days / the 90 days before that. */
  count90: number;
  countPrev90: number;
  /** Dated URLs per calendar month, oldest → newest (12 entries). */
  monthly: number[];
  /** Dated URLs per week, oldest → newest (26 entries). */
  weekly: number[];
  /** Average readiness score from the latest scored run, if any. */
  avgScore: number | null;
  /** True once this site has a pre-existing baseline to diff against. */
  diffReady: boolean;
  /** False when this site's sitemap lastmod dates failed the trust test. */
  lastmodTrusted: boolean;
  /** How many lastmod-only URLs were excluded from the counts above. */
  lastmodExcluded: number;
  /** Why they were excluded, for the UI note. */
  lastmodReason: LastmodReason | null;
}

interface LastmodVerdict {
  trusted: boolean;
  reason: LastmodReason | null;
}

/**
 * Decide whether a site's sitemap lastmod dates may be counted as publish
 * dates. Pure function over the observed date sets — deterministic, and it
 * fails toward the conservative answer (excluding lastmod narrows the count,
 * it never invents one).
 */
export function assessLastmod(
  pageDatedCount: number,
  lastmodDates: Date[],
  nowMs: number
): LastmodVerdict {
  const n = lastmodDates.length;
  if (n < LASTMOD_MIN_SAMPLE) return { trusted: true, reason: null };
  // Page-stated dates are the stronger signal. When the site gives us at
  // least as many of those, lastmod is a minor supplement — leave it alone.
  if (pageDatedCount >= n) return { trusted: true, reason: null };

  const times = lastmodDates.map((d) => d.getTime()).sort((a, b) => a - b);

  // A. Densest 14-day window (sliding, on sorted timestamps).
  let densest = 0;
  let left = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[left] > CLUSTER_WINDOW_DAYS * DAY_MS) left++;
    densest = Math.max(densest, i - left + 1);
  }
  if (densest / n >= CLUSTER_SHARE) return { trusted: false, reason: "bulk" };

  // B. Share sitting inside the last 180 days.
  const recent = times.filter((t) => nowMs - t <= HISTORY_WINDOW_DAYS * DAY_MS).length;
  if (recent / n >= HISTORY_SHARE) return { trusted: false, reason: "no_history" };

  return { trusted: true, reason: null };
}

export interface NewPageRow {
  url: string;
  entityKey: string;
  entityName: string;
  color: string;
  firstSeenAt: string; // ISO
  publishedAt: string | null; // ISO — page date, else sitemap lastmod
  publishedSource: "page" | "lastmod" | null;
}

export interface VelocityData {
  entities: VelocityEntityData[];
  /** Chart labels for the 12 monthly buckets, oldest → newest. */
  monthLabels: string[];
  hasInventory: boolean;
  newPages: NewPageRow[];
  /** True when at least one competitor has a baseline to diff against. */
  anyDiffReady: boolean;
  /**
   * Honest statement of the counting universe when the audit is scoped —
   * null for plain whole-domain projects. Velocity mirrors the audit scope:
   * scope prefixes filter the sitemap at ingest; single/list clients count
   * crawled URLs only.
   */
  scopeNote: string | null;
}

interface DoneJob {
  id: string;
  competitorId: string | null;
  completedAt: Date | null;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function bestDate(row: InventoryRow): { date: Date; source: "page" | "lastmod" } | null {
  if (row.publishedAt) return { date: row.publishedAt, source: "page" };
  if (row.lastmod) return { date: row.lastmod, source: "lastmod" };
  return null;
}

async function getDoneJobs(projectId: string): Promise<DoneJob[]> {
  const sql = db();
  const rows = await sql`
    SELECT id, competitor_id, completed_at FROM audit_jobs
    WHERE project_id = ${projectId} AND status = 'done'
    ORDER BY completed_at DESC NULLS LAST
  `;
  return rows.map((r) => ({
    id: String(r.id),
    competitorId: r.competitor_id ? String(r.competitor_id) : null,
    completedAt: r.completed_at ? new Date(String(r.completed_at)) : null,
  }));
}

export async function buildVelocityData(project: ProjectDetail): Promise<VelocityData> {
  const [inventory, doneJobs] = await Promise.all([
    getInventoryByProject(project.id).catch(() => [] as InventoryRow[]),
    getDoneJobs(project.id).catch(() => [] as DoneJob[]),
  ]);

  const now = new Date();

  // Month buckets: last 12 calendar months ending this month.
  const monthKeys: string[] = [];
  const monthLabels: string[] = [];
  {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    for (let i = MONTHS_SHOWN - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      monthKeys.push(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
      monthLabels.push(
        `${MONTH_NAMES[d.getUTCMonth()]}${d.getUTCMonth() === 0 || i === MONTHS_SHOWN - 1 ? ` '${String(d.getUTCFullYear()).slice(2)}` : ""}`
      );
    }
  }
  const monthIndex = new Map(monthKeys.map((k, i) => [k, i]));

  // Latest average readiness score per site, from stored history points.
  const latestScore = new Map<string, number>();
  for (const h of project.history) {
    const key = h.competitorId ?? "client";
    latestScore.set(key, Math.round(Number(h.avgScore))); // history is ASC → last write wins
  }

  const byEntity = new Map<string, InventoryRow[]>();
  for (const row of inventory) {
    const key = row.competitorId ?? "client";
    const list = byEntity.get(key);
    if (list) list.push(row);
    else byEntity.set(key, [row]);
  }

  const latestJobByEntity = new Map<string, DoneJob>();
  for (const j of doneJobs) {
    const key = j.competitorId ?? "client";
    if (!latestJobByEntity.has(key)) latestJobByEntity.set(key, j); // rows are DESC
  }

  const entityDefs: { key: string; name: string; siteUrl: string; color: string; isClient: boolean }[] = [
    { key: "client", name: project.clientName, siteUrl: project.websiteUrl, color: CLIENT_COLOR, isClient: true },
    ...project.competitors.map((c) => ({
      key: c.id,
      name: c.name,
      siteUrl: c.url,
      color: COMPETITOR_COLORS[c.colorIndex % COMPETITOR_COLORS.length],
      isClient: false,
    })),
  ];

  const entities: VelocityEntityData[] = [];
  const newPages: NewPageRow[] = [];

  for (const def of entityDefs) {
    const rows = byEntity.get(def.key) ?? [];
    const monthly = new Array<number>(MONTHS_SHOWN).fill(0);
    const weekly = new Array<number>(WEEKS_SHOWN).fill(0);
    let count90 = 0;
    let countPrev90 = 0;

    // Partition observed dates by provenance, then decide whether this site's
    // lastmod values may be counted at all (see assessLastmod above).
    const pageDates: Date[] = [];
    const lastmodDates: Date[] = [];
    for (const row of rows) {
      if (row.publishedAt) pageDates.push(row.publishedAt);
      else if (row.lastmod) lastmodDates.push(row.lastmod);
    }
    const verdict = assessLastmod(pageDates.length, lastmodDates, now.getTime());
    const countedDates = verdict.trusted ? [...pageDates, ...lastmodDates] : pageDates;
    const dated = countedDates.length;
    const datedFromPage = pageDates.length;

    for (const date of countedDates) {
      const ageDays = (now.getTime() - date.getTime()) / DAY_MS;
      if (ageDays >= 0 && ageDays < 90) count90++;
      else if (ageDays >= 90 && ageDays < 180) countPrev90++;

      const mi = monthIndex.get(`${date.getUTCFullYear()}-${date.getUTCMonth()}`);
      if (mi !== undefined) monthly[mi]++;

      const weekAge = Math.floor(ageDays / 7);
      if (weekAge >= 0 && weekAge < WEEKS_SHOWN) weekly[WEEKS_SHOWN - 1 - weekAge]++;
    }

    // Diff-ready = this site has inventory that predates its latest scan's
    // first-seen set. The very first ingest marks EVERY URL first-seen (the
    // baseline), so "some rows from an earlier job" is the honest gate — it
    // prevents the baseline scan from reading as "everything is new".
    const latestJob = latestJobByEntity.get(def.key);
    const rowsFromLatest = latestJob ? rows.filter((r) => r.firstSeenJob === latestJob.id) : [];
    const diffReady =
      Boolean(latestJob) && rows.some((r) => r.firstSeenJob !== null && r.firstSeenJob !== latestJob!.id);

    if (!def.isClient && diffReady) {
      for (const r of rowsFromLatest) {
        const best = bestDate(r);
        newPages.push({
          url: r.url,
          entityKey: def.key,
          entityName: def.name,
          color: def.color,
          firstSeenAt: r.firstSeenAt.toISOString(),
          publishedAt: best ? best.date.toISOString() : null,
          publishedSource: best ? best.source : null,
        });
      }
    }

    entities.push({
      key: def.key,
      name: def.name,
      siteUrl: def.siteUrl,
      color: def.color,
      isClient: def.isClient,
      total: rows.length,
      dated,
      datedFromPage,
      count90,
      countPrev90,
      monthly,
      weekly,
      avgScore: latestScore.get(def.key) ?? null,
      diffReady,
      lastmodTrusted: verdict.trusted,
      lastmodExcluded: verdict.trusted ? 0 : lastmodDates.length,
      lastmodReason: verdict.reason,
    });
  }

  newPages.sort((a, b) => (b.publishedAt ?? b.firstSeenAt).localeCompare(a.publishedAt ?? a.firstSeenAt));

  // Honest scope statement — velocity mirrors the audit scope.
  const scopeParts: string[] = [];
  if (project.auditSource === "list") {
    scopeParts.push(`${project.clientName}: audited URL list only`);
  } else if (project.auditSource === "single") {
    scopeParts.push(`${project.clientName}: the single audited page`);
  } else if (project.scopePrefix) {
    scopeParts.push(`${project.clientName}: ${project.scopePrefix}`);
  }
  for (const c of project.competitors) {
    if (c.scopePrefix) scopeParts.push(`${c.name}: ${c.scopePrefix}`);
  }
  const scopeNote =
    scopeParts.length > 0 ? `Counts mirror the audit scope — ${scopeParts.join(" · ")}.` : null;

  return {
    entities,
    monthLabels,
    hasInventory: inventory.length > 0,
    newPages: newPages.slice(0, 12),
    anyDiffReady: entities.some((e) => !e.isClient && e.diffReady),
    scopeNote,
  };
}

/**
 * The scan email's "new competitor pages" section — up to 6 rows, only
 * when a real baseline exists to diff against. Best-effort: any failure
 * returns [] so email building never breaks.
 */
export async function getNewCompetitorPagesForEmail(
  projectId: string
): Promise<{ name: string; url: string; publishedAt: string | null }[]> {
  try {
    const { getProjectDetail } = await import("@/lib/db/projects");
    const project = await getProjectDetail(projectId);
    if (!project) return [];
    const data = await buildVelocityData(project);
    return data.newPages.slice(0, 6).map((p) => ({
      name: p.entityName,
      url: p.url,
      publishedAt: p.publishedAt,
    }));
  } catch {
    return [];
  }
}
