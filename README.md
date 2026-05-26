# AI Content Audit Agent

Score every page on your website for **LLM readiness** across 8 dimensions — deployed on Vercel, powered by Claude.

## Scoring Dimensions

### Content Quality
| Dimension | What it measures |
|---|---|
| **Core Intent** | Single, clear purpose an LLM can identify |
| **Edge Cases** | Caveats, exceptions, limitations, failure modes |
| **Implied Questions** | Natural follow-ups answered inline |
| **Fan-out Queries** | Connections to adjacent topics/knowledge |

### The 4 Ables
| Dimension | What it measures |
|---|---|
| **Retrievable** | Semantic clarity, heading hierarchy, topic signal |
| **Extractable** | Facts in text (not trapped in images/tables) |
| **Citable** | Author, date, canonical URL, authority signals |
| **Reusable** | Self-contained chunks, no cross-reference dependencies |

---

## Architecture

```
Next.js App Router (Vercel)
  └── API Routes
        ├── POST /api/audit         → creates job, discovers URLs
        ├── GET  /api/audit/[id]    → job status + results
        ├── GET  /api/audit/[id]/progress → SSE live progress
        └── POST /api/webhook/qstash → async crawl + score batches

Services
  ├── Upstash QStash    → async job queue (bypasses 300s Vercel limit)
  ├── Neon Postgres     → jobs, pages, scores
  ├── Vercel KV         → job state cache
  └── Anthropic Claude  → scoring (Sonnet) + recommendations (Haiku)
```

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/YOUR_ORG/ai-content-audit-agent
cd ai-content-audit-agent
npm install
```

### 2. Copy env vars

```bash
cp .env.example .env.local
```

Fill in each value (see section below).

### 3. Set up Neon Postgres

1. Create a free project at [neon.tech](https://neon.tech)
2. Copy the connection string to `DATABASE_URL`
3. Run the schema:

```bash
psql $DATABASE_URL -f lib/db/schema.sql
```

### 4. Set up Upstash QStash

1. Go to [console.upstash.com](https://console.upstash.com) → QStash
2. Copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`

### 5. Set up Vercel KV & Blob

```bash
npx vercel link
npx vercel env pull .env.local
```

Or add via the Vercel dashboard → Storage → KV and Blob.

### 6. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

> **Note:** QStash webhooks won't work locally without a tunnel.
> Use [ngrok](https://ngrok.com) or [localtunnel](https://theboroer.github.io/localtunnel-www/):
> ```bash
> ngrok http 3000
> # Then set NEXT_PUBLIC_APP_URL=https://your-ngrok-url.ngrok.io in .env.local
> ```

---

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com) |
| `DATABASE_URL` | Neon Postgres connection string |
| `KV_URL` / `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV (Redis) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage |
| `QSTASH_TOKEN` | Upstash QStash token |
| `QSTASH_CURRENT_SIGNING_KEY` | QStash webhook verification |
| `QSTASH_NEXT_SIGNING_KEY` | QStash webhook verification |
| `NEXT_PUBLIC_APP_URL` | Your Vercel deployment URL |
| `WEBHOOK_SECRET` | Random string for internal endpoint protection |
| `SCORING_MODEL` | Default: `claude-sonnet-4-5` |
| `RECS_MODEL` | Default: `claude-haiku-4-5-20251001` |
| `BATCH_SIZE` | Pages per crawl batch. Default: `15` |

---

## Deploy to Vercel

```bash
npx vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard for automatic deploys on push.

**Required Vercel settings:**
- Runtime: Node.js 20.x
- Build command: `npm run build`
- Vercel Pro: required for 300s function timeout (webhook handler)

---

## Vercel Pro Rate Limits

The agent is built to respect Vercel Pro limits:

- Crawl batches: 15 pages/invocation (configurable via `BATCH_SIZE`)
- Score batches: 10 pages/invocation
- QStash handles retries automatically (max 2 retries per batch)
- Claude API: 1.2s delay between scoring calls (~50 req/min)

For sites > 1,000 pages, increase `BATCH_SIZE` to 25 and monitor QStash throughput.

---

## How Scoring Works

Each page is sent to Claude Sonnet via a single `tool_use` API call with a strict JSON schema. Claude returns:

- **8 scores** (0–100 each)
- **Rationale** for each dimension (one sentence)
- **2–4 recommendations** with priority (`critical` / `high` / `medium` / `low`) and a concrete fix

The **Overall LLM Readiness Score** is a weighted average of the 8 dimensions (weights configurable per audit).

### Grading scale
| Grade | Score Range |
|---|---|
| A | 85–100 |
| B | 70–84 |
| C | 55–69 |
| D | 40–54 |
| F | 0–39 |
