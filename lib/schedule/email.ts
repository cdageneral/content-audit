// ─────────────────────────────────────────────────────────────
//  lib/schedule/email.ts — the "what moved" scan email (server-only).
//
//  Sends via the Resend HTTP API with plain fetch — no SDK dep.
//  Fully env-gated: without RESEND_API_KEY nothing is sent and the
//  scan pipeline is byte-for-byte unaffected (the run row records
//  email_status = 'skipped_no_key' so the UI can say so honestly).
//
//  Data honesty: every figure in the email is read from stored
//  score rows (this run vs the previous completed run). No modeled
//  or projected numbers, ever. When nothing moved, the email says
//  exactly that in one line.
//
//  Env:
//   RESEND_API_KEY — enables sending.
//   SCAN_EMAIL_FROM — optional From override; defaults to Resend's
//     shared onboarding sender, which works before a domain is
//     verified (swap once a real domain exists).
// ─────────────────────────────────────────────────────────────

import { recordApiCall } from "@/lib/usage/record";
import type { ScanRunSummary } from "./types";

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function fromAddress(): string {
  return process.env.SCAN_EMAIL_FROM ?? "Prism Optimizer <onboarding@resend.dev>";
}

export interface PageDelta {
  url: string;
  before: number | null; // overall score in the previous run, null = new page
  after: number | null;  // overall score in this run, null = page gone
  gradeBefore: string | null;
  gradeAfter: string | null;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NAVY = "#0b0b24";
const VIOLET = "#6f1cfe";
const VIOLET_SOFT = "#a56bfb";
const GREEN = "#059669";
const RED = "#dc2626";
const GRAY = "#6b7280";

function deltaLine(d: PageDelta): string {
  const path = (() => {
    try {
      return new URL(d.url).pathname || d.url;
    } catch {
      return d.url;
    }
  })();
  let right: string;
  if (d.before === null && d.after !== null) {
    right = `<span style="color:${GRAY}">new</span> · ${d.after} (${esc(d.gradeAfter ?? "")})`;
  } else if (d.after === null) {
    right = `<span style="color:${GRAY}">no longer scored</span>`;
  } else {
    const up = (d.after ?? 0) > (d.before ?? 0);
    const col = up ? GREEN : RED;
    const arrow = up ? "▲" : "▼";
    right = `${d.before} → ${d.after} <span style="color:${col};font-weight:700">${arrow}</span>`;
  }
  return `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#111827;font-weight:600;word-break:break-all">${esc(path)}</td>
      <td style="padding:6px 0 6px 12px;font-size:13px;text-align:right;white-space:nowrap;color:#374151">${right}</td>
    </tr>`;
}

export function buildScanEmailHtml(input: {
  projectName: string;
  projectUrl: string; // absolute link into the app
  runDate: Date;
  summary: ScanRunSummary;
  movers: PageDelta[];
}): { subject: string; html: string } {
  const { projectName, projectUrl, summary, movers } = input;
  const moved = summary.improved + summary.declined > 0 || summary.changed > 0;

  const scoreLine =
    summary.avgBefore !== null && summary.avgAfter !== null
      ? `${summary.avgBefore} → ${summary.avgAfter}`
      : summary.avgAfter !== null
        ? `${summary.avgAfter}`
        : "—";
  const gradeLine = summary.gradeAfter
    ? summary.gradeBefore && summary.gradeBefore !== summary.gradeAfter
      ? ` (${summary.gradeBefore} → ${summary.gradeAfter})`
      : ` (${summary.gradeAfter})`
    : "";

  const subject = moved
    ? `${projectName} scan complete — overall ${scoreLine}${gradeLine}`
    : `${projectName} scan complete — no score changes`;

  const moversHtml =
    movers.length > 0
      ? `
    <div style="padding:16px 26px;border-bottom:1px solid #f3f4f6">
      <p style="margin:0 0 9px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af;font-weight:700">Biggest movers</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${movers.map(deltaLine).join("")}</table>
    </div>`
      : "";

  const summaryBlock = moved
    ? `
    <div style="padding:20px 26px;border-bottom:1px solid #f3f4f6">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td>
          <div style="font-size:30px;font-weight:800;color:#111827">${scoreLine}${esc(gradeLine)}</div>
          <div style="font-size:12.5px;color:#6b7280">Overall readiness score (average of ${summary.pages} scored page${summary.pages === 1 ? "" : "s"})</div>
        </td>
        <td style="text-align:right;font-size:13px;color:#374151;white-space:nowrap">
          <div><b style="color:${GREEN}">${summary.improved} improved</b></div>
          <div><b style="color:${summary.declined > 0 ? RED : GRAY}">${summary.declined} declined</b></div>
          <div style="color:#6b7280">${Math.max(0, summary.pages - summary.improved - summary.declined)} unchanged</div>
        </td>
      </tr></table>
    </div>`
    : `
    <div style="padding:20px 26px;border-bottom:1px solid #f3f4f6">
      <p style="margin:0;font-size:14px;color:#374151">Scan complete — <b>no score changes</b> across ${summary.pages} page${summary.pages === 1 ? "" : "s"}. Your content and scores are exactly where they were.</p>
    </div>`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
      <tr><td style="background:${NAVY};padding:22px 26px">
        <div style="font-weight:700;font-size:14px;color:#ffffff;margin-bottom:12px">Prism <span style="color:${VIOLET_SOFT}">Optimizer</span></div>
        <div style="font-size:18px;font-weight:700;color:#ffffff">Scheduled scan complete — ${esc(projectName)}</div>
        <div style="font-size:13px;color:#c7c9dd;margin-top:4px">${summary.pages} page${summary.pages === 1 ? "" : "s"} scored · ${summary.changed} changed since the last scan</div>
      </td></tr>
      <tr><td>${summaryBlock}${moversHtml}
        <div style="padding:20px 26px;text-align:center">
          <a href="${esc(projectUrl)}" style="display:inline-block;background:#4f46e5;color:#ffffff;font-weight:700;font-size:13.5px;border-radius:9px;padding:10px 22px;text-decoration:none">Open the full results →</a>
        </div>
        <div style="padding:14px 26px;background:#f9fafb;font-size:11.5px;color:#9ca3af;text-align:center">
          Prism Optimizer, Powered by C3 Technology · You're receiving this because scheduled scans are on for ${esc(projectName)}.
        </div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { subject, html };
}

export function buildPauseEmailHtml(input: {
  projectName: string;
  projectUrl: string;
  reason: string;
}): { subject: string; html: string } {
  const subject = `Scheduled scans paused for ${input.projectName}`;
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
      <tr><td style="background:${NAVY};padding:22px 26px">
        <div style="font-weight:700;font-size:14px;color:#ffffff;margin-bottom:12px">Prism <span style="color:${VIOLET_SOFT}">Optimizer</span></div>
        <div style="font-size:18px;font-weight:700;color:#ffffff">Scheduled scans paused — ${esc(input.projectName)}</div>
      </td></tr>
      <tr><td>
        <div style="padding:20px 26px;border-bottom:1px solid #f3f4f6">
          <p style="margin:0 0 10px;font-size:14px;color:#374151">Two scheduled scans in a row couldn't complete, so the schedule paused itself rather than keep retrying.</p>
          <p style="margin:0 0 10px;font-size:13px;color:#6b7280"><b>Last error:</b> ${esc(input.reason)}</p>
          <p style="margin:0;font-size:13px;color:#6b7280">Nothing was lost — your existing scores are untouched. Resume anytime from the project's Scan Schedule page.</p>
        </div>
        <div style="padding:20px 26px;text-align:center">
          <a href="${esc(input.projectUrl)}" style="display:inline-block;background:#4f46e5;color:#ffffff;font-weight:700;font-size:13.5px;border-radius:9px;padding:10px 22px;text-decoration:none">Open Scan Schedule →</a>
        </div>
        <div style="padding:14px 26px;background:#f9fafb;font-size:11.5px;color:#9ca3af;text-align:center">
          Prism Optimizer, Powered by C3 Technology
        </div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html };
}

/**
 * Send via Resend. Returns a short status string for the run row:
 * 'sent', 'skipped_no_key', or 'error: …'. Never throws.
 */
export async function sendScanEmail(input: {
  to: string[];
  subject: string;
  html: string;
  projectId: string | null;
  purpose: string;
}): Promise<string> {
  if (!emailConfigured()) return "skipped_no_key";
  if (input.to.length === 0) return "skipped_no_recipients";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: input.to,
        subject: input.subject,
        html: input.html,
      }),
    });
    const okText = res.ok ? "sent" : `error: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
    await recordApiCall({
      provider: "resend",
      purpose: input.purpose,
      costUsd: null,
      jobId: null,
      meta: { recipients: input.to.length, ok: res.ok, projectId: input.projectId },
    });
    return okText;
  } catch (err) {
    return `error: ${String(err)}`.slice(0, 300);
  }
}
