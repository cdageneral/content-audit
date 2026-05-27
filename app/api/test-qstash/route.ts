// GET /api/test-qstash — Diagnose QStash connectivity
// DELETE THIS FILE after debugging is complete

import { NextResponse } from "next/server";
import { Client } from "@upstash/qstash";

export async function GET() {
  const results: Record<string, string> = {};

  // 1. Check env vars are present
  results.QSTASH_TOKEN = process.env.QSTASH_TOKEN ? "✓ set" : "✗ MISSING";
  results.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "✗ MISSING";
  results.QSTASH_CURRENT_SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY ? "✓ set" : "✗ MISSING";
  results.QSTASH_NEXT_SIGNING_KEY = process.env.QSTASH_NEXT_SIGNING_KEY ? "✓ set" : "✗ MISSING";

  // 2. Try publishing a test message to QStash
  if (process.env.QSTASH_TOKEN && process.env.NEXT_PUBLIC_APP_URL) {
    try {
      const client = new Client({ token: process.env.QSTASH_TOKEN });
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
      const endpoint = `${baseUrl}/api/webhook/qstash`;

      results.target_url = endpoint;

      const response = await client.publishJSON({
        url: endpoint,
        body: { type: "test", message: "QStash connectivity check" },
        retries: 0,
      });

      results.publish_result = `✓ Success — messageId: ${JSON.stringify(response)}`;
    } catch (err: any) {
      results.publish_result = `✗ FAILED — ${err?.message ?? String(err)}`;
      results.error_stack = err?.stack?.split("\n").slice(0, 3).join(" | ") ?? "";
    }
  } else {
    results.publish_result = "✗ Skipped — missing env vars";
  }

  return NextResponse.json(results, { status: 200 });
}
