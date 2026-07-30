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

export interface VelocityEntityData {
  key: string; // 'client' | competitor id
  name: string;
  siteUrl: string;
  color: string;
  isClient: boolean;
  /** URLs known for this site (crawl + sitemap union). */
  total: number;
  /** URLs with a usable date (page-extracted or sitemap lastmod). */
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
    let dated = 0;
    let datedFromPage = 0;
    let count90 = 0;
    let countPrev90 = 0;

    for (const row of rows) {
      const best = bestDate(row);
      if (!best) continue;
      dated++;
      if (best.source === "page") datedFromPage++;

      const ageDays = (now.getTime() - best.date.getTime()) / DAY_MS;
      if (ageDays >= 0 && ageDays < 90) count90++;
      else if (ageDays >= 90 && ageDays < 180) countPrev90++;

      const mi = monthIndex.get(`${best.date.getUTCFullYear()}-${best.date.getUTCMonth()}`);
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
    });
  }

  newPages.sort((a, b) => (b.publishedAt ?? b.firstSeenAt).localeCompare(a.publishedAt ?? a.firstSeenAt));

  return {
    entities,
    monthLabels,
    hasInventory: inventory.length > 0,
    newPages: newPages.slice(0, 12),
    anyDiffReady: entities.some((e) => !e.isClient && e.diffReady),
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
