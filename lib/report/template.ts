// ─────────────────────────────────────────────────────────────
//  Assessment Report — data aggregation + HTML template
//
//  Turns a project's latest audit run (client + competitors) into
//  the C3-branded, print-ready assessment report. The HTML is fully
//  server-rendered (all charts are inline SVG built here — no client
//  JS), so headless-chromium PDF capture needs no script execution.
// ─────────────────────────────────────────────────────────────

import type {
  DimensionScores,
  IntentBucket,
  PageScore,
  ScoreDimension,
} from "@/lib/types";
import type { ProjectDetail } from "@/lib/db/projects";

// ── Data shapes ───────────────────────────────────────────────

export interface SiteAggregate {
  key: string; // 'client' or competitor id
  name: string;
  url: string;
  overall: number; // mean of page overallScores, rounded
  pages: PageScore[]; // sorted overall desc (as returned by getScoresByJob)
  means: DimensionScores;
  gradeCounts: Record<"A" | "B" | "C" | "D" | "F", number>;
  bucketCounts: Record<IntentBucket, number>;
  classifiedCount: number; // pages with non-null intentBuckets
  fetchEligible: number; // pages with >= 1 bucket
}

export interface ReportData {
  project: ProjectDetail;
  client: SiteAggregate;
  competitors: SiteAggregate[]; // sorted by overall desc
  generatedAt: Date;
  runDate: Date | null;
  jobId: string | null;
  modelVersion: string | null;
}

export const DIM_ORDER: ScoreDimension[] = [
  "coreIntent",
  "edgeCases",
  "impliedQuestions",
  "fanOutQueries",
  "retrievable",
  "extractable",
  "citable",
  "reusable",
];

const DIM_LABEL: Record<ScoreDimension, string> = {
  coreIntent: "Core Intent",
  edgeCases: "Edge Cases",
  impliedQuestions: "Implied Questions",
  fanOutQueries: "Fan-out Queries",
  retrievable: "Retrievable",
  extractable: "Extractable",
  citable: "Citable",
  reusable: "Reusable",
};

const DIM_SHORT: Record<ScoreDimension, string> = {
  coreIntent: "Core Intent",
  edgeCases: "Edge Cases",
  impliedQuestions: "Implied Qs",
  fanOutQueries: "Fan-out",
  retrievable: "Retrievable",
  extractable: "Extractable",
  citable: "Citable",
  reusable: "Reusable",
};

const DIM_GROUP: Record<ScoreDimension, "quality" | "machine"> = {
  coreIntent: "quality",
  edgeCases: "quality",
  impliedQuestions: "quality",
  fanOutQueries: "quality",
  retrievable: "machine",
  extractable: "machine",
  citable: "machine",
  reusable: "machine",
};

const BUCKETS: IntentBucket[] = ["recency", "ranking", "local", "comparison"];

// ── Small helpers ─────────────────────────────────────────────

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const round = (n: number): number => Math.round(n);

export function gradeOf(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

const GRADE_COLOR: Record<string, string> = {
  A: "#0ca30c",
  B: "#1baf7a",
  C: "#eda100",
  D: "#ec835a",
  F: "#d03b3b",
};

const GRADE_WORD: Record<string, string> = {
  A: "AI-ready",
  B: "Strong",
  C: "Emerging",
  D: "Weak",
  F: "Invisible",
};

const SERIES = { client: "#2a78d6", comp1: "#eb6834", comp2: "#4a3aa7", ctx: "#898781" };

function pct(n: number, of: number): string {
  if (!of) return "0%";
  return `${(Math.round((n / of) * 1000) / 10).toFixed(1).replace(/\.0$/, "")}%`;
}

function shortUrl(url: string, site: string): string {
  let u = url.replace(/^https?:\/\/(www\.)?/, "");
  const host = site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");
  if (u === host || u === host + "/") return host + " (homepage)";
  if (u.startsWith(host)) u = u.slice(host.length);
  return u.length > 58 ? u.slice(0, 55) + "…" : u;
}

function heatCell(v: number, wide = false): string {
  const steps: Array<[number, string, string]> = [
    [0, "#f0efec", "#52514e"],
    [25, "#cde2fb", "#0b0b0b"],
    [40, "#9ec5f4", "#0b0b0b"],
    [55, "#5598e7", "#fff"],
    [70, "#2a78d6", "#fff"],
    [85, "#184f95", "#fff"],
  ];
  let s = steps[0];
  for (const st of steps) if (v >= st[0]) s = st;
  return `<span class="heat" style="background:${s[1]};color:${s[2]};${wide ? "width:34px;font-size:11.5px;" : ""}">${v}</span>`;
}

const chip = (g: string, size = 21): string =>
  `<span class="grade-chip" style="background:${GRADE_COLOR[g]};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px">${g}</span>`;

// ── Aggregation ───────────────────────────────────────────────

export function aggregateSite(
  key: string,
  name: string,
  url: string,
  pages: PageScore[]
): SiteAggregate | null {
  if (!pages.length) return null;
  const means = {} as DimensionScores;
  for (const d of DIM_ORDER) {
    means[d] = round(pages.reduce((s, p) => s + (p.scores[d] ?? 0), 0) / pages.length);
  }
  const overall = round(pages.reduce((s, p) => s + p.overallScore, 0) / pages.length);
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0, F: 0 } as SiteAggregate["gradeCounts"];
  for (const p of pages) gradeCounts[p.grade] += 1;
  const bucketCounts = { recency: 0, ranking: 0, local: 0, comparison: 0 } as SiteAggregate["bucketCounts"];
  let classifiedCount = 0;
  let fetchEligible = 0;
  for (const p of pages) {
    if (p.intentBuckets != null) classifiedCount += 1;
    if (p.intentBuckets && p.intentBuckets.length) {
      fetchEligible += 1;
      for (const b of p.intentBuckets) if (bucketCounts[b] != null) bucketCounts[b] += 1;
    }
  }
  return { key, name, url, overall, pages, means, gradeCounts, bucketCounts, classifiedCount, fetchEligible };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ── SVG builders (server-side, no client JS) ──────────────────

function dialSvg(score: number): string {
  const cx = 109, cy = 109, r = 96;
  const a0 = -Math.PI * 0.75, span = Math.PI * 1.5;
  const arc = (t0: number, t1: number, color: string, w: number): string => {
    const s = a0 + span * t0, e = a0 + span * t1;
    const x0 = cx + r * Math.sin(s), y0 = cy - r * Math.cos(s);
    const x1 = cx + r * Math.sin(e), y1 = cy - r * Math.cos(e);
    const large = e - s > Math.PI ? 1 : 0;
    return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${color}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
  };
  const ticks = [0.4, 0.55, 0.7, 0.85]
    .map((t) => {
      const a = a0 + span * t;
      const x0 = cx + (r - 11) * Math.sin(a), y0 = cy - (r - 11) * Math.cos(a);
      const x1 = cx + (r + 9) * Math.sin(a), y1 = cy - (r + 9) * Math.cos(a);
      return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#fcfcfb" stroke-width="3"/>`;
    })
    .join("");
  const color = GRADE_COLOR[gradeOf(score)];
  return `<svg viewBox="0 0 218 218">${arc(0, 1, "#f0efec", 13)}${score > 0 ? arc(0, Math.max(0.02, score / 100), color, 13) : ""}${ticks}</svg>`;
}

function radarSvg(client: SiteAggregate, comps: SiteAggregate[]): string {
  const cx = 186, cy = 174, R = 108, N = DIM_ORDER.length;
  const pt = (i: number, v: number): [number, number] => {
    const a = (Math.PI * 2 * i) / N - Math.PI / 2;
    const rr = (R * v) / 100;
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  };
  const poly = (vals: number[], stroke: string, fill: string, w: number, dash: boolean): string =>
    `<polygon points="${vals.map((v, i) => pt(i, v).map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"${dash ? ' stroke-dasharray="5 4"' : ""}/>`;
  const dots = (vals: number[], color: string): string =>
    vals
      .map((v, i) => {
        const [x, y] = pt(i, v);
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${color}" stroke="#fcfcfb" stroke-width="1.6"/>`;
      })
      .join("");
  let out = "";
  for (const ring of [25, 50, 75, 100]) {
    out += `<polygon points="${DIM_ORDER.map((_, i) => pt(i, ring).map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="#e1e0d9" stroke-width="${ring === 100 ? 1.4 : 1}"/>`;
  }
  for (let i = 0; i < N; i++) {
    const [x, y] = pt(i, 100);
    out += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e1e0d9" stroke-width="1"/>`;
  }
  // context/competitor series first, client on top
  const c2 = comps[1];
  if (c2) out += poly(DIM_ORDER.map((d) => c2.means[d]), SERIES.ctx, "none", 1.8, true);
  const c1 = comps[0];
  if (c1) {
    out += poly(DIM_ORDER.map((d) => c1.means[d]), SERIES.comp1, "rgba(235,104,52,0.06)", 2, false);
    out += dots(DIM_ORDER.map((d) => c1.means[d]), SERIES.comp1);
  }
  out += poly(DIM_ORDER.map((d) => client.means[d]), SERIES.client, "rgba(42,120,214,0.16)", 2.4, false);
  out += dots(DIM_ORDER.map((d) => client.means[d]), SERIES.client);
  // labels
  DIM_ORDER.forEach((d, i) => {
    const a = (Math.PI * 2 * i) / N - Math.PI / 2;
    const lx = cx + (R + 22) * Math.cos(a), ly = cy + (R + 22) * Math.sin(a);
    const anchor = Math.abs(Math.cos(a)) < 0.3 ? "middle" : Math.cos(a) > 0 ? "start" : "end";
    out += `<text x="${lx.toFixed(1)}" y="${(ly - 4).toFixed(1)}" text-anchor="${anchor}" font-size="10.5" font-weight="650" fill="#0b0b0b">${DIM_SHORT[d]}</text>`;
    out += `<text x="${lx.toFixed(1)}" y="${(ly + 8).toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="800" fill="${SERIES.client}">${client.means[d]}</text>`;
  });
  return `<svg viewBox="0 0 372 344" style="overflow:visible">${out}</svg>`;
}

// ── Issue copy (filled with live numbers at render time) ──────

const ISSUE_COPY: Record<ScoreDimension, { title: string; body: string; fix: string }> = {
  retrievable: {
    title: "Weak heading architecture — content hard to retrieve",
    body: "Pages carry substantial content without the H1→H2→H3 skeleton retrieval systems navigate by, so the material never surfaces as a candidate answer.",
    fix: "Add a full heading hierarchy to every page — a template-level fix, no rewriting required.",
  },
  coreIntent: {
    title: "Pages without one clear job",
    body: "Pages blend audiences and messages, so an engine can't state what each page is for — and won't risk citing it.",
    fix: "Give every page one dominant promise in its H1 and opening paragraph; move secondary messages to their own URLs.",
  },
  impliedQuestions: {
    title: "Unanswered follow-up questions",
    body: "Content stops at the headline answer and leaves the natural next questions — how, why, what if — unaddressed.",
    fix: "Add an FAQ block built from the questions a reader would ask next.",
  },
  fanOutQueries: {
    title: "Topical isolation",
    body: "Pages sit alone rather than linking into a connected topic neighborhood, so they can't serve as a starting point for related queries.",
    fix: "Add contextual links between related pages and “see also” pathways.",
  },
  edgeCases: {
    title: "Absolute claims, no caveats",
    body: "Content states benefits as universal truths — no prerequisites, no “when this doesn’t apply.” Unqualified claims read as promotion, not expertise.",
    fix: "State the limits: prerequisites, exceptions, and where the advice doesn’t hold.",
  },
  extractable: {
    title: "Key facts trapped outside prose",
    body: "Important numbers and claims live in images, charts, or complex layouts where extraction systems can't reach them.",
    fix: "State every key fact in plain text; summarize charts in a sentence.",
  },
  citable: {
    title: "Weak attribution on expert content",
    body: "Pages lack the named authors, visible dates, and external sources that make a passage safe for an engine to attribute.",
    fix: "Roll bylines, dates, and cited sources out site-wide.",
  },
  reusable: {
    title: "Sections that can't stand alone",
    body: "Cross-references and context-dependent pronouns mean strong passages fail when quoted in isolation — which is exactly how answer engines quote.",
    fix: "Open each H2 section with a self-contained topic sentence.",
  },
};

const BUCKET_META: Record<IntentBucket, { tag: string; tagClass: string; examples: string; body: string }> = {
  recency: {
    tag: "time-sensitive",
    tagClass: "bt-recency",
    examples: "“best tools in {year}” · “current rates or benchmarks”",
    body: "The answer changes over time — rates, prices, rankings-by-year, news. The engine can't trust its training data, so it crawls.",
  },
  ranking: {
    tag: "best-of lists",
    tagClass: "bt-ranking",
    examples: "“top 5 providers for X” · “best platforms”",
    body: "Ordered, rated shortlists of multiple options. The body must actually rank things — a clickbait “top 10” title doesn't qualify.",
  },
  local: {
    tag: "geo intent",
    tagClass: "bt-none",
    examples: "“best agency in NYC” · “services near me”",
    body: "Location-tied services and recommendations. Content must be tied to a geographic area, not merely mention a place.",
  },
  comparison: {
    tag: "head-to-head",
    tagClass: "bt-comparison",
    examples: "“X vs Y” · “is brand A better than brand B”",
    body: "Two or more named options compared on features, price, or outcomes. High commercial intent — closest to a buying decision.",
  },
};

// ── The template ──────────────────────────────────────────────

export function renderAssessmentHtml(data: ReportData): string {
  const { project, client, competitors } = data;
  const w = project.weights;
  const wpct = (d: ScoreDimension): string => `${Math.round(((w[d] ?? 0.125) as number) * 100)}%`;
  const n = client.pages.length;
  const fCount = client.gradeCounts.F;
  const med = median(client.pages.map((p) => p.overallScore));
  const runDateStr = data.runDate
    ? data.runDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "—";
  const leader = competitors[0] ?? null; // highest-scoring competitor
  const leaderDimLead = leader
    ? DIM_ORDER.filter((d) => leader.means[d] > client.means[d]).length
    : 0;
  const biggestGap = leader
    ? DIM_ORDER.map((d) => ({ d, gap: leader.means[d] - client.means[d] })).sort((a, b) => b.gap - a.gap)[0]
    : null;
  const weakDims = [...DIM_ORDER].sort((a, b) => client.means[a] - client.means[b]);
  const classified = client.classifiedCount > 0;
  const fetchPct = classified ? pct(client.fetchEligible, n) : null;

  // recommendations across client pages
  const allRecs = client.pages.flatMap((p) => p.recommendations ?? []);
  const recByPriority = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  const recByDim = {} as Record<ScoreDimension, number>;
  for (const r of allRecs) {
    recByPriority[r.priority] = (recByPriority[r.priority] ?? 0) + 1;
    recByDim[r.dimension] = (recByDim[r.dimension] ?? 0) + 1;
  }

  // issues ranked by weighted deficit + rec pressure
  const issues = DIM_ORDER.map((d) => ({
    d,
    score: client.means[d],
    weight: (w[d] ?? 0.125) as number,
    recs: recByDim[d] ?? 0,
    affected: client.pages.filter((p) => (p.scores[d] ?? 0) < 50).length,
    rank: (100 - client.means[d]) * ((w[d] ?? 0.125) as number) + (recByDim[d] ?? 0) * 1.5,
  }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 6);

  // evidence quote for the top issue
  function evidenceFor(d: ScoreDimension): string | null {
    const withEv = client.pages
      .filter((p) => p.evidence && p.evidence[d] && p.evidence[d]!.length)
      .sort((a, b) => (a.scores[d] ?? 0) - (b.scores[d] ?? 0));
    if (!withEv.length) return null;
    const q = withEv[0].evidence![d]![0];
    return q.length > 150 ? q.slice(0, 147) + "…" : q;
  }

  // quick wins: within 9 points of the next band
  const NEXT_BAND: Record<string, [number, string]> = { F: [40, "D"], D: [55, "C"], C: [70, "B"], B: [85, "A"] };
  const quickWins = client.pages
    .filter((p) => NEXT_BAND[p.grade])
    .map((p) => {
      const [thr, next] = NEXT_BAND[p.grade];
      return { p, next, gap: thr - p.overallScore };
    })
    .filter((x) => x.gap > 0 && x.gap <= 9)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 3);

  // ── section builders ──
  const pages: string[] = [];

  const footer = (i: number, total: number): string =>
    `<div class="pfoot"><span><b>C3 Marketing Group</b> · AI Content Readiness Assessment · ${esc(client.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</span><span>Confidential · Page ${i} of ${total}</span></div>`;

  // ═══ COVER ═══
  {
    const statCells: string[] = [
      `<div class="stat"><div class="v">${n}</div><div class="l">URL${n === 1 ? "" : "s"} audited</div></div>`,
      `<div class="stat"><div class="v">${pct(fCount, n)}</div><div class="l">of URLs grade F</div></div>`,
    ];
    if (project.scoreDelta != null && project.runCount > 1) {
      const d = project.scoreDelta;
      statCells.push(
        `<div class="stat"><div class="v ${d < 0 ? "down" : "up"}">${d < 0 ? "▾" : "▴"} ${Math.abs(d)} <small>pts</small></div><div class="l">vs. prior run</div></div>`
      );
    } else {
      statCells.push(`<div class="stat"><div class="v">${med}</div><div class="l">median page score</div></div>`);
    }
    if (fetchPct != null) {
      statCells.push(`<div class="stat"><div class="v">${fetchPct}</div><div class="l">URLs in fetch-trigger buckets</div></div>`);
    }
    if (leader) {
      statCells.push(
        `<div class="stat"><div class="v">${leaderDimLead}/8</div><div class="l">dimensions where ${esc(leader.name)} leads</div></div>`
      );
    } else {
      statCells.push(`<div class="stat"><div class="v">${chipInline(gradeOf(med))}</div><div class="l">median grade</div></div>`);
    }

    const g = gradeOf(client.overall);
    const strongest = client.pages[0];
    const heroP2 =
      strongest && strongest.overallScore >= client.overall + 15
        ? `<p>The good news: your strongest page scores <b>${strongest.overallScore}</b> against a site average of ${client.overall} — proof the fix works with content you already have.</p>`
        : `<p>The pages move together: strongest ${strongest ? strongest.overallScore : "—"}, site average ${client.overall}. Lifting the shared template lifts everything at once.</p>`;

    const execP: string[] = [];
    const wd = weakDims[0];
    execP.push(
      `<p><b>The problem is ${DIM_GROUP[wd] === "machine" ? "structural, not editorial" : "depth, not volume"}.</b> Your weakest dimension — ${DIM_LABEL[wd]} (${client.means[wd]}/100) — carries a ${wpct(wd)} weight in the overall score. ${ISSUE_COPY[wd].body}</p>`
    );
    if (leader && biggestGap) {
      if (leaderDimLead >= 5) {
        execP.push(
          `<p><b>${esc(leader.name)} now out-scores you on ${leaderDimLead} of 8 dimensions</b>, with the widest gap in ${DIM_LABEL[biggestGap.d]} (+${biggestGap.gap}). ${competitors.length > 1 ? `You out-score ${esc(competitors[competitors.length - 1].name)} across most dimensions, so the race is for the top spot — and nobody in this set is AI-ready yet.` : "Nobody in this set is AI-ready yet, so the leader position is still open."}</p>`
        );
      } else {
        execP.push(
          `<p><b>You lead ${esc(leader.name)} on ${8 - leaderDimLead} of 8 dimensions.</b> The gaps that remain${biggestGap.gap > 0 ? ` — led by ${DIM_LABEL[biggestGap.d]} (${biggestGap.gap > 0 ? "+" + biggestGap.gap : biggestGap.gap} to them)` : ""} — are covered in the fix list, and closing them consolidates a lead while the category is still unclaimed.</p>`
        );
      }
    }
    if (fetchPct != null) {
      const leaderFetch = leader && leader.classifiedCount > 0 ? pct(leader.fetchEligible, leader.pages.length) : null;
      execP.push(
        `<p><b>${fetchPct} of your audited URLs sit in a "fetch-trigger" bucket</b> — the query categories that force AI engines to crawl the live web (explained inside).${leaderFetch ? ` ${esc(leader!.name)}: ${leaderFetch}.` : ""} These are the queries any brand can win, regardless of size.</p>`
      );
    }

    pages.push(`<div class="page cover">
  <div class="brandbar">
    <div class="c3logo">C3 <span>Marketing</span> Group<small>AI Content Intelligence</small></div>
    <div class="meta">
      Prepared for <b>${esc(project.clientName)} — Head of Content</b><br>
      Site audited: <b>${esc(client.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</b><br>
      Audit date: <b>${runDateStr}</b> &nbsp;·&nbsp; ${n} URL${n === 1 ? "" : "s"} scored
    </div>
  </div>
  <div class="cover-body">
    <div class="kicker">Content Readiness Assessment</div>
    <h1>How ready is your content for the <em>AI answer era?</em></h1>
    <p class="for">An 8-dimension audit of how well <b>${esc(client.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</b> performs when AI systems — ChatGPT, Perplexity, Google AI Overviews — retrieve, extract, cite, and reuse your content.${competitors.length ? ` Benchmarked against <b>${competitors.map((c) => esc(c.name)).join("</b> and <b>")}</b>.` : ""}</p>
    <div class="hero-wrap">
      <div class="dial">
        ${dialSvg(client.overall)}
        <div class="mid">
          <div class="num">${client.overall}</div>
          <div class="of">of 100 · site average</div>
          <div class="gr" style="color:${GRADE_COLOR[g]}">${chip(g, 26)} ${g === "A" || g === "B" ? GRADE_WORD[g] : "Not AI-ready"}</div>
        </div>
      </div>
      <div class="hero-copy">
        <p><b>${fCount === n ? "Every audited URL currently grades F for AI readiness." : fCount > n / 2 ? `${fCount} of the ${n} audited URLs grade F for AI readiness.` : `The site averages ${client.overall}/100 (${g}) for AI readiness.`}</b> ${DIM_GROUP[wd] === "machine" ? "Not because the underlying work is weak, but because the pages aren't structured the way retrieval systems need." : "The audit points to content depth — what the pages cover — more than to how they're built."}</p>
        ${heroP2}
      </div>
    </div>
    <div class="statrow">${statCells.join("")}</div>
    <div class="exec"><h3>Executive summary</h3>${execP.join("")}</div>
  </div>
  __FOOT__
</div>`);
  }

  // ═══ DIMENSIONS ═══
  {
    const bars = DIM_ORDER.map((d) => {
      const v = client.means[d];
      const col = GRADE_COLOR[gradeOf(v)];
      const tick = leader
        ? `<div class="cmark" style="left:calc(${leader.means[d]}% - 1px)"></div>`
        : "";
      return `<div class="dimbar">
      <div class="top"><span class="nm">${DIM_LABEL[d]}<small>${DIM_GROUP[d] === "quality" ? "content quality" : "machine usability"} · wt ${wpct(d)}</small></span><span class="sc">${v}<small style="color:#898781;font-weight:500"> /100</small></span></div>
      <div class="track"><div class="fill" style="width:${v}%;background:${col}"></div>${tick}</div>
    </div>`;
    }).join("");

    const legend = [`<span><span class="sw" style="background:${SERIES.client}"></span>${esc(client.name)}</span>`];
    if (competitors[0]) legend.push(`<span><span class="sw" style="background:${SERIES.comp1}"></span>${esc(competitors[0].name)}</span>`);
    if (competitors[1]) legend.push(`<span><span class="sw dash"></span>${esc(competitors[1].name)}</span>`);

    pages.push(`<div class="page">
  <div class="kicker">Section 01 · The Score</div>
  <h2 class="sec">Your 8-dimension LLM-readiness profile</h2>
  <p class="sec-sub">Every URL is scored 0–100 on eight dimensions by an AI analyst, then weighted into a page grade. Four dimensions measure <b>content quality</b> (does this page deserve to be the answer?) and four measure <b>machine usability</b> (can an AI system actually use it?).</p>
  <div class="dim-layout">
    <div class="radar-box">${radarSvg(client, competitors)}<div class="radar-legend">${legend.join("")}</div></div>
    <div class="dimbars">${bars}</div>
  </div>
  <div class="callout" style="margin-top:22px;"><b>Where to look first:</b> ${DIM_LABEL[weakDims[0]]} (${client.means[weakDims[0]]}) and ${DIM_LABEL[weakDims[1]]} (${client.means[weakDims[1]]}) are your two lowest scores${((w[weakDims[0]] ?? 0) as number) >= 0.15 ? `, and ${DIM_LABEL[weakDims[0]]} carries a ${wpct(weakDims[0])} weight — the maximum` : ""}. ${leader ? `The orange ticks show ${esc(leader.name)}'s average on each dimension${leaderDimLead === 8 ? " — they lead on all eight" : leaderDimLead > 0 ? ` — they lead on ${leaderDimLead} of eight` : ""}.` : ""}</div>
  __FOOT__
</div>`);
  }

  // ═══ GRADE DISTRIBUTION + URL TABLE (chunked) ═══
  {
    const cards = (["A", "B", "C", "D", "F"] as const)
      .map(
        (g) => `<div class="bcard"><div class="bar" style="background:${GRADE_COLOR[g]}"></div><div class="gl">${chip(g, 23)} ${GRADE_WORD[g]}</div><div class="pct">${pct(client.gradeCounts[g], n)}</div><div class="cnt">${client.gradeCounts[g]} of ${n} URLs</div></div>`
      )
      .join("");
    const segs = (["A", "B", "C", "D", "F"] as const)
      .filter((g) => client.gradeCounts[g] > 0)
      .map((g) => {
        const p = (client.gradeCounts[g] / n) * 100;
        return `<div class="seg" style="width:${p.toFixed(1)}%;background:${GRADE_COLOR[g]}">${p >= 18 ? `${g} · ${pct(client.gradeCounts[g], n)} of audited URLs` : g}</div>`;
      })
      .join("");
    const compContext = competitors.length
      ? ` For context: ${competitors
          .map((c) => {
            const parts = (["A", "B", "C", "D", "F"] as const)
              .filter((g) => c.gradeCounts[g] > 0)
              .map((g) => `${pct(c.gradeCounts[g], c.pages.length)} ${g}`);
            return `${esc(c.name)} is ${parts.join(" / ")}`;
          })
          .join("; ")}.`
      : "";

    const row = (p: PageScore): string => `<tr>
    <td class="url" title="${esc(p.url)}">${esc(shortUrl(p.url, client.url))}</td>
    <td class="c ov">${p.overallScore}</td>
    <td class="c">${chip(p.grade)}</td>
    <td class="c">${p.intentBuckets == null ? '<span class="btag bt-none">n/a</span>' : p.primaryBucket ? `<span class="btag bt-${p.primaryBucket}">${p.primaryBucket}</span>` : '<span class="btag bt-none">—</span>'}</td>
    ${DIM_ORDER.map((d) => `<td class="c">${heatCell(p.scores[d] ?? 0)}</td>`).join("")}
  </tr>`;

    const thead = `<thead><tr>
      <th style="width:196px">URL</th><th class="c" style="width:38px">Score</th><th class="c" style="width:38px">Grade</th><th class="c" style="width:84px">Bucket</th>
      ${DIM_ORDER.map((d) => `<th class="c">${DIM_SHORT[d].replace("Implied Qs", "Impl.Q").replace("Fan-out", "Fan")}</th>`).join("")}
    </tr></thead>`;

    const legendNote = `<p style="font-size:10px;color:var(--ink-3);margin-top:8px;">Dimension cells shade darker as scores rise (0–100). Bucket = dominant fetch-trigger category (n/a = scored before classification shipped).</p>`;

    const first = client.pages.slice(0, 14);
    pages.push(`<div class="page">
  <div class="kicker">Section 02 · Where Every URL Lands</div>
  <h2 class="sec">Grade distribution across your ${n} URL${n === 1 ? "" : "s"}</h2>
  <p class="sec-sub">Each URL's weighted score maps to a letter grade: A (85–100), B (70–84), C (55–69), D (40–54), F (0–39). The shape of this distribution matters more than the average — AI engines cite individual pages, not site averages.</p>
  <div class="bucket-cards">${cards}</div>
  <div class="stackbar">${segs}</div>
  <p class="stack-cap">Median page score: <b>${med} (${gradeOf(med)})</b> · Range: ${client.pages[client.pages.length - 1].overallScore}–${client.pages[0].overallScore}.${compContext}</p>
  <table class="pages">${thead}<tbody>${first.map(row).join("")}</tbody></table>
  ${client.pages.length > 14 ? `<p style="font-size:10.5px;color:var(--ink-3);margin-top:8px;">Continued on the next page…</p>` : legendNote}
  __FOOT__
</div>`);
    let rest = client.pages.slice(14);
    while (rest.length) {
      const chunk = rest.slice(0, 24);
      rest = rest.slice(24);
      pages.push(`<div class="page">
  <div class="kicker">Section 02 · Continued</div>
  <h2 class="sec" style="font-size:19px;">All audited URLs (continued)</h2>
  <table class="pages" style="margin-top:14px;">${thead}<tbody>${chunk.map(row).join("")}</tbody></table>
  ${rest.length ? "" : legendNote}
  __FOOT__
</div>`);
    }
  }

  // ═══ EDUCATION: WHAT LLMS LOOK FOR ═══
  {
    const eduCard = (d: ScoreDimension, ico: string, note: string): string => {
      const v = client.means[d];
      return `<div class="edu-card">
      <h4><span class="ico">${ico}</span>${DIM_LABEL[d]} <small style="color:var(--ink-3);font-weight:500">· ${DIM_GROUP[d]}</small></h4>
      <p>${EDU_BODY[d]}</p>
      <div class="yours">You: <span class="pill" style="color:${GRADE_COLOR[gradeOf(v)]}">${v}</span> — ${note}</div>
    </div>`;
    };
    const rank = (d: ScoreDimension): string => {
      const pos = weakDims.indexOf(d);
      if (pos === 0) return "your lowest score.";
      if (pos === 1) return "your second-lowest score.";
      if (pos === weakDims.length - 1) return `your strongest dimension${client.means[d] < 50 ? ", still below the 50–70 “average content” band" : ""}.`;
      return client.means[d] < 40 ? "well below the 50–70 “average content” band." : "room to climb toward the 70+ band engines favor.";
    };
    pages.push(`<div class="page">
  <div class="kicker">Section 03 · How AI Reads Your Content</div>
  <h2 class="sec">What LLMs are actually looking for</h2>
  <p class="sec-sub" style="margin-bottom:16px;">AI engines don't read pages the way people do. They break each page into chunks, embed those chunks in a searchable index, pull the few passages that best match a question, and compose an answer — naming only the sources that survived every step. Your content has to win four times in a row:</p>
  <div class="depth-strip">
    <div class="depth-step"><div class="n">STEP 1</div><b>Retrieve</b>Clear headings and semantic structure decide whether your chunk is even found. No H1→H2→H3 skeleton, no retrieval.</div>
    <div class="depth-step"><div class="n">STEP 2</div><b>Extract</b>Facts must live in clean prose. Anything trapped in images, charts, or JS-only widgets is invisible.</div>
    <div class="depth-step"><div class="n">STEP 3</div><b>Trust</b>Author, date, sources, and canonical URL are the credibility signals that make a passage safe to cite.</div>
    <div class="depth-step"><div class="n">STEP 4</div><b>Reuse</b>Each section must stand alone — the engine quotes chunks, and “as mentioned above” dies out of context.</div>
  </div>
  <p class="sec-sub" style="margin-bottom:12px;"><b style="color:var(--ink-1)">Depth separates a page that gets cited from one that gets skipped.</b> Thin “what is X” content loses to content that reads like the work of someone who has done the thing — the eight dimensions below measure that:</p>
  <div class="edu-grid">
    ${eduCard("coreIntent", "🎯", rank("coreIntent"))}
    ${eduCard("edgeCases", "⚠️", rank("edgeCases"))}
    ${eduCard("impliedQuestions", "❓", rank("impliedQuestions"))}
    ${eduCard("fanOutQueries", "🕸️", rank("fanOutQueries"))}
    ${eduCard("retrievable", "🔍", rank("retrievable"))}
    ${eduCard("extractable", "📦", rank("extractable"))}
    ${eduCard("citable", "🏛️", rank("citable"))}
    ${eduCard("reusable", "🧩", rank("reusable"))}
  </div>
  __FOOT__
</div>`);
  }

  // ═══ FETCH-TRIGGER BUCKETS ═══
  {
    const covRow = (who: string, count: number, of: number, color: string): string => {
      const p = of ? (count / of) * 100 : 0;
      return `<div class="row"><span class="who">${esc(who)}</span><span class="bar-t"><span class="bar-f" style="width:${p.toFixed(1)}%;background:${color}"></span></span><span class="val">${count} of ${of}</span></div>`;
    };
    const fcard = (b: IntentBucket): string => {
      const m = BUCKET_META[b];
      const rows = [covRow("You", client.bucketCounts[b], n, SERIES.client)];
      if (competitors[0]) rows.push(covRow(competitors[0].name, competitors[0].bucketCounts[b], competitors[0].pages.length, SERIES.comp1));
      if (competitors[1]) rows.push(covRow(competitors[1].name, competitors[1].bucketCounts[b], competitors[1].pages.length, SERIES.ctx));
      return `<div class="fcard">
      <h4>${b.charAt(0).toUpperCase() + b.slice(1)} <span class="btag ${m.tagClass}">${m.tag}</span></h4>
      <div class="q">${m.examples.replace("{year}", String((data.runDate ?? data.generatedAt).getFullYear()))}</div>
      <p>${m.body}</p>
      <div class="cov">${rows.join("")}</div>
    </div>`;
    };
    const emptyBuckets = BUCKETS.filter((b) => client.bucketCounts[b] === 0);
    const calloutBody = classified
      ? `only <b>${client.fetchEligible} of your ${n} URL${n === 1 ? "" : "s"} (${fetchPct})</b> sit in any fetch-trigger bucket${emptyBuckets.length ? `, and <b>none</b> in ${emptyBuckets.map((b) => b.charAt(0).toUpperCase() + b.slice(1)).join(", ")}` : ""}.${leader && leader.classifiedCount > 0 ? ` ${esc(leader.name)} has <b>${pct(leader.fetchEligible, leader.pages.length)}</b> of its audited pages in these buckets.` : ""} Every quarter without fetch-bucket content is a quarter of answer-element opportunities conceded uncontested.${client.fetchEligible > 0 ? ` Your ${client.fetchEligible} bucket page${client.fetchEligible === 1 ? " is" : "s are"} an existing beachhead — structural fixes first, then expand the set.` : ""}`
      : `this run predates bucket classification — re-run the audit to see which of your URLs sit in fetch-trigger territory.`;
    pages.push(`<div class="page">
  <div class="kicker">Section 04 · The Winnable Queries</div>
  <h2 class="sec">Fetch-trigger buckets: where AI must come to the web</h2>
  <p class="sec-sub">For most questions, an AI engine answers from what it already knows — and cites nobody. But four categories of query <b>force it to fetch live web content</b>, because the answer goes stale: that fetch is the moment your page can be pulled in and cited in the answer element. Content in these buckets isn't just discoverable — it's <b>winnable</b>, even against bigger brands, because the engine is actively shopping for the best-structured current answer.</p>
  <div class="fetch-cards">${fcard("recency")}${fcard("ranking")}${fcard("comparison")}${fcard("local")}</div>
  <div class="callout"><b>Why this matters strategically:</b> ${calloutBody}</div>
  __FOOT__
</div>`);
  }

  // ═══ COMPETITORS (only when present) ═══
  if (competitors.length) {
    const heat = (v: number): string => heatCell(v, true);
    const delta = (a: number, b: number): string => {
      const d = a - b;
      if (!d) return '<span class="delta" style="color:#898781">±0</span>';
      return d > 0 ? `<span class="delta neg">+${d}</span>` : `<span class="delta pos">${d}</span>`;
    };
    const shown = competitors.slice(0, 3);
    const rows =
      DIM_ORDER.map(
        (d) =>
          `<tr><td>${DIM_LABEL[d]}<small>wt ${wpct(d)}</small></td><td>${heat(client.means[d])}</td>${shown.map((c) => `<td>${heat(c.means[d])}${delta(c.means[d], client.means[d])}</td>`).join("")}</tr>`
      ).join("") +
      `<tr style="border-top:2px solid var(--brand-ink)"><td style="font-weight:800">Site average<small>weighted</small></td><td style="font-weight:800;font-size:14px">${client.overall}</td>${shown.map((c) => `<td style="font-weight:800;font-size:14px">${c.overall}${delta(c.overall, client.overall)}</td>`).join("")}</tr>`;

    const card = (c: SiteAggregate, i: number): string => {
      const leads = DIM_ORDER.filter((d) => c.means[d] > client.means[d]);
      const gap = DIM_ORDER.map((d) => ({ d, g: c.means[d] - client.means[d] })).sort((a, b) => b.g - a.g)[0];
      const best = c.pages[0];
      const ahead = c.overall > client.overall;
      const buckets = BUCKETS.filter((b) => c.bucketCounts[b] > 0)
        .map((b) => `${c.bucketCounts[b]} ${b}`)
        .join(", ");
      return `<div class="ccard">
      <h4><span class="sw" style="background:${i === 0 ? SERIES.comp1 : SERIES.ctx}"></span>${esc(c.name)} — ${ahead ? "the one to watch" : "behind you, for now"}</h4>
      <div class="score-line">Site avg <b>${c.overall} (${gradeOf(c.overall)})</b> · best page <b>${best ? `${best.overallScore} (${best.grade})` : "—"}</b> · ${pct(c.pages.length - c.gradeCounts.F, c.pages.length)} of pages at D or better</div>
      <p>${ahead ? `Leads you on <b>${leads.length} of 8 dimensions</b>, widest on <b>${DIM_LABEL[gap.d]} (+${gap.g})</b>.` : `You lead on ${8 - leads.length} of 8 dimensions${leads.length ? `; they still edge you on ${leads.map((d) => DIM_LABEL[d]).join(", ")}` : ""}.`}${buckets ? ` Fetch-bucket coverage: ${buckets}.` : ""} ${ahead ? `Their weakness: ${DIM_LABEL[[...DIM_ORDER].sort((a, b) => c.means[a] - c.means[b])[0]]} (${c.means[[...DIM_ORDER].sort((a, b) => c.means[a] - c.means[b])[0]]}) — that race is still open.` : `The caution: rankings in this space move fast, and a structured-content push on their side would close the gap.`}</p>
    </div>`;
    };

    pages.push(`<div class="page">
  <div class="kicker">Section 05 · The Competitive Picture</div>
  <h2 class="sec">Where competitors ${leaderDimLead >= 5 ? "are beating you" : "stand"} — dimension by dimension</h2>
  <p class="sec-sub">Same crawler, same scoring model, same run for all ${1 + shown.length} domains — these numbers are directly comparable. Cells shade darker as scores rise; the Δ shows each competitor's lead (red) or deficit (green) against you.</p>
  <table class="matrix"><thead><tr><th>Dimension</th><th>${esc(client.name)} (you)</th>${shown.map((c) => `<th>${esc(c.name)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
  <div class="comp-cards">${shown.slice(0, 2).map(card).join("")}</div>
  <div class="callout" style="margin-top:20px;"><b>The race for the answer element:</b> ${[client, ...shown].every((s) => s.overall < 70) ? "in this competitive set nobody is AI-ready — the best site average is " + (gradeOf(Math.max(client.overall, ...shown.map((c) => c.overall))) + " territory. That is the opportunity: the first brand to pair real content depth with machine-readable structure inherits the citations in this category.") : "the bar in this set is rising — the fix list on the next page is how you keep pace and pass it."}</div>
  __FOOT__
</div>`);
  }

  // ═══ TOP ISSUES ═══
  {
    const mix = `<div class="prio-mix">
    <div class="pm" style="background:#d03b3b"><div class="v">${recByPriority.critical ?? 0}</div><div class="l">Critical recommendations</div></div>
    <div class="pm" style="background:#ec835a"><div class="v">${recByPriority.high ?? 0}</div><div class="l">High priority</div></div>
    <div class="pm" style="background:#eda100"><div class="v">${(recByPriority.medium ?? 0) + (recByPriority.low ?? 0)}</div><div class="l">Medium / low</div></div>
  </div>`;
    const issueHtml = issues
      .map((it, i) => {
        const c = ISSUE_COPY[it.d];
        const ev = i === 0 ? evidenceFor(it.d) : null;
        const gapTag =
          biggestGap && biggestGap.d === it.d && biggestGap.gap > 5
            ? `<span class="tag">competitive gap #1</span>`
            : "";
        return `<div class="issue">
    <div class="rank">${i + 1}</div>
    <div>
      <h4>${c.title}</h4>
      <p>${c.body} ${c.fix}</p>
      <div class="meta"><span class="tag hot">${DIM_LABEL[it.d]} · wt ${wpct(it.d)}</span><span class="tag">site avg ${it.score}</span>${it.recs ? `<span class="tag">${it.recs} rec${it.recs === 1 ? "" : "s"}</span>` : ""}<span class="tag">${it.affected} of ${n} URLs below 50</span>${gapTag}</div>
      ${ev ? `<p class="ev">Auditor evidence: “${esc(ev)}”</p>` : ""}
    </div>
  </div>`;
      })
      .join("");
    pages.push(`<div class="page">
  <div class="kicker">Section ${competitors.length ? "06" : "05"} · The Fix List</div>
  <h2 class="sec">Top issues to fix, in priority order</h2>
  <p class="sec-sub" style="margin-bottom:16px;">The audit generated ${allRecs.length} page-level recommendations across your ${n} URL${n === 1 ? "" : "s"}. Clustered by root cause and ranked by weighted-score impact, they collapse into ${issues.length} site-wide issues:</p>
  ${mix}
  ${issueHtml}
  __FOOT__
</div>`);
  }

  // ═══ QUICK WINS + ROADMAP + METHODOLOGY ═══
  {
    const qw = quickWins.length
      ? quickWins
          .map((x) => {
            const worst = [...DIM_ORDER].sort((a, b) => (x.p.scores[a] ?? 0) - (x.p.scores[b] ?? 0))[0];
            const bestDim = [...DIM_ORDER].sort((a, b) => (x.p.scores[b] ?? 0) - (x.p.scores[a] ?? 0))[0];
            return `<div class="qw">
    <div class="from-to">${chip(x.p.grade, 23)}<span class="arrow">→</span>${chip(x.next, 23)}</div>
    <div class="body"><b>${esc(shortUrl(x.p.url, client.url))} — ${x.p.overallScore}, ${x.gap} point${x.gap === 1 ? "" : "s"} from a ${x.next}.</b> ${DIM_LABEL[worst]} (${x.p.scores[worst]}) is the drag; ${DIM_LABEL[bestDim]} is already ${x.p.scores[bestDim]} — the strength to build on.</div>
  </div>`;
          })
          .join("")
      : `<p class="sec-sub">No page currently sits within striking distance (≤9 points) of the next grade band — the roadmap below moves the whole distribution instead.</p>`;

    const topIssueNames = issues.slice(0, 3).map((it) => ISSUE_COPY[it.d].title.split(" — ")[0].toLowerCase());
    pages.push(`<div class="page">
  <div class="kicker">Section ${competitors.length ? "07" : "06"} · The Path Forward</div>
  <h2 class="sec">Quick wins, then the 90-day plan</h2>
  <p class="sec-sub">${quickWins.length ? `${quickWins.length === 1 ? "One URL sits" : quickWins.length + " URLs sit"} within a few points of the next grade band — the fastest visible proof that this program works:` : "How the program sequences:"}</p>
  ${qw}
  <div class="phases" style="margin-top:22px;">
    <div class="phase"><div class="ph">DAYS 0–30</div><b>Structure sprint</b><ul><li>Fix ${topIssueNames[0] ?? "the top structural issue"} across all ${n} audited URL${n === 1 ? "" : "s"}</li><li>Bylines + publication dates site-wide</li>${quickWins.length ? "<li>Ship the quick wins above</li>" : "<li>Re-score to confirm the baseline moves</li>"}</ul></div>
    <div class="phase"><div class="ph">DAYS 31–60</div><b>Depth pass</b><ul><li>Address ${topIssueNames[1] ?? "the second issue"} on the highest-traffic pages</li><li>FAQ blocks answering the natural follow-up questions</li><li>Standalone-section edit on your strongest assets</li></ul></div>
    <div class="phase"><div class="ph">DAYS 61–90</div><b>Fetch-bucket offense</b><ul><li>Launch recency-anchored assets (annual benchmarks, “…in ${(data.runDate ?? data.generatedAt).getFullYear()}” guides)</li><li>${client.fetchEligible > 0 ? `Upgrade the ${client.fetchEligible} existing bucket page${client.fetchEligible === 1 ? "" : "s"} to genuine best-in-class answers` : "Stand up your first ranking / comparison pages"}</li><li>Re-audit and re-benchmark${competitors.length ? ` vs. ${competitors.map((c) => esc(c.name)).join(" & ")}` : ""}</li></ul></div>
  </div>
  <div class="method">
    <h4>Methodology &amp; data provenance</h4>
    <p>${[client, ...competitors].map((s) => `${s.pages.length} ${esc(s.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, ""))} URL${s.pages.length === 1 ? "" : "s"}`).join(", ")} were crawled and scored on ${runDateStr} by the C3 Content Audit engine${data.modelVersion ? ` (scoring model: ${esc(data.modelVersion)}, deterministic configuration${data.jobId ? `; audit job ${esc(data.jobId.slice(0, 8))}` : ""})` : ""}. Each URL is scored 0–100 on eight dimensions by an AI content analyst with page-level evidence retained for every score; dimension scores combine using the weights below into a page score, and letter grades map as A 85–100 · B 70–84 · C 55–69 · D 40–54 · F 0–39. The site score is the average of page scores. Intent-bucket classification follows the four fetch-trigger categories (recency, ranking, local, comparison), judged on body content rather than titles. All figures in this report are read directly from that audit run — none are modeled or projected.</p>
    <table><tr>${DIM_ORDER.map((d) => `<th>${DIM_LABEL[d]}</th>`).join("")}</tr><tr>${DIM_ORDER.map((d) => `<td>${wpct(d)}</td>`).join("")}</tr></table>
    <p style="color:var(--ink-3)">Prepared by C3 Marketing Group · thec3marketinggroup.com · Generated ${data.generatedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.</p>
  </div>
  __FOOT__
</div>`);
  }

  // page numbers
  const total = pages.length;
  const body = pages.map((p, i) => p.replace("__FOOT__", footer(i + 1, total))).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AI Content Readiness Assessment — ${esc(project.clientName)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function chipInline(g: string): string {
  return `<span style="color:${GRADE_COLOR[g]}">${g}</span>`;
}

const EDU_BODY: Record<ScoreDimension, string> = {
  coreIntent:
    "One page, one unambiguous job. If an LLM can't state what your page is <b>for</b> in a sentence, it won't risk citing it.",
  edgeCases:
    "Caveats, prerequisites, “when this doesn’t apply.” Qualified claims read as expertise — and LLMs are tuned to prefer them.",
  impliedQuestions:
    "Deep content answers the follow-up before it’s asked — the “how”, “why”, and “what if” behind the headline question.",
  fanOutQueries:
    "Pages that link into a connected topic neighborhood become the starting point for related questions. Isolated pages answer one query at best.",
  retrievable:
    "Heading hierarchy, key terms in real HTML, topic sentences up front. This is the plumbing every other dimension depends on.",
  extractable:
    "Key numbers and claims stated in text, not locked in graphics. If the fact isn't in prose, the engine never saw it.",
  citable:
    "Named author, visible date, external sources. Engines attribute answers to sources they can defend choosing.",
  reusable:
    "Self-contained sections with no “see above” dependencies — because the engine quotes the chunk, never the page.",
};

// ── Stylesheet (print-ready; Letter @ 96dpi = 816×1056) ───────

const CSS = `
  :root{
    --brand-ink:#0e2238; --brand-accent:#2a78d6; --brand-gold:#eda100;
    --surface:#fcfcfb; --page-plane:#eef0f2;
    --ink-1:#0b0b0b; --ink-2:#52514e; --ink-3:#898781;
    --grid:#e1e0d9; --hairline:rgba(11,11,11,.10);
    --g-a:#0ca30c; --g-b:#1baf7a; --g-c:#eda100; --g-d:#ec835a; --g-f:#d03b3b;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  html{background:var(--page-plane);}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink-1);background:var(--page-plane);-webkit-font-smoothing:antialiased;line-height:1.45;}
  .page{width:816px;min-height:1056px;margin:18px auto;background:var(--surface);box-shadow:0 2px 14px rgba(14,34,56,.13);position:relative;padding:44px 56px 74px;overflow:hidden;}
  .kicker{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--brand-gold);margin-bottom:6px;}
  h2.sec{font-size:25px;font-weight:750;letter-spacing:-.01em;color:var(--brand-ink);margin-bottom:4px;}
  .sec-sub{font-size:13.5px;color:var(--ink-2);max-width:640px;margin-bottom:26px;}
  .pfoot{position:absolute;left:56px;right:56px;bottom:26px;display:flex;justify-content:space-between;font-size:10.5px;color:var(--ink-3);border-top:1px solid var(--grid);padding-top:9px;}
  .pfoot b{color:var(--brand-ink);font-weight:650;}
  .callout{border-left:3px solid var(--brand-gold);background:#faf7ef;border-radius:0 8px 8px 0;padding:13px 16px;font-size:12.5px;color:var(--ink-2);}
  .callout b{color:var(--ink-1);}
  .grade-chip{display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:#fff;font-weight:800;flex:none;vertical-align:middle;}
  .tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10.5px;font-weight:650;border:1px solid var(--hairline);}
  .tag.hot{background:#fdeaea;border-color:transparent;color:#d03b3b;}
  .cover{padding:0;}
  .brandbar{background:var(--brand-ink);color:#fff;padding:28px 56px 24px;display:flex;justify-content:space-between;align-items:flex-start;}
  .c3logo{font-size:21px;font-weight:800;}
  .c3logo span{color:var(--brand-gold);}
  .c3logo small{display:block;font-size:10.5px;font-weight:500;letter-spacing:.22em;color:#9fb4cc;margin-top:3px;text-transform:uppercase;}
  .brandbar .meta{text-align:right;font-size:11.5px;color:#9fb4cc;line-height:1.7;}
  .brandbar .meta b{color:#fff;font-weight:600;}
  .cover-body{padding:32px 56px 0;}
  .cover h1{font-size:37px;line-height:1.13;font-weight:800;letter-spacing:-.015em;color:var(--brand-ink);max-width:560px;}
  .cover h1 em{font-style:normal;color:var(--brand-accent);}
  .cover .for{font-size:14.5px;color:var(--ink-2);margin:14px 0 28px;}
  .cover .for b{color:var(--ink-1);}
  .hero-wrap{display:flex;gap:38px;align-items:center;margin-bottom:26px;}
  .dial{position:relative;width:218px;height:218px;flex:none;}
  .dial svg{position:absolute;inset:0;}
  .dial .mid{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .dial .num{font-size:64px;font-weight:800;letter-spacing:-.03em;color:var(--brand-ink);line-height:1;}
  .dial .of{font-size:11.5px;color:var(--ink-3);margin-top:2px;}
  .dial .gr{margin-top:8px;display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;}
  .hero-copy{font-size:14px;color:var(--ink-2);}
  .hero-copy p{margin-bottom:12px;}
  .hero-copy b{color:var(--ink-1);}
  .statrow{display:flex;border:1px solid var(--grid);border-radius:10px;overflow:hidden;margin-bottom:24px;}
  .stat{flex:1;padding:15px 18px;border-right:1px solid var(--grid);}
  .stat:last-child{border-right:none;}
  .stat .v{font-size:23px;font-weight:750;color:var(--brand-ink);letter-spacing:-.01em;}
  .stat .v small{font-size:12px;color:var(--ink-3);font-weight:500;}
  .stat .l{font-size:10.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin-top:2px;}
  .stat .down{color:var(--g-f);} .stat .up{color:#006300;}
  .exec{font-size:13.5px;color:var(--ink-2);}
  .exec h3{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--brand-ink);margin-bottom:9px;}
  .exec p{margin-bottom:8px;}
  .exec b{color:var(--ink-1);}
  .dim-layout{display:flex;gap:34px;align-items:flex-start;}
  .radar-box{flex:none;width:372px;}
  .radar-legend{display:flex;gap:16px;justify-content:center;margin-top:6px;font-size:11.5px;color:var(--ink-2);}
  .radar-legend .sw{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:5px;}
  .radar-legend .sw.dash{height:0;border-top:3px dashed #898781;border-radius:0;}
  .dimbars{flex:1;}
  .dimbar{margin-bottom:13px;}
  .dimbar .top{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:3px;}
  .dimbar .nm{font-weight:650;color:var(--ink-1);}
  .dimbar .nm small{color:var(--ink-3);font-weight:500;margin-left:5px;}
  .dimbar .sc{font-weight:750;font-variant-numeric:tabular-nums;}
  .dimbar .track{height:9px;border-radius:5px;background:#f0efec;position:relative;}
  .dimbar .fill{height:100%;border-radius:5px;}
  .dimbar .cmark{position:absolute;top:-3px;width:2.5px;height:15px;border-radius:2px;background:#eb6834;}
  .bucket-cards{display:flex;gap:10px;margin-bottom:22px;}
  .bcard{flex:1;border:1px solid var(--grid);border-radius:10px;padding:13px 14px;position:relative;overflow:hidden;}
  .bcard .bar{position:absolute;left:0;top:0;bottom:0;width:4px;}
  .bcard .pct{font-size:26px;font-weight:800;letter-spacing:-.02em;color:var(--brand-ink);}
  .bcard .cnt{font-size:11px;color:var(--ink-3);margin-top:1px;}
  .bcard .gl{display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:650;margin-bottom:8px;color:var(--ink-2);}
  .stackbar{display:flex;height:34px;border-radius:8px;overflow:hidden;margin-bottom:8px;background:#f0efec;}
  .stackbar .seg{display:flex;align-items:center;justify-content:center;color:#fff;font-weight:750;font-size:12.5px;border-right:2px solid var(--surface);white-space:nowrap;overflow:hidden;}
  .stackbar .seg:last-child{border-right:none;}
  .stack-cap{font-size:11px;color:var(--ink-3);margin-bottom:24px;}
  table.pages{width:100%;border-collapse:collapse;font-size:10.5px;table-layout:fixed;}
  table.pages th{text-align:left;font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);font-weight:650;padding:0 3px 7px;border-bottom:1.5px solid var(--brand-ink);}
  table.pages th.c, table.pages td.c{text-align:center;}
  table.pages td{padding:6px 3px;border-bottom:1px solid var(--grid);vertical-align:middle;}
  table.pages td.url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-1);font-weight:550;}
  .heat{display:inline-block;width:24px;padding:2.5px 0;border-radius:4px;text-align:center;font-weight:650;font-variant-numeric:tabular-nums;font-size:10px;}
  td.ov{font-weight:800;font-size:12.5px;font-variant-numeric:tabular-nums;}
  .btag{font-size:9.5px;font-weight:700;letter-spacing:.04em;padding:2px 7px;border-radius:10px;text-transform:uppercase;}
  .bt-comparison{background:#e8f0fb;color:#1c5cab;}
  .bt-ranking{background:#fdf1e3;color:#a35b00;}
  .bt-recency{background:#eaf7f1;color:#0f7a52;}
  .bt-local{background:#efeaf9;color:#4a3aa7;}
  .bt-none{background:#f2f1ee;color:#898781;}
  .edu-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:0;}
  .edu-card{border:1px solid var(--grid);border-radius:10px;padding:11px 14px;}
  .edu-card h4{font-size:13px;font-weight:750;color:var(--brand-ink);margin-bottom:3px;display:flex;align-items:center;gap:8px;}
  .edu-card h4 .ico{width:24px;height:24px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:none;background:#e8f0fb;}
  .edu-card p{font-size:11.2px;line-height:1.35;color:var(--ink-2);}
  .edu-card p b{color:var(--ink-1);}
  .edu-card .yours{margin-top:6px;padding-top:6px;border-top:1px dashed var(--grid);font-size:11px;color:var(--ink-2);}
  .yours .pill{font-weight:800;font-variant-numeric:tabular-nums;}
  .depth-strip{display:flex;border:1px solid var(--grid);border-radius:10px;overflow:hidden;margin-bottom:12px;}
  .depth-step{flex:1;padding:10px 13px;border-right:1px solid var(--grid);font-size:10.8px;line-height:1.35;color:var(--ink-2);}
  .depth-step:last-child{border-right:none;}
  .depth-step .n{font-size:10px;font-weight:800;color:var(--brand-gold);letter-spacing:.1em;margin-bottom:4px;}
  .depth-step b{color:var(--ink-1);display:block;margin-bottom:3px;font-size:12px;}
  .fetch-cards{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-bottom:20px;}
  .fcard{border:1px solid var(--grid);border-radius:10px;padding:15px 16px;}
  .fcard h4{font-size:14px;font-weight:750;color:var(--brand-ink);display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}
  .fcard .q{font-size:11px;color:var(--ink-3);font-style:italic;margin-bottom:7px;}
  .fcard p{font-size:11.5px;color:var(--ink-2);margin-bottom:10px;}
  .fcard .cov{font-size:10.8px;color:var(--ink-2);}
  .cov .row{display:flex;align-items:center;gap:8px;margin-bottom:4px;}
  .cov .who{width:64px;flex:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .cov .bar-t{flex:1;height:7px;background:#f0efec;border-radius:4px;overflow:hidden;display:block;}
  .cov .bar-f{display:block;height:100%;border-radius:4px;}
  .cov .val{width:52px;flex:none;text-align:right;font-variant-numeric:tabular-nums;font-weight:650;}
  table.matrix{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;}
  table.matrix th{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);font-weight:650;padding:0 8px 8px;border-bottom:1.5px solid var(--brand-ink);text-align:center;}
  table.matrix th:first-child{text-align:left;}
  table.matrix td{padding:7.5px 8px;border-bottom:1px solid var(--grid);text-align:center;font-variant-numeric:tabular-nums;}
  table.matrix td:first-child{text-align:left;font-weight:600;color:var(--ink-1);}
  table.matrix td:first-child small{color:var(--ink-3);font-weight:450;margin-left:4px;}
  .delta{font-size:10.5px;font-weight:750;margin-left:5px;}
  .delta.neg{color:var(--g-f);} .delta.pos{color:#006300;}
  .comp-cards{display:flex;gap:13px;}
  .ccard{flex:1;border:1px solid var(--grid);border-radius:10px;padding:14px 16px;font-size:11.5px;color:var(--ink-2);}
  .ccard h4{font-size:13.5px;color:var(--ink-1);font-weight:750;display:flex;align-items:center;gap:8px;margin-bottom:6px;}
  .ccard h4 .sw{width:11px;height:11px;border-radius:3px;flex:none;}
  .ccard .score-line{font-size:12px;margin-bottom:7px;color:var(--ink-1);}
  .ccard p b{color:var(--ink-1);}
  .prio-mix{display:flex;gap:10px;margin-bottom:16px;}
  .pm{flex:1;border-radius:10px;padding:10px 14px;color:#fff;}
  .pm .v{font-size:22px;font-weight:800;}
  .pm .l{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:650;opacity:.9;}
  .issue{display:flex;gap:13px;border:1px solid var(--grid);border-radius:10px;padding:10px 14px;margin-bottom:8px;}
  .issue .rank{flex:none;width:30px;height:30px;border-radius:8px;background:var(--brand-ink);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;}
  .issue h4{font-size:13.5px;font-weight:750;color:var(--ink-1);margin-bottom:3px;}
  .issue p{font-size:11.2px;line-height:1.35;color:var(--ink-2);margin-bottom:5px;}
  .issue p b{color:var(--ink-1);}
  .issue .meta{display:flex;gap:7px;flex-wrap:wrap;}
  .issue .ev{font-size:10.5px;color:var(--ink-3);font-style:italic;margin-top:6px;margin-bottom:0;}
  .qw{border:1px solid var(--grid);border-radius:10px;padding:14px 16px;margin-bottom:11px;display:flex;gap:14px;align-items:center;}
  .qw .from-to{flex:none;display:flex;align-items:center;gap:7px;font-weight:800;font-size:13px;}
  .qw .arrow{color:var(--ink-3);font-weight:400;}
  .qw .body{font-size:11.8px;color:var(--ink-2);}
  .qw .body b{color:var(--ink-1);}
  .phases{display:flex;gap:13px;margin-bottom:24px;}
  .phase{flex:1;border:1px solid var(--grid);border-radius:10px;padding:14px 15px;font-size:11.3px;color:var(--ink-2);}
  .phase .ph{font-size:10px;font-weight:800;letter-spacing:.1em;color:var(--brand-gold);margin-bottom:4px;}
  .phase b{color:var(--ink-1);display:block;font-size:12.5px;margin-bottom:5px;}
  .phase ul{margin-left:15px;}
  .phase li{margin-bottom:3px;}
  .method{font-size:11px;color:var(--ink-2);border-top:1px solid var(--grid);padding-top:16px;}
  .method h4{font-size:11px;letter-spacing:.11em;text-transform:uppercase;color:var(--brand-ink);margin-bottom:8px;}
  .method p{margin-bottom:7px;}
  .method table{border-collapse:collapse;margin:8px 0 10px;font-size:10.5px;}
  .method td,.method th{border:1px solid var(--grid);padding:4px 8px;text-align:center;}
  .method th{background:#f6f5f2;font-weight:650;color:var(--ink-2);}
  @page{size:Letter;margin:0;}
  @media print{
    html,body{background:#fff;}
    .page{margin:0 auto;box-shadow:none;page-break-after:always;width:816px;min-height:1040px;}
    .page:last-child{page-break-after:auto;}
  }
`;
