"use client";

// ─────────────────────────────────────────────────────────────
//  Publishing Velocity — the Competitors tab's second panel.
//  Sits BELOW the dimension matrix (which is untouched): how fast
//  each tracked site is shipping new content, from observed data
//  only (page-extracted publish dates, sitemap lastmod hints, and
//  first-seen-in-scan diffs). Coverage is always stated; undated
//  URLs are excluded from charts, never guessed.
//
//  Sections: per-site rate tiles → 12-month trend → "new since
//  last scan" feed → velocity-vs-readiness scatter → 26-week
//  cadence strip. Sections hide honestly when their data doesn't
//  exist yet (first scan = baseline; diffs need a second scan).
// ─────────────────────────────────────────────────────────────

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  LabelList,
} from "recharts";
import InfoTip from "@/components/InfoTip";
import type { VelocityData, VelocityEntityData } from "@/lib/velocity/rollup";

// ── Helpers ───────────────────────────────────────────────────

const fmtDay = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const perMonth = (e: VelocityEntityData): string => (e.count90 / 3).toFixed(1);

/** True when a second scan exists, so new-URL counts are measurable. */
const hasObserved = (e: VelocityEntityData): boolean =>
  e.newSinceLastScan !== null && e.daysSincePrevScan !== null;

/** Observed new URLs normalised to a month, shown alongside the raw count. */
const observedPerMonth = (e: VelocityEntityData): string =>
  (((e.newSinceLastScan ?? 0) / (e.daysSincePrevScan ?? 1)) * 30).toFixed(1);

const nf = (n: number): string => n.toLocaleString();

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
};

// Weekly-cadence cell colors, fewer → more (indigo ramp).
const HEAT_COLORS = ["#eef2ff", "#c7d2fe", "#818cf8", "#4f46e5"];

function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ background: color }}
    />
  );
}

// ── Component ─────────────────────────────────────────────────

export default function PublishingVelocity({ data }: { data: VelocityData }) {
  const { entities, monthLabels, newPages } = data;
  const client = entities.find((e) => e.isClient) ?? null;
  const competitors = entities.filter((e) => !e.isClient);

  // ── Empty state: no inventory yet (feature ships mid-life) ──
  if (!data.hasInventory) {
    return (
      <div className="anim-fade-up card p-6">
        <p className="section-label mb-1">Publishing velocity</p>
        <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
          Builds from your next scan
        </p>
        <p className="text-sm mt-1 max-w-2xl" style={{ color: "var(--text-3)" }}>
          From the next audit run onward, every scan also records each site&apos;s URL set — publish
          dates read from the pages themselves plus the sitemap — so you can see how fast each
          competitor is shipping new content. Run an audit from the Overview to start the baseline.
        </p>
      </div>
    );
  }

  const withDates = entities.filter((e) => e.dated > 0);
  const chartable = withDates.length > 0;

  // Trend-chart rows: one point per month, one series per entity.
  const trendRows = monthLabels.map((label, i) => {
    const row: Record<string, string | number> = { month: label };
    for (const e of entities) row[e.key] = e.monthly[i];
    return row;
  });

  // "X is publishing N.N× your rate". Prefer the observed scan-over-scan
  // counts — every site in a project is scanned in the same sweep, so the
  // windows are identical and the raw counts are directly comparable. Fall
  // back to the trailing-90-day page-date counts when no second scan exists.
  const observedComparable =
    Boolean(client && hasObserved(client)) && competitors.some((e) => hasObserved(e));
  const fastest = observedComparable
    ? competitors
        .filter((e) => hasObserved(e) && (e.newSinceLastScan ?? 0) > 0)
        .sort((a, b) => (b.newSinceLastScan ?? 0) - (a.newSinceLastScan ?? 0))[0]
    : competitors.filter((e) => e.count90 > 0).sort((a, b) => b.count90 - a.count90)[0];
  const ratio = (() => {
    if (!fastest || !client) return null;
    if (observedComparable) {
      const mine = client.newSinceLastScan ?? 0;
      const theirs = fastest.newSinceLastScan ?? 0;
      return mine > 0 && theirs > mine ? (theirs / mine).toFixed(1) : null;
    }
    return client.count90 > 0 && fastest.count90 > client.count90
      ? (fastest.count90 / client.count90).toFixed(1)
      : null;
  })();
  const ratioDetail =
    fastest && client
      ? observedComparable
        ? `${fastest.newSinceLastScan} new URLs vs your ${client.newSinceLastScan} since the last scan`
        : `${fastest.count90} dated pages vs your ${client.count90}`
      : "";

  // Scatter: needs a readiness score AND dated URLs.
  const scatterable = entities.filter((e) => e.avgScore !== null && e.dated > 0);

  // Cadence strip: only when the last 26 weeks contain any dated URLs.
  const cadenceable = entities.filter((e) => e.weekly.some((w) => w > 0));

  const totalDated = entities.reduce((a, e) => a + e.dated, 0);
  const totalFromPage = entities.reduce((a, e) => a + e.datedFromPage, 0);
  const excludedSites = entities.filter((e) => !e.lastmodTrusted);

  return (
    <>
      {/* ══ Velocity card: tiles + trend ══ */}
      <div className="anim-fade-up card overflow-hidden">
        <div className="p-5 border-b" style={{ borderColor: "var(--border)" }}>
          <p className="section-label mb-0 flex items-center gap-1.5">
            Publishing velocity
            <InfoTip
              title="Publishing velocity"
              text="Counts come from observed data only: publish dates read from each page (meta tags, schema.org JSON-LD, dated URLs) plus sitemap lastmod values, refreshed on every scan. URLs with no findable date are excluded from the charts and reported in each site's coverage line — nothing is estimated or modeled."
            />
          </p>
        </div>

        <div className="p-5">
          {/* Rate tiles */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entities.map((e) => {
              const deltaPct =
                e.countPrev90 > 0
                  ? Math.round(((e.count90 - e.countPrev90) / e.countPrev90) * 100)
                  : null;
              return (
                <div
                  key={e.key}
                  className="rounded-xl border p-4"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-1)" }}>
                    <Dot color={e.color} />
                    <span className="truncate">{e.name}</span>
                    {e.isClient && (
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: "#eef2ff", color: "#4f46e5" }}
                      >
                        You
                      </span>
                    )}
                  </div>
                  {/* Three tiers, best-evidence first: measured scan-over-scan
                      change → page-stated publish dates → library size. The
                      last one means a baseline scan is never an empty tile. */}
                  {hasObserved(e) ? (
                    <>
                      <div className="mt-1.5 text-2xl font-extrabold" style={{ color: "var(--text-1)" }}>
                        +{nf(e.newSinceLastScan ?? 0)}
                        <span className="text-xs font-semibold ml-1.5" style={{ color: "var(--text-3)" }}>
                          new URLs · {e.daysSincePrevScan} day{e.daysSincePrevScan === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--text-2, #475569)" }}>
                        ≈ {observedPerMonth(e)} / mo{" "}
                        <span className="font-normal" style={{ color: "var(--text-3)" }}>
                          measured between scans
                        </span>
                      </div>
                    </>
                  ) : e.dated > 0 ? (
                    <>
                      <div className="mt-1.5 text-2xl font-extrabold" style={{ color: "var(--text-1)" }}>
                        {perMonth(e)}
                        <span className="text-xs font-semibold ml-1.5" style={{ color: "var(--text-3)" }}>
                          pages / mo · last 90 days
                        </span>
                      </div>
                      <div className="text-xs font-semibold mt-0.5">
                        {deltaPct !== null ? (
                          <span style={{ color: deltaPct >= 0 ? "#059669" : "#dc2626" }}>
                            {deltaPct >= 0 ? "▲" : "▼"} {deltaPct >= 0 ? "+" : ""}
                            {deltaPct}%{" "}
                            <span className="font-normal" style={{ color: "var(--text-3)" }}>
                              vs prior 90 days
                            </span>
                          </span>
                        ) : (
                          <span className="font-normal" style={{ color: "var(--text-3)" }}>
                            from publish dates on the pages
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mt-1.5 text-2xl font-extrabold" style={{ color: "var(--text-1)" }}>
                        {nf(e.total)}
                        <span className="text-xs font-semibold ml-1.5" style={{ color: "var(--text-3)" }}>
                          URLs in content library
                        </span>
                      </div>
                      <div className="text-xs font-semibold mt-0.5">
                        <span className="font-normal" style={{ color: "var(--text-3)" }}>
                          Baseline recorded — velocity measures from the next scan
                        </span>
                      </div>
                    </>
                  )}
                  <div className="text-[11px] mt-2" style={{ color: "var(--text-3)" }}>
                    {nf(e.total)} URLs known
                    {e.dated > 0 && ` · ${nf(e.dated)} with a publish date`}
                    {e.latestScanAt && ` · last scan ${fmtDay(e.latestScanAt)}`}
                  </div>
                  {!e.lastmodTrusted && (
                    <div
                      className="text-[11px] mt-1.5 rounded-md px-2 py-1.5"
                      style={{ background: "#fffbeb", color: "#92400e" }}
                      title="A sitemap lastmod means the URL changed, not that it was published."
                    >
                      ⚠ Sitemap dates excluded ({e.lastmodExcluded.toLocaleString()} URLs) —{" "}
                      {e.lastmodReason === "bulk"
                        ? "they cluster on a few days, which is a site-wide update, not publishing."
                        : "none are older than 6 months, so they track changes rather than publish history."}
                      {e.dated === 0 &&
                        (hasObserved(e)
                          ? " The rate above is measured from URLs appearing between scans instead."
                          : " No page-stated dates found, so this site's rate can't be measured yet.")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {ratio && fastest && (
            <div
              className="mt-4 rounded-lg border px-4 py-2.5 text-sm font-medium"
              style={{ background: "#fffbeb", borderColor: "#fcd34d", color: "#92400e" }}
            >
              ⚠ <b>{fastest.name} is publishing {ratio}× your rate</b> — {ratioDetail}.
            </div>
          )}

          {/* 12-month trend */}
          {chartable && (
            <div className="mt-6">
              <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-3)" }}>
                New pages per month · trailing 12 months (dated URLs only)
              </p>
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={trendRows} margin={{ top: 4, right: 12, bottom: 0, left: -22 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#8a94a6" }} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#8a94a6" }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 10,
                      border: "1px solid rgba(15,23,42,0.12)",
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {entities.map((e) => (
                    <Line
                      key={e.key}
                      type="monotone"
                      dataKey={e.key}
                      name={e.name}
                      stroke={e.color}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <p className="text-[11px] mt-2 leading-relaxed" style={{ color: "var(--text-3)" }}>
                {totalDated === totalFromPage
                  ? `All ${totalDated} counted URLs carry a date on the page itself.`
                  : `Of ${totalDated} counted URLs across all sites, ${totalFromPage} carry a date on the page itself; the rest use the sitemap's lastmod value.`}{" "}
                Once a site has two scans, new URLs are also confirmed by which scan they first
                appeared in.
                {excludedSites.length > 0 &&
                  ` Sitemap dates were excluded for ${excludedSites.length} site${excludedSites.length === 1 ? "" : "s"} (${excludedSites
                    .map((e) => e.name)
                    .join(", ")}) because they read as site-wide updates rather than publishing.`}
                {data.scopeNote ? ` ${data.scopeNote}` : ""}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ══ New since last scan ══ */}
      <div className="anim-fade-up stagger-1 card overflow-hidden">
        <div className="p-5 border-b flex items-center gap-2 flex-wrap" style={{ borderColor: "var(--border)" }}>
          <p className="section-label mb-0">New competitor pages since last scan</p>
          {data.anyDiffReady && (
            <span
              className="text-[11px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: "#eef2ff", color: "#4f46e5" }}
            >
              {newPages.length === 12 ? "12+" : newPages.length}
            </span>
          )}
        </div>
        {!data.anyDiffReady ? (
          <div className="p-5">
            <p className="text-sm font-medium" style={{ color: "var(--text-1)" }}>
              Needs one more scan
            </p>
            <p className="text-sm mt-1 max-w-2xl" style={{ color: "var(--text-3)" }}>
              The first scan records each competitor&apos;s baseline URL set. From the next scan
              onward, anything that wasn&apos;t there before shows up here — an observed first-seen
              diff, independent of any date the page claims.
            </p>
          </div>
        ) : newPages.length === 0 ? (
          <div className="p-5">
            <p className="text-sm" style={{ color: "var(--text-3)" }}>
              No new competitor URLs appeared between the last two scans.
            </p>
          </div>
        ) : (
          <div className="p-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
                  <th className="pb-2 pr-3 font-bold">Page</th>
                  <th className="pb-2 pr-3 font-bold">Competitor</th>
                  <th className="pb-2 pr-3 font-bold">First seen</th>
                  <th className="pb-2 font-bold">Published</th>
                </tr>
              </thead>
              <tbody>
                {newPages.map((p) => (
                  <tr key={`${p.entityKey}-${p.url}`} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="py-2.5 pr-3 max-w-[340px]">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold hover:underline block truncate"
                        style={{ color: "var(--text-1)" }}
                        title={p.url}
                      >
                        {pathOf(p.url)}
                      </a>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: "var(--text-2, #475569)" }}>
                        <Dot color={p.color} />
                        {p.entityName}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap" style={{ color: "var(--text-3)" }}>
                      {fmtDay(p.firstSeenAt)}
                    </td>
                    <td className="py-2.5 whitespace-nowrap" style={{ color: "var(--text-3)" }}>
                      {p.publishedAt ? (
                        <>
                          {fmtDay(p.publishedAt)}
                          {p.publishedSource === "lastmod" && (
                            <span className="ml-1 text-[10px]" title="From the sitemap's lastmod value — a hint, not a page-stated publish date">
                              (sitemap)
                            </span>
                          )}
                        </>
                      ) : (
                        "date not found"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══ Velocity vs readiness ══ */}
      {scatterable.length >= 2 && (
        <div className="anim-fade-up stagger-2 card overflow-hidden">
          <div className="p-5 border-b" style={{ borderColor: "var(--border)" }}>
            <p className="section-label mb-0 flex items-center gap-1.5">
              Velocity vs. readiness
              <InfoTip
                title="Velocity vs. readiness"
                text="Volume meets quality: how fast each site publishes (trailing 90 days, dated URLs) against its average readiness score from the latest scored run. Up and to the right wins on both fronts. Both axes are stored, observed values."
              />
            </p>
          </div>
          <div className="p-5">
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart margin={{ top: 10, right: 110, bottom: 16, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="pages / mo"
                  tick={{ fontSize: 11, fill: "#8a94a6" }}
                  tickLine={false}
                  label={{
                    value: "pages published / month →",
                    position: "insideBottom",
                    offset: -8,
                    fontSize: 11,
                    fill: "#64748b",
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="avg readiness"
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 11, fill: "#8a94a6" }}
                  tickLine={false}
                  axisLine={false}
                  label={{
                    value: "avg readiness →",
                    angle: -90,
                    position: "insideLeft",
                    offset: 18,
                    fontSize: 11,
                    fill: "#64748b",
                  }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid rgba(15,23,42,0.12)",
                    fontSize: 12,
                  }}
                  formatter={(value: number, name: string) =>
                    name === "pages / mo" ? [value.toFixed(1), name] : [Math.round(value), name]
                  }
                />
                {scatterable.map((e) => (
                  <Scatter
                    key={e.key}
                    name={e.name}
                    data={[{ x: Number(perMonth(e)), y: e.avgScore, name: e.name }]}
                    fill={e.color}
                  >
                    <LabelList dataKey="name" position="right" style={{ fontSize: 12, fontWeight: 600, fill: "#475569" }} />
                  </Scatter>
                ))}
              </ScatterChart>
            </ResponsiveContainer>
            <p className="text-[11px] mt-1" style={{ color: "var(--text-3)" }}>
              x = dated URLs in the last 90 days ÷ 3 · y = average readiness score, latest scored run.
            </p>
          </div>
        </div>
      )}

      {/* ══ Publishing cadence (26 weeks) ══ */}
      {cadenceable.length > 0 && (
        <div className="anim-fade-up stagger-2 card overflow-hidden">
          <div className="p-5 border-b" style={{ borderColor: "var(--border)" }}>
            <p className="section-label mb-0">Publishing cadence · last 26 weeks</p>
          </div>
          <div className="p-5">
            <p className="text-sm mb-4 max-w-2xl" style={{ color: "var(--text-3)" }}>
              Rhythm, not just rate — steady weekly output reads differently than quarterly bursts,
              and a sudden step-up usually means a competitor staffed up.
            </p>
            {cadenceable.map((e) => (
              <div key={e.key} className="flex items-center gap-3 mb-2">
                <div
                  className="w-[130px] flex-shrink-0 flex items-center gap-1.5 text-xs font-semibold truncate"
                  style={{ color: "var(--text-2, #475569)" }}
                >
                  <Dot color={e.color} />
                  <span className="truncate">{e.name}</span>
                </div>
                <div className="flex gap-[3px] flex-1">
                  {e.weekly.map((count, i) => (
                    <span
                      key={i}
                      className="flex-1 h-[16px] rounded-[3px] min-w-[5px]"
                      style={{ background: HEAT_COLORS[Math.min(count, 3)] }}
                      title={`${e.name} · ${26 - i} week${26 - i === 1 ? "" : "s"} ago · ${count} dated page${count === 1 ? "" : "s"}`}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div className="flex items-center justify-end gap-1.5 mt-3 text-[11px]" style={{ color: "var(--text-3)" }}>
              fewer
              {HEAT_COLORS.map((c) => (
                <span key={c} className="inline-block w-3.5 h-3 rounded-[3px]" style={{ background: c }} />
              ))}
              more dated pages / week
            </div>
          </div>
        </div>
      )}
    </>
  );
}
