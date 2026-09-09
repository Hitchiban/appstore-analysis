# AppGap report skill

Find the gaps your competitors missed — from real App Store reviews, on your own machine.

Give this skill one to five App Store links. It collects the public reviews, reads
them, and writes a report: what users hate, what they love, where the market has
room, what to build first, and what to skip. Every finding cites the reviews it
came from, and every citation is checked in code before it reaches the page.

It is an [Agent Skill](https://code.claude.com/docs/en/skills) for Claude Code. The
bundled scripts do the deterministic work — collecting, validating, scoring — and
Claude does the reading and the judgement. There is no API key, no account and no
payment step; the only network calls go to Apple's public endpoints.

## Install

```bash
git clone https://github.com/Hitchiban/appgap-report.git ~/.claude/skills/appgap-report
```

That is the whole install. Node 18+ (22 recommended), no dependencies, nothing to build.

Claude Code picks the skill up within the running session. If `~/.claude/skills/`
did not exist before, restart Claude Code once so it starts watching the directory.
Run `/skills` to confirm it is listed.

For one project only, clone into `<project>/.claude/skills/appgap-report` instead.

## Use

```
/appgap-report https://apps.apple.com/us/app/whatever/id123456789 https://apps.apple.com/us/app/other/id987654321
```

Or just describe it — "compare these two apps' reviews and tell me what to build
differently" — and the skill triggers on its own. App names work too: it searches
the store and asks you to pick before going further.

Two or three competitors is the sweet spot. Gaps come from comparison.

You get a run directory under `~/AppGap Reports/`:

```
report.html     the report, styled, prints to PDF cleanly
report.md       the same thing in Markdown
score.json      the Opportunity Score and its four components
run.json        competitors, review counts, dataset quality
corpus/         the exact reviews the analysis read
signals/        per-app themes, before and after validation
synthesis.json  gaps and decisions, before and after validation
```

## How it works

| Step | Who | What |
|---|---|---|
| 1 | `fetch.mjs` | Resolves the apps, pulls up to 500 public reviews each from one storefront, refuses a dataset too thin to be honest |
| 2 | Claude | Reads each app's reviews and writes its recurring themes, with review ids and verbatim excerpts |
| 3 | `validate.mjs` | Deletes fabricated ids, non-verbatim quotes and themes left without evidence |
| 4 | Claude | Compares competitors, names the market gaps, turns them into product decisions |
| 5 | `validate.mjs` | Same check on the gaps, then caps confidence by dataset quality |
| 6 | `build.mjs` | Computes the Opportunity Score from the stored evidence and renders the report |

## What keeps it honest

A model asked for 900 citations will invent a few. That is not a hypothetical:
the pipeline this came from measured 2 fabricated review ids out of 917 citations
on one model and 52 across three apps on another, plus quotes that were not
verbatim in the review they cited. So the model's output is treated as a proposal,
and code decides what survives:

- **Fabricated review ids are removed.** Every cited id must exist in the corpus that was actually read.
- **Quotes must be verbatim.** Each fragment is matched character-for-character against the reviews it cites; elisions with `...` are checked fragment by fragment.
- **A theme with no surviving evidence is dropped.** It was never a finding.
- **Counts cannot exceed the sample.** "23 mentions" is clamped to the number of reviews read.
- **Confidence is capped by data, never raised by it.** A gap resting only on a thin dataset cannot claim high confidence.
- **The score is a formula, not an opinion.** Demand, severity, differentiation and evidence strength, each computed from stored numbers and explained line by line.
- **A dataset below the floor is refused.** Under 100 reviews total, or 80 on the best app, the run stops instead of selling you a report built on nothing.

The report says "47 analyzed reviews", never "47% of users". It describes a
sample of public reviews, and says so on the page.

## Scope

Apple App Store only. One storefront per report — reviews differ by country and
mixing them would make the comparison meaningless. Public reviews only, roughly
500 per app at best, most recent first. No download or revenue estimates, no
Google Play, no monitoring.

Apple's feeds are not a stable API. The RSS customer-reviews feed went silent for
every app and storefront on 2026-09-01; this uses the store client's
`userReviewsRow` endpoint instead. If collection ever returns nothing everywhere
at once, that is the thing to check, and `scripts/fetch.mjs` is the one file to fix.

## Other Claude surfaces

Written for Claude Code, where skills have normal network access. On claude.ai you
can upload a skill as a zip, but collection needs outbound access to
`itunes.apple.com` (network egress is a per-account setting, and off by default on
Team/Enterprise), and the container must have Node on the PATH — untested. Skills
running in the Claude API's code-execution container have no network access at
all, so collection cannot work there.

## Credit

Built from [AppGap](https://github.com/Hitchiban/appgap), which does this as a
hosted product. The scripts here are ports of its collector, its evidence
validator and its scorer, so a local report is held to the same rules as a hosted
one.

MIT licensed. Use it, fork it, point it at your own market.
