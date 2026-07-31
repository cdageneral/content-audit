// ─────────────────────────────────────────────────────────────
//  AI-crawler access check
//
//  Fetches a site's robots.txt and evaluates whether the major AI
//  answer-engine crawlers are allowed to fetch its pages, plus
//  whether an llms.txt exists. Run once per site at audit start —
//  two small HTTP GETs; results are stored on the audit job so the
//  hub and the assessment report can surface "your site literally
//  blocks the AI crawlers" as a verifiable finding.
// ─────────────────────────────────────────────────────────────

// "unknown" = we could not READ robots.txt (403/401/429/5xx/network), so
// access is UNVERIFIED. That is deliberately NOT the same as "allowed" —
// conflating the two printed a false all-clear into client reports.
export type AiBotStatus = "allowed" | "blocked" | "partial" | "unknown";

export interface AiBotAccess {
  name: string;
  status: AiBotStatus;
  /** The user-agent group that decided the status ("*" = default group, null = no rules at all) */
  matchedGroup: string | null;
  /** A representative rule for display, e.g. "Disallow: /" */
  sampleRule: string | null;
}

export interface AiCrawlerAccess {
  checkedAt: string;
  origin: string;
  robotsFound: boolean;
  /** false = the request for robots.txt was REFUSED (403/401/429/5xx/network),
   *  so nothing about crawler access is known. Optional for back-compat with
   *  ai_access rows written before 2026-07-31 (undefined ⇒ treat as reachable). */
  robotsReachable?: boolean;
  /** HTTP status the robots.txt request returned, null if it never connected. */
  robotsStatus?: number | null;
  llmsTxtFound: boolean;
  bots: AiBotAccess[];
}

/** The AI crawlers we check, in display order. */
export const AI_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const;

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsGroup {
  agents: string[]; // lowercased user-agent tokens
  rules: RobotsRule[];
}

/** Minimal robots.txt parser: groups of user-agent lines + their allow/disallow rules. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!collectingAgents || current == null) {
        current = { agents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (current == null) continue; // rules before any user-agent line — ignore
      collectingAgents = false;
      current.rules.push({ allow: field === "allow", path: value });
    } else {
      // sitemap, crawl-delay, etc. end the agent-collecting phase
      collectingAgents = false;
    }
  }
  return groups;
}

/**
 * Evaluate one bot against parsed robots groups.
 * Per the robots spec, a crawler obeys the most specific matching
 * user-agent group; the "*" group only applies when no named group
 * matches. Root access decides blocked vs allowed; other disallows
 * mean "partial".
 */
export function evaluateBot(groups: RobotsGroup[], bot: string): AiBotAccess {
  const botLc = bot.toLowerCase();
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && (a === botLc || botLc.startsWith(a) || a.startsWith(botLc)))
  );
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const matchedGroup = specific.length ? bot : applicable.length ? "*" : null;

  if (!applicable.length) {
    return { name: bot, status: "allowed", matchedGroup, sampleRule: null };
  }

  const rules = applicable.flatMap((g) => g.rules);
  // Empty Disallow ("Disallow:") means allow-everything — ignore it.
  const disallows = rules.filter((r) => !r.allow && r.path.length > 0);
  const rootDisallowed = disallows.some((r) => r.path === "/");
  const rootAllowed = rules.some((r) => r.allow && r.path === "/");

  if (rootDisallowed && !rootAllowed) {
    return { name: bot, status: "blocked", matchedGroup, sampleRule: "Disallow: /" };
  }
  if (disallows.length > 0) {
    return {
      name: bot,
      status: "partial",
      matchedGroup,
      sampleRule: `Disallow: ${disallows[0].path}`,
    };
  }
  return { name: bot, status: "allowed", matchedGroup, sampleRule: null };
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number
): Promise<{ status: number; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "ContentAuditBot/1.0 (+ai-readiness-check)" },
      cache: "no-store",
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const looksLikeHtml = (text: string): boolean =>
  /^\s*(<!doctype|<html|<head|<body)/i.test(text.slice(0, 300));

/** Statuses that mean "the server refused us", not "the file isn't there". */
const REFUSAL_STATUSES = new Set([401, 403, 407, 429, 451]);

/**
 * Check a site's AI-crawler access. Never throws — returns null only if
 * the input URL itself is unparsable.
 *
 * Three outcomes, deliberately distinct:
 *   • robots.txt read      → evaluate each bot against its rules
 *   • robots.txt ABSENT    → crawlers allowed by default (that IS the finding)
 *   • robots.txt REFUSED   → "unknown"; we know nothing and must not imply we do
 */
export async function checkAiCrawlerAccess(siteUrl: string): Promise<AiCrawlerAccess | null> {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return null;
  }

  const [robotsRes, llmsRes] = await Promise.all([
    fetchTextWithTimeout(`${origin}/robots.txt`, 6000),
    fetchTextWithTimeout(`${origin}/llms.txt`, 6000),
  ]);

  const robotsFound =
    robotsRes != null && robotsRes.status === 200 && !looksLikeHtml(robotsRes.text);
  const groups = robotsFound ? parseRobots(robotsRes.text) : [];

  // A 404 is a real answer ("no robots.txt") — a 403 or a dead connection is not.
  const robotsReachable =
    robotsRes != null &&
    !REFUSAL_STATUSES.has(robotsRes.status) &&
    robotsRes.status < 500;

  const llmsTxtFound =
    llmsRes != null && llmsRes.status === 200 && llmsRes.text.trim().length > 0 && !looksLikeHtml(llmsRes.text);

  return {
    checkedAt: new Date().toISOString(),
    origin,
    robotsFound,
    robotsReachable,
    robotsStatus: robotsRes?.status ?? null,
    llmsTxtFound,
    bots: AI_BOTS.map((b) =>
      robotsFound
        ? evaluateBot(groups, b)
        : {
            name: b,
            status: (robotsReachable ? "allowed" : "unknown") as AiBotStatus,
            matchedGroup: null,
            sampleRule: null,
          }
    ),
  };
}
