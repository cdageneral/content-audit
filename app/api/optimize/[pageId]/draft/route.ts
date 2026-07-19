// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/draft
//  Save a new draft version for a page. Every save is an immutable
//  new version (the workbench's version dropdown), never an update
//  in place — a client can always get back to what they simulated.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createDraft, getPageForOptimize } from "@/lib/db/drafts";
import type { PageMetadata } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Params = { params: { pageId: string } };

const MAX_BODY_CHARS = 120_000; // crawler caps bodyText at 100k; leave headroom for markup

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const projectId = str(body.projectId);
    const title = str(body.title) ?? "";
    const metaDescription = str(body.metaDescription) ?? "";
    const bodyMd = str(body.bodyMd) ?? "";

    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    if (bodyMd.length > MAX_BODY_CHARS) {
      return NextResponse.json(
        { error: `Content is too long (max ${MAX_BODY_CHARS.toLocaleString()} characters)` },
        { status: 413 }
      );
    }

    const bundle = await getPageForOptimize(params.pageId);
    if (!bundle) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }
    if (bundle.projectId && bundle.projectId !== projectId) {
      return NextResponse.json({ error: "Page does not belong to this project" }, { status: 403 });
    }

    const metadata = sanitizeMetadata(body.metadata);
    const internalLinks = strArray(body.internalLinks, 100);
    const externalLinks = strArray(body.externalLinks, 50);

    const draft = await createDraft({
      projectId,
      pageId: params.pageId,
      jobId: bundle.jobId,
      url: bundle.page.url,
      title: title.slice(0, 500),
      metaDescription: metaDescription.slice(0, 1000),
      bodyMd,
      metadata,
      internalLinks,
      externalLinks,
    });

    return NextResponse.json({ draft });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/draft POST]`, err);
    return NextResponse.json({ error: "Failed to save draft" }, { status: 500 });
  }
}

// ── Input sanitizers ──────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 2000))
    .slice(0, cap);
}

function sanitizeMetadata(v: unknown): PageMetadata {
  const raw = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s = (x: unknown): string | undefined =>
    typeof x === "string" && x.trim() ? x.trim().slice(0, 1000) : undefined;
  return {
    author: s(raw.author),
    publishedDate: s(raw.publishedDate),
    modifiedDate: s(raw.modifiedDate),
    canonicalUrl: s(raw.canonicalUrl),
    ogTitle: s(raw.ogTitle),
    ogDescription: s(raw.ogDescription),
    ogImage: s(raw.ogImage),
    schemaOrgType: s(raw.schemaOrgType),
    hasStructuredData: raw.hasStructuredData === true,
    language: s(raw.language),
  };
}
