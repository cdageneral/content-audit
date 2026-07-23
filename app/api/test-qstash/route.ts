// GET /api/test-qstash — Diagnose env vars + connectivity
// DELETE THIS FILE after debugging is complete

import { NextResponse } from "next/server";
import { Client } from "@upstash/qstash";
import Anthropic from "@anthropic-ai/sdk";
import { recordAnthropicCall } from "@/lib/usage/record";

export async function GET() {
  const results: Record<string, string> = {};

  // ── 1. Env var presence ──────────────────────────────────────
  results.ANTHROPIC_API_KEY      = process.env.ANTHROPIC_API_KEY      ? "✓ set" : "✗ MISSING";
  results.QSTASH_TOKEN           = process.env.QSTASH_TOKEN           ? "✓ set" : "✗ MISSING";
  results.QSTASH_URL             = process.env.QSTASH_URL             ?? "✗ MISSING";
  results.NEXT_PUBLIC_APP_URL    = process.env.NEXT_PUBLIC_APP_URL    ?? "✗ MISSING";
  results.QSTASH_CURRENT_SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY ? "✓ set" : "✗ MISSING";
  results.QSTASH_NEXT_SIGNING_KEY    = process.env.QSTASH_NEXT_SIGNING_KEY    ? "✓ set" : "✗ MISSING";
  results.DATABASE_URL           = process.env.DATABASE_URL           ? "✓ set" : "✗ MISSING";

  // ── 2. Test Anthropic API key ────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Reply with OK" }],
      });
      await recordAnthropicCall({
        purpose: "test",
        model: "claude-haiku-4-5-20251001",
        usage: msg.usage,
      });
      results.anthropic_test = `✓ Success — model responded: "${(msg.content[0] as any).text}"`;
    } catch (err: any) {
      results.anthropic_test = `✗ FAILED — ${err?.message ?? String(err)}`;
    }
  } else {
    results.anthropic_test = "✗ Skipped — ANTHROPIC_API_KEY missing";
  }

  // ── 3. Test QStash publish ───────────────────────────────────
  if (process.env.QSTASH_TOKEN && process.env.NEXT_PUBLIC_APP_URL) {
    try {
      const client = new Client({ token: process.env.QSTASH_TOKEN });
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
      results.qstash_target = `${baseUrl}/api/webhook/qstash`;
      const response = await client.publishJSON({
        url: results.qstash_target,
        body: { type: "test" },
        retries: 0,
      });
      results.qstash_test = `✓ Success — messageId: ${JSON.stringify(response)}`;
    } catch (err: any) {
      results.qstash_test = `✗ FAILED — ${err?.message ?? String(err)}`;
    }
  } else {
    results.qstash_test = "✗ Skipped — missing QSTASH_TOKEN or NEXT_PUBLIC_APP_URL";
  }

  return NextResponse.json(results, { status: 200 });
}
