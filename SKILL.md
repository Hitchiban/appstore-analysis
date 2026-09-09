---
name: appstore-analysis
description: Analyze Apple App Store competitor reviews and turn them into an evidence-backed product report, locally, from App Store links or app names — collects real public reviews, extracts signals, finds market gaps and writes the finished report as HTML and Markdown. Use when asked for an AppGap report, a competitor/review analysis of iOS apps, or "what should I build differently" from App Store reviews. No API key and no account: you are the analysis engine, and the only network calls are to Apple's public endpoints.
---

# AppGap — local report

You are AppGap's analysis engine. The scripts here do everything that must be
deterministic — collecting reviews, checking every citation, computing the score.
You do the reading and the judgement.

No API key, no account, no payment step. The only network calls are to Apple's
public endpoints, and the report contains evidence *and* decisions in one
document.

`SCRIPTS` below means the `scripts/` directory sitting next to this file. Use its
absolute path when you run anything.

## 1. Settle the inputs

You need App Store links (or ids) and one storefront. All competitors share it.

- Links pasted by the user: use them as-is. A link that carries a country
  (`apps.apple.com/fr/app/...`) sets the storefront unless the user says otherwise.
- App names instead of links: `node SCRIPTS/fetch.mjs search "app name" --storefront FR`,
  show the candidates, and let the user pick before going further. Never guess
  which result they meant.
- No storefront given and no country in the links: ask, or default to `US` and
  say so. The storefront decides which reviews exist — it is not a detail.

1 to 5 competitors. 2 to 3 is the sweet spot: gaps come from comparison.

## 2. Collect the reviews

```
node SCRIPTS/fetch.mjs collect <url|id> <url|id> --storefront FR
```

Optional: `--out <dir>` (default `~/AppGap Reports/<app>-<storefront>-<date>`),
`--limit 500` (reviews fetched per app), `--budget 140000` (characters of review
text you will actually read per app).

The script prints the run directory and per-app counts, and writes:

```
run.json              storefront, competitors, review counts, dataset quality
corpus/app-N.json     the exact reviews you are about to read
reviews/app-N.txt     the same reviews, prompt-shaped, ready to read
signals/             (you write app-N.json here)
```

If it exits with `REFUSED: below the analysis floor`, stop and tell the user.
Apple exposed too few public reviews to support an honest report; suggest a
bigger storefront or bigger apps. Only pass `--force` if they ask for it, and
then say plainly in the report conversation that the dataset is below the floor
the product itself refuses to sell.

## 3. Extract signals — one app at a time

Read `reviews/app-N.txt` **in full** (it is one Read call per app), then write
`signals/app-N.json`. Do this for every app before moving on.

Hard rules — these are the product, not style preferences:

- Describe only the sample you were given. "47 analyzed reviews", never "47% of users".
- Never invent numbers. Every `mentionCount` must be countable in the reviews you read.
- Every `reviewId` must appear verbatim in the file. Never fabricate one. At most 6 per theme.
- Excerpts are copied character-for-character from a review you cite. Elide with
  "..." but never paraphrase, never clean up spelling.
- Observations only at this stage. No recommendations.
- Merge near-duplicate themes. Order every list by `mentionCount` descending.
- Prefer specific and falsifiable over broad and safe. A finding nobody could act on is useless.
- Never write "AI-powered", "seamless", "revolutionize", "supercharge", "cutting-edge".
- Thin evidence is a finding with low confidence, not a finding to hide.

Shape (caps: painPoints 8, positiveThemes 6, featureRequests 6, pricingFriction 5, userContexts 5):

```json
{
  "painPoints": [
    {
      "theme": "Short label",
      "description": "What the reviews actually say, one or two sentences.",
      "mentionCount": 23,
      "reviewIds": ["12345678901", "..."],
      "excerpts": ["verbatim fragment from one of the cited reviews"]
    }
  ],
  "positiveThemes": [], "featureRequests": [], "pricingFriction": [], "userContexts": []
}
```

Then:

```
node SCRIPTS/validate.mjs signals --run <dir>
```

It removes fabricated ids, non-verbatim excerpts and evidence-less themes, and
writes `signals/app-N.validated.json`. Read what it dropped. A clean pass is
normal; several drops on one app means you were sloppy — fix that app and rerun
rather than shipping a thinner report.

## 4. Compare and decide — one pass

Read every `signals/app-N.validated.json` (not the drafts), then write
`synthesis.json` in the run directory.

STEP 1 — COMPARE. At most 5 prioritised market gaps. Each preserves
Signal → Interpretation, names the competitors affected, cites supporting review
ids, acknowledges counter-evidence, and carries a confidence with a one-sentence
rationale citing evidence volume, breadth across competitors and dataset quality.
A finding resting only on the thinnest dataset is capped at low confidence.
Also name the market (`marketLabel`, used as the report title) and write a two-
to three-sentence `executiveSummary` saying why users actually leave — specific
to this evidence, not to the category in general.

STEP 2 — DECIDE. Turn those gaps into decisions a founder could act on this week.
At most 3 opportunities, one recommended direction, an MVP of at most 5 features,
an explicit skip list, up to 3 positioning lines and up to 3 marketing angles
taken from real complaints. Do not introduce a recommendation the gaps do not support.

```json
{
  "marketLabel": "Prayer-time and Quran apps",
  "executiveSummary": "...",
  "gaps": [
    {
      "title": "...",
      "signal": "What reviews say.",
      "interpretation": "What it may mean — cautious, clearly an inference.",
      "opportunity": "What that opens up.",
      "affectedApps": ["Exact app name from run.json"],
      "supportingReviewIds": ["12345678901"],
      "counterEvidence": "What argues against this.",
      "confidence": { "level": "high|medium|low", "rationale": "..." }
    }
  ],
  "opportunities": [
    {
      "title": "...", "targetUser": "...", "problem": "...", "proposedDifference": "...",
      "evidence": "Worded as sample evidence.", "risks": "...", "productDecision": "...",
      "confidence": { "level": "medium", "rationale": "..." }
    }
  ],
  "recommendedDirection": "One sentence a founder could act on.",
  "directionRationale": "Why this one and not the others.",
  "mvp": [{ "feature": "...", "why": "..." }],
  "skipForNow": [{ "feature": "...", "why": "Why the evidence does not support it." }],
  "positioning": [{ "line": "...", "note": "..." }],
  "marketingAngles": [{ "line": "...", "source": "The complaint it came from." }],
  "confidence": { "level": "medium", "rationale": "Overall, across the dataset." }
}
```

`affectedApps` must use the exact names in `run.json` — confidence is capped by
the dataset quality of the apps you name, and an unrecognised name silently
loses that protection (the validator prints the mismatch).

Then:

```
node SCRIPTS/validate.mjs synthesis --run <dir>
```

## 5. Build the report

```
node SCRIPTS/build.mjs --run <dir>
```

Computes the Opportunity Score from the stored evidence (never from your
opinion) and writes `report.html`, `report.md` and `score.json`.

Give the user: the score and label, the gap titles, the recommended direction,
and the path to `report.html` (offer `open "<path>"`). `report.html` prints to
PDF cleanly from the browser.

If they want a shareable link, publish `report.html` as an Artifact — load the
`artifact-design` skill first, and republish to the same URL for later edits.

## Guardrails

1. Evidence before recommendation. Every recommendation traces back to reviews.
2. Never fake certainty. High/Medium/Low, never invented percentages.
3. Never misrepresent the sample. "14% of analyzed negative reviews", not "14% of users".
4. Decisions over analytics. A metric that supports no decision does not belong.
5. At most 5 gaps, 3 opportunities, one direction, one MVP.
6. If the evidence is thin, say so in the report. A weak honest report beats a confident invented one.

Write the report in English by default; if the user asks for another language,
translate your own prose but leave review excerpts verbatim in their original.

## Parity with the hosted product

This skill is the AppGap pipeline run locally. Same review source, same dataset
floor, same caps, same citation validation, same score formula — `fetch.mjs`,
`validate.mjs` and `build.mjs` are ports of the product's own collector,
evidence validator and scorer.

Two deliberate differences: you read the reviews yourself instead of the hosted
version's API call, and the character budget per app is doubled (the hosted cap
exists to dodge an API-side failure on very large structured-output requests,
which does not apply to reading a file in-session).

Apple has moved its review endpoint before — the RSS customer-reviews feed went
silent on 2026-09-01 and `userReviewsRow` replaced it. If collection starts
returning nothing for every app and storefront, that is the thing to check, and
`scripts/fetch.mjs` is the one file to change.
