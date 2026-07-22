// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/research  { dimension, refresh? }
//
//  Live-web research for the optimize workbench: Claude searches
//  the real web (Anthropic web_search server tool) for material
//  relevant to ONE dimension of this page's topic and returns
//  3–6 suggestion cards, each carrying the REAL source URL it
//  came from.
//
//  Honesty guarantee: after the call, every suggestion's source
//  host is checked against the URLs that actually appeared in the
//  search results — a suggestion whose "source" never showed up
//  in a real search result is dropped. Nothing invented survives.
//
//  Cost control: results are cached per (page, dimension) and a
//  fresh web-search call counts against OPTIMIZE_RESEARCH_DAILY_CAP
//  per project per 24h.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import {
  getPageForOptimize,
  getLatestResearch,
  insertResearch,
  countRecentResearch,
} from "@/lib/db/drafts";
import type { ResearchSuggestion } from "@/lib/db/drafts";
import { DIMENSION_LABELS } from "@/lib/types";
import type { ScoreDimension, Recommendation } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: { pageId: string } };

const RESEARCH_MODEL =
  process.env.SCORING_MODEL ?? "claude-haiku-4-5-20251001";
const DAILY_CAP = parseInt(process.env.OPTIMIZE_RESEARCH_DAILY_CAP ?? "20", 10);
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Only content dimensions where outside facts help. Structural dimensions
// (coreIntent, retrievable, extractable, reusable) are served by AI rewrite.
const DIRECTIVES: Partial<Record<ScoreDimension, string>> = {
  edgeCases:
    "Search for documented edge cases, exceptions, failure modes, prerequisites, and caveats related to this topic. Prefer official documentation, standards bodies, and reputable industry sources.",
  impliedQuestions:
    "Search for the questions people actually ask about this topic — FAQ pages, 'people also ask' style questions, forum threads, help-center articles.",
  fanOutQueries:
    "Search for adjacent subtopics and closely related queries around this topic — the neighboring subjects a strong page on this topic should reference or link to.",
  citable:
    "Search for authoritative, citable sources on this topic — official documentation, standards bodies, peer-reviewed or institutional research, and primary-source industry reports worth citing inline.",
  paaCoverage:
    "Search for the exact question-form queries people ask about this topic — 'People Also Ask' questions, question keywords with search volume, FAQ and forum questions. Prefer questions phrased the way searchers actually type them (what is / how does / how much / can I).",
};

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));
    const dimension = body?.dimension as ScoreDimension | undefined;
    const refresh = body?.refresh === true;

    if (!dimension || !DIRECTIVES[dimension]) {
      return NextResponse.json(
        { error: "dimension must be one of: edgeCases, impliedQuestions, fanOutQueries, citable" },
        { status: 400 }
      );
    }

    const bundle = await getPageForOptimize(params.pageId);
    if (!bundle || !bundle.projectId) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    // Cache first — repeat opens are free.
    const cached = await getLatestResearch(params.pageId, dimension);
    if (cached && !refresh && Date.now() - cached.createdAt.getTime() < CACHE_TTL_MS) {
      return NextResponse.json({
        suggestions: cached.suggestions,
        cached: true,
        fetchedAt: cached.createdAt.toISOString(),
        modelVersion: cached.modelVersion,
      });
    }

    const used = await countRecentResearch(bundle.projectId);
    if (used >= DAILY_CAP) {
      return NextResponse.json(
        { error: `Daily research limit reached (${DAILY_CAP}/24h for this project). Cached results are still available.` },
        { status: 429 }
      );
    }

    const page = bundle.page;
    const headingList = page.headings
      .slice(0, 8)
      .map((h) => `- ${h.text}`)
      .join("\n");

    // The auditor's own findings for this dimension — searches should target
    // the SPECIFIC gaps it named (e.g. "what happens if denied"), not just
    // generic topic material. Closing named gaps is what moves the score.
    const findings = await loadDimensionFindings(params.pageId, dimension);
    const findingsBlock = findings.rationale || findings.recommendations.length
      ? `## What the audit found on ${DIMENSION_LABELS[dimension]} for THIS page
${findings.rationale ? `Auditor rationale: ${findings.rationale}` : ""}
${findings.recommendations.map((r) => `Recommendation [${r.priority}]: ${r.suggestion}`).join("\n")}

The gaps named above are your PRIMARY search targets — turn each named missing scenario/topic into its own search (e.g. if the auditor says the page misses "what happens if denied", search for exactly that). Only after covering the named gaps, add other high-value items.`
      : "";

    const userMessage = `${DIRECTIVES[dimension]}

## The page being optimized
URL: ${page.url}
Title: ${page.title || "(none)"}
Meta description: ${page.metaDescription || "(none)"}
Main headings:
${headingList || "(none)"}
Opening content: ${page.bodyText.slice(0, 600)}

${findingsBlock}

## Your task
1. Derive the page's core topic from the details above.
2. Use web_search (up to 4 searches) to find REAL, current material — prioritizing the auditor's named gaps when present.
3. Finish by calling record_research_suggestions with 3–6 suggestions.

Hard rules:
- Every suggestion MUST come from an actual search result and carry that exact result's URL as sourceUrl and its title as sourceTitle.
- Summaries paraphrase what the source says. Never add numbers, dates, or claims that are not in the search results.
- If the searches surface fewer than 3 usable items, record fewer — even zero. Never pad with invented items.`;

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 95_000,
      maxRetries: 1,
    });

    // The web_search server tool postdates this SDK version's type defs —
    // the API accepts it; we cast past the local types.
    const tools = [
      { type: "web_search_20250305", name: "web_search", max_uses: 4 },
      RECORD_TOOL,
    ] as unknown as Parameters<typeof anthropic.messages.create>[0]["tools"];

    const response = await anthropic.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 4096,
      temperature: 0,
      system:
        "You are a meticulous research assistant for a content-optimization tool. You only report what the web searches actually returned, with exact source attribution. You always finish by calling the record_research_suggestions tool.",
      tools,
      messages: [{ role: "user", content: userMessage }],
    });

    // Hosts that actually appeared in real search results — the provenance
    // allowlist for the model's recorded suggestions.
    const seenHosts = collectSearchResultHosts(response.content as unknown[]);

    const recorded = extractRecordedSuggestions(response.content as unknown[]);
    if (!recorded) {
      return NextResponse.json(
        { error: "Research returned no structured results — try again" },
        { status: 502 }
      );
    }

    const suggestions = sanitizeSuggestions(recorded, seenHosts);
    if (suggestions.length === 0) {
      return NextResponse.json(
        { error: "No verifiable suggestions found for this topic — try again or pick another dimension" },
        { status: 502 }
      );
    }

    const saved = await insertResearch({
      pageId: params.pageId,
      projectId: bundle.projectId,
      dimension,
      suggestions,
      modelVersion: RESEARCH_MODEL,
    });

    return NextResponse.json({
      suggestions: saved.suggestions,
      cached: false,
      fetchedAt: saved.createdAt.toISOString(),
      modelVersion: RESEARCH_MODEL,
    });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/research POST]`, err);
    return NextResponse.json({ error: "Research failed — please try again" }, { status: 500 });
  }
}

// ── Auditor findings for one dimension ────────────────────────

interface DimensionFindings {
  rationale?: string;
  recommendations: Recommendation[];
}

async function loadDimensionFindings(
  pageId: string,
  dimension: ScoreDimension
): Promise<DimensionFindings> {
  const out: DimensionFindings = { recommendations: [] };
  if (!process.env.DATABASE_URL) return out;
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
  const rows = await sql`
    SELECT rationale, recommendations FROM page_scores
    WHERE page_id = ${pageId} AND model_version <> 'error'
    ORDER BY scored_at DESC
    LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const r = rows[0];
  if (!r) return out;
  const rationale = (r.rationale as Record<string, string>) ?? {};
  if (rationale[dimension]) out.rationale = rationale[dimension];
  out.recommendations = ((r.recommendations as Recommendation[]) ?? [])
    .filter((rec) => rec.dimension === dimension)
    .slice(0, 4);
  return out;
}

// ── Record tool definition ────────────────────────────────────

const RECORD_TOOL = {
  name: "record_research_suggestions",
  description:
    "Record the research suggestions found via web search. Every suggestion must correspond to an actual search result.",
  input_schema: {
    type: "object" as const,
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        minItems: 0,
        maxItems: 6,
        items: {
          type: "object",
          required: ["title", "summary", "sourceUrl", "sourceTitle"],
          properties: {
            title: { type: "string", description: "Short suggestion headline (≤80 chars)" },
            summary: {
              type: "string",
              description: "1–2 sentence paraphrase of what the source says (≤300 chars)",
            },
            sourceUrl: { type: "string", description: "Exact URL of the search result this came from" },
            sourceTitle: { type: "string", description: "Title of the source page" },
          },
        },
      },
    },
  },
};

// ── Response parsing (SDK types predate server tools — parse loosely) ──

function collectSearchResultHosts(content: unknown[]): Set<string> {
  const hosts = new Set<string>();
  for (const block of content) {
    const b = block as { type?: string; content?: unknown };
    if (b?.type !== "web_search_tool_result") continue;
    const results = Array.isArray(b.content) ? b.content : [];
    for (const r of results) {
      const url = (r as { url?: string })?.url;
      if (typeof url === "string") {
        try {
          hosts.add(new URL(url).hostname.replace(/^www\./, ""));
        } catch {
          // skip
        }
      }
    }
  }
  return hosts;
}

function extractRecordedSuggestions(content: unknown[]): unknown[] | null {
  // Last tool_use named record_research_suggestions wins.
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as { type?: string; name?: string; input?: { suggestions?: unknown } };
    if (b?.type === "tool_use" && b?.name === "record_research_suggestions") {
      return Array.isArray(b.input?.suggestions) ? (b.input!.suggestions as unknown[]) : [];
    }
  }
  return null;
}

function sanitizeSuggestions(raw: unknown[], seenHosts: Set<string>): ResearchSuggestion[] {
  const out: ResearchSuggestion[] = [];
  for (const item of raw) {
    const s = item as Record<string, unknown>;
    const title = typeof s.title === "string" ? s.title.trim().slice(0, 120) : "";
    const summary = typeof s.summary === "string" ? s.summary.trim().slice(0, 400) : "";
    const sourceUrl = typeof s.sourceUrl === "string" ? s.sourceUrl.trim() : "";
    const sourceTitle =
      typeof s.sourceTitle === "string" ? s.sourceTitle.trim().slice(0, 160) : "";
    if (!title || !summary || !sourceUrl) continue;
    let host = "";
    try {
      const u = new URL(sourceUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      host = u.hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    // Provenance check: the claimed source must have actually appeared in the
    // live search results. (If no result hosts were captured at all, nothing
    // passes — better empty than unverifiable.)
    if (!seenHosts.has(host)) continue;
    out.push({ title, summary, sourceUrl, sourceTitle: sourceTitle || host });
    if (out.length >= 6) break;
  }
  return out;
}
