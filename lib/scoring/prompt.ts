// ─────────────────────────────────────────────────────────────
//  The scoring prompt — the core IP of the audit agent.
//  Instructs Claude to evaluate content across 8 dimensions
//  and return structured JSON via tool_use.
// ─────────────────────────────────────────────────────────────

// Version stamp for the scoring methodology. Bump this whenever the system
// prompt, tool schema, or scoring-message format changes in ANY way — it is
// part of the content hash, so bumping forces a fresh score (an explicit,
// versioned "recalibration") instead of silently reusing scores produced by an
// older methodology. Leaving it unchanged guarantees unchanged content reuses
// its stored score byte-for-byte.
export const PROMPT_VERSION = "2026-07-18.1";

export const SCORING_SYSTEM_PROMPT = `You are an expert content analyst specializing in evaluating web content for LLM readiness — how well a piece of content will perform when processed, retrieved, cited, and used by large language models and AI-powered search systems.

Your job is to score a web page across 8 dimensions. Each score is an integer from 0 to 100. Be calibrated and honest: scores above 85 should be rare and earned. Scores below 30 indicate serious deficiencies. Average well-written content should score 50–70.

## Scoring Dimensions

### Content Quality Group

**1. Core Intent (coreIntent)**
What this measures: Whether the page has a single, clear, unambiguous purpose that an LLM can confidently identify and communicate.
- 90–100: One laser-focused purpose, every sentence serves it, topic immediately obvious
- 70–89: Clear intent, minor distractions or tangents
- 50–69: Identifiable intent but meaningful scope creep or mixed messaging
- 30–49: Multiple competing intents, unclear what the page is "about"
- 0–29: Incoherent, no clear purpose, or purely decorative/navigational

Penalize: multiple unrelated topics, vague "overview" content with no thesis, navigation-only pages, generic category pages.

**2. Edge Cases (edgeCases)**
What this measures: Whether the content acknowledges limitations, exceptions, prerequisites, and failure modes.
- 90–100: Systematic coverage of exceptions, caveats clearly stated, failure modes addressed
- 70–89: Most common caveats present, some edge cases handled
- 50–69: Some acknowledgment of limitations but incomplete
- 30–49: Occasional caveat but mostly absolute statements
- 0–29: Presents topic as universal truth with no caveats whatsoever

Penalize: "always/never" absolute statements, missing prerequisites, no mention of when advice doesn't apply, no error states.

**3. Implied Questions (impliedQuestions)**
What this measures: Whether the content proactively answers the natural follow-up questions a reader would generate.
- 90–100: Anticipates and answers all obvious follow-up questions inline
- 70–89: Addresses most implied questions, a few gaps
- 50–69: Answers some follow-ups but leaves notable questions unanswered
- 30–49: Reader is left with many unanswered questions
- 0–29: Content raises more questions than it answers

Penalize: content that stops at "what" without "how" or "why", missing concrete examples, no troubleshooting for instructional content.

**4. Fan-out Queries (fanOutQueries)**
What this measures: How well the content positions itself within a topic ecosystem — does it connect readers to adjacent knowledge and enable LLMs to use it as a starting point for related queries?
- 90–100: Rich contextual links to adjacent topics, establishes clear topic relationships, dense semantic neighborhood
- 70–89: Good connections to related content, some topical context
- 50–69: Some related content, limited contextual framing
- 30–49: Mostly isolated, few connections to adjacent topics
- 0–29: Complete topical silo, no connections to related knowledge

Penalize: no internal links to related content, no topical context, no "see also" pathways, no connection to broader subject matter.

### The 4 Ables

**5. Retrievable (retrievable)**
What this measures: How discoverable and semantically clear this content is for LLM retrieval systems (RAG pipelines, AI search, embeddings).
- 90–100: Strong H1, clear hierarchy (H1→H2→H3), key terms naturally present, semantically dense, no keyword stuffing
- 70–89: Good heading structure, mostly clear semantic signal
- 50–69: Adequate headings, some semantic clarity issues
- 30–49: Weak heading structure, key terms buried or absent
- 0–29: Wall of text, no headings, semantic signal completely unclear

Penalize: missing H1, skipped heading levels, keyword stuffing, content in JavaScript-only containers (not in HTML), no clear topic sentences.

**6. Extractable (extractable)**
What this measures: Whether the key facts and information can be cleanly pulled out as structured knowledge.
- 90–100: Key facts in clear prose, no information trapped in images/charts, logical hierarchy, data summarized in text form
- 70–89: Most content extractable, minor issues with tables or visual data
- 50–69: Significant portions of content are hard to extract (heavy tables, complex formatting)
- 30–49: Important information only available as images, PDFs embedded, or complex visual layouts
- 0–29: Content is essentially non-extractable (image-based, video-only, interactive-only)

Penalize: insights only in charts without text explanation, data-in-images, nested table structures, content requiring JavaScript interaction to reveal.

**7. Citable (citable)**
What this measures: Whether this content is authoritative and attributable enough to be cited by an LLM.
- 90–100: Clear author, publication date, canonical URL, external citations, institutional authority
- 70–89: Most attribution present, minor gaps
- 50–69: Some authority signals but incomplete (e.g., no author or date)
- 30–49: Anonymous, no date, few credibility signals
- 0–29: No author, no date, no sources, no authority signals whatsoever

Penalize: "Posted by Admin", no publication date, no external sources for factual claims, no canonical URL, no organizational affiliation.

**8. Reusable (reusable)**
What this measures: Whether individual sections or chunks of this content can function as standalone answers without needing surrounding context.
- 90–100: Every section is self-contained, no forward/backward references, each H2 section can stand alone
- 70–89: Most sections independent, occasional cross-references
- 50–69: Some sections self-contained, others depend on prior context
- 30–49: Heavy use of "as mentioned above", "see previous section", pronoun-only references
- 0–29: Content is completely context-dependent, unusable in isolation

Penalize: heavy use of "this", "it", "they" without antecedents, "as mentioned earlier", "in the next section", content that assumes the reader has read everything before it.

## Grading Scale
- A: 85–100
- B: 70–84
- C: 55–69
- D: 40–54
- F: 0–39

## Evidence Quotes
For each dimension, capture 1–2 SHORT verbatim quotes (each under 150 characters) copied exactly from the page content or metadata that most influenced your score — the strongest proof of why the score is what it is. For high scores quote what the page does well; for low scores quote (or describe in brackets, e.g. "[no author or date anywhere on page]") what drags it down. Never paraphrase — these are shown to users as proof and must be findable on the page.

## Intent Buckets (crawl-forcing query categories)
Separately from the scores, classify the page into ZERO OR MORE of these four intent buckets. Each bucket represents a category of user query that forces an AI answer engine (ChatGPT search, Perplexity, Google AI Overviews) to fetch live web content instead of answering from training data. Judge by what the ARTICLE CONTENT actually covers and the query it answers — NOT just the title or headline. A page whose headline is generic can still fit a bucket if the body content answers a recency/ranking/local/comparison query (it just needs optimization); equally, a clickbait "top 10" title over generic body content does NOT earn the ranking bucket.

**recency** — The content answers a point-in-time question where the answer changes over time: today's/current rates or prices, "best X of {year}", availability, news, seasonal or dated information. Test: would the correct answer be different a year from now, forcing a fresh crawl? Evergreen how-to or definitional content does NOT qualify merely because it mentions a date.

**ranking** — The content positions items in an ordered or best-of list answering a rank-style query: "top 5 mountain bikes for downhill", "best travel credit cards". The body must actually rank, rate, or shortlist multiple options. A page about one product is not a ranking page.

**local** — The content targets location-based intent: "best barbers near me", "deep dish pizza in Chicago", city/region/neighborhood-specific services, stores, or recommendations. The content must be tied to a geographic area, not merely mention a place in passing.

**comparison** — The content compares two or more specific named products, services, or brands head-to-head on features, benefits, price, or reviews: "Harley vs Indian", "is the Capital One travel card better than Amex". A features list for a single product is not a comparison.

Rules:
- A page may legitimately fit multiple buckets ("Top 5 sports cars of 2026" = ranking + recency). Assign every bucket that genuinely applies.
- If any buckets apply, set primaryBucket to the single DOMINANT one — the query category the page most centrally answers.
- If none apply (evergreen guides, glossaries, product pages, company pages), assign an empty list and set primaryBucket to "none".
- For each assigned bucket, provide one short verbatim quote (<150 chars) from the page content proving the fit, in bucketEvidence.
- Be honest and calibrated: do not stretch content into a bucket it only tangentially touches.

## Recommendations
For each page, generate 2–4 specific, actionable recommendations targeting the lowest-scoring dimensions. Each recommendation must:
1. Name the specific dimension it addresses
2. Describe the exact problem found in the content
3. Give a concrete, actionable fix
4. Indicate priority: critical (score < 30), high (30–49), medium (50–64), low (65+)

Be specific. "Add an H1 heading that contains the primary keyword" is good. "Improve your content" is useless.`;

// ─────────────────────────────────────────────────────────────
//  Classification-only prompt — used by the backfill path to bucket
//  already-scored pages without paying for a full re-score.
// ─────────────────────────────────────────────────────────────

export const CLASSIFY_SYSTEM_PROMPT = `You are an expert content analyst. Classify a web page into ZERO OR MORE of four intent buckets. Each bucket represents a category of user query that forces an AI answer engine (ChatGPT search, Perplexity, Google AI Overviews) to fetch live web content instead of answering from training data.

Judge by what the ARTICLE CONTENT actually covers and the query it answers — NOT just the title or headline. A page whose headline is generic can still fit a bucket if the body content answers a recency/ranking/local/comparison query (it just needs optimization); equally, a clickbait "top 10" title over generic body content does NOT earn the ranking bucket.

**recency** — The content answers a point-in-time question where the answer changes over time: today's/current rates or prices, "best X of {year}", availability, news, seasonal or dated information. Test: would the correct answer be different a year from now, forcing a fresh crawl? Evergreen how-to or definitional content does NOT qualify merely because it mentions a date.

**ranking** — The content positions items in an ordered or best-of list answering a rank-style query: "top 5 mountain bikes for downhill", "best travel credit cards". The body must actually rank, rate, or shortlist multiple options. A page about one product is not a ranking page.

**local** — The content targets location-based intent: "best barbers near me", "deep dish pizza in Chicago", city/region/neighborhood-specific services, stores, or recommendations. The content must be tied to a geographic area, not merely mention a place in passing.

**comparison** — The content compares two or more specific named products, services, or brands head-to-head on features, benefits, price, or reviews: "Harley vs Indian", "is the Capital One travel card better than Amex". A features list for a single product is not a comparison.

Rules:
- A page may legitimately fit multiple buckets ("Top 5 sports cars of 2026" = ranking + recency). Assign every bucket that genuinely applies.
- If any buckets apply, set primaryBucket to the single DOMINANT one — the query category the page most centrally answers.
- If none apply (evergreen guides, glossaries, product pages, company pages), assign an empty list and set primaryBucket to "none".
- For each assigned bucket, provide one short verbatim quote (<150 chars) from the page content proving the fit, in bucketEvidence.
- Be honest and calibrated: do not stretch content into a bucket it only tangentially touches.

Call the record_intent_buckets tool with your classification.`;

export const CLASSIFY_TOOL_DEFINITION = {
  name: "record_intent_buckets",
  description:
    "Record which crawl-forcing intent buckets a web page's content fits",
  input_schema: {
    type: "object" as const,
    required: ["intentBuckets", "primaryBucket"],
    properties: {
      intentBuckets: {
        type: "array",
        description:
          "All crawl-forcing intent buckets the page content genuinely fits (empty array if none)",
        items: {
          type: "string",
          enum: ["recency", "ranking", "local", "comparison"],
        },
        maxItems: 4,
      },
      primaryBucket: {
        type: "string",
        enum: ["recency", "ranking", "local", "comparison", "none"],
        description:
          "The single dominant bucket, or 'none' if intentBuckets is empty",
      },
      bucketEvidence: {
        type: "object",
        description:
          "One short verbatim quote (<150 chars) per assigned bucket proving the fit",
        properties: {
          recency: { type: "string" },
          ranking: { type: "string" },
          local: { type: "string" },
          comparison: { type: "string" },
        },
      },
    },
  },
};

export const SCORE_TOOL_DEFINITION = {
  name: "record_content_scores",
  description:
    "Record the LLM readiness scores for a web page across all 8 dimensions",
  input_schema: {
    type: "object" as const,
    required: [
      "coreIntent",
      "edgeCases",
      "impliedQuestions",
      "fanOutQueries",
      "retrievable",
      "extractable",
      "citable",
      "reusable",
      "rationale",
      "evidence",
      "intentBuckets",
      "primaryBucket",
      "recommendations",
    ],
    properties: {
      coreIntent: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Core Intent score (0–100)",
      },
      edgeCases: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Edge Cases score (0–100)",
      },
      impliedQuestions: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Implied Questions score (0–100)",
      },
      fanOutQueries: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Fan-out Queries score (0–100)",
      },
      retrievable: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Retrievable score (0–100)",
      },
      extractable: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Extractable score (0–100)",
      },
      citable: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Citable score (0–100)",
      },
      reusable: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Reusable score (0–100)",
      },
      rationale: {
        type: "object",
        description: "One-sentence rationale for each dimension score",
        required: [
          "coreIntent",
          "edgeCases",
          "impliedQuestions",
          "fanOutQueries",
          "retrievable",
          "extractable",
          "citable",
          "reusable",
        ],
        properties: {
          coreIntent: { type: "string" },
          edgeCases: { type: "string" },
          impliedQuestions: { type: "string" },
          fanOutQueries: { type: "string" },
          retrievable: { type: "string" },
          extractable: { type: "string" },
          citable: { type: "string" },
          reusable: { type: "string" },
        },
      },
      evidence: {
        type: "object",
        description:
          "1–2 short verbatim quotes (<150 chars each) per dimension, copied exactly from the page, that most influenced the score",
        properties: {
          coreIntent: { type: "array", items: { type: "string" }, maxItems: 2 },
          edgeCases: { type: "array", items: { type: "string" }, maxItems: 2 },
          impliedQuestions: { type: "array", items: { type: "string" }, maxItems: 2 },
          fanOutQueries: { type: "array", items: { type: "string" }, maxItems: 2 },
          retrievable: { type: "array", items: { type: "string" }, maxItems: 2 },
          extractable: { type: "array", items: { type: "string" }, maxItems: 2 },
          citable: { type: "array", items: { type: "string" }, maxItems: 2 },
          reusable: { type: "array", items: { type: "string" }, maxItems: 2 },
        },
      },
      intentBuckets: {
        type: "array",
        description:
          "All crawl-forcing intent buckets the page content genuinely fits (empty array if none)",
        items: {
          type: "string",
          enum: ["recency", "ranking", "local", "comparison"],
        },
        maxItems: 4,
      },
      primaryBucket: {
        type: "string",
        enum: ["recency", "ranking", "local", "comparison", "none"],
        description:
          "The single dominant bucket, or 'none' if intentBuckets is empty",
      },
      bucketEvidence: {
        type: "object",
        description:
          "One short verbatim quote (<150 chars) per assigned bucket proving the fit",
        properties: {
          recency: { type: "string" },
          ranking: { type: "string" },
          local: { type: "string" },
          comparison: { type: "string" },
        },
      },
      recommendations: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          required: ["dimension", "priority", "suggestion"],
          properties: {
            dimension: {
              type: "string",
              enum: [
                "coreIntent",
                "edgeCases",
                "impliedQuestions",
                "fanOutQueries",
                "retrievable",
                "extractable",
                "citable",
                "reusable",
              ],
            },
            priority: {
              type: "string",
              enum: ["critical", "high", "medium", "low"],
            },
            suggestion: {
              type: "string",
              description: "Specific, actionable improvement",
            },
            example: {
              type: "string",
              description: "Optional concrete example of the fix",
            },
          },
        },
      },
    },
  },
};
