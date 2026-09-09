#!/usr/bin/env node
/**
 * AppGap — deterministic evidence validation, ported from lib/analysis/validator.ts
 * and the caps in lib/analysis/schemas.ts.
 *
 * Phase 0 measured what happens without it: Opus fabricated 2 review ids out of
 * 917 citations, Sonnet 52 across three apps, and both produced excerpts that
 * were not verbatim in the review they cited. The model's output is a proposal;
 * this decides what survives. A local report skips the paywall, never this.
 *
 *   node validate.mjs signals   --run <dir> [--app 1]
 *   node validate.mjs synthesis --run <dir>
 */
import fs from "node:fs/promises";
import path from "node:path";

const THEME_CAPS = { painPoints: 8, positiveThemes: 6, featureRequests: 6, pricingFriction: 5, userContexts: 5 };
const MAX_IDS_PER_THEME = 6;
const MAX_EXCERPTS_PER_THEME = 2;
const MAX_GAPS = 5;
const MAX_OPPORTUNITIES = 3;
const MAX_MVP_FEATURES = 5;
const MAX_POSITIONING = 3;
const MAX_ANGLES = 3;

const RANK = { low: 0, medium: 1, high: 2 };

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) flags[key] = argv[++i];
    else flags[key] = "true";
  }
  return { positionals, flags };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2));

/**
 * Curly quotes become straight and whitespace collapses, but letters and
 * apostrophes are preserved — an earlier checker stripped apostrophes and
 * reported "haven't" as fabricated.
 */
function normalizeForMatch(input) {
  return String(input)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Models legitimately elide the middle of a quote, so each fragment is checked alone. */
function isQuoteGrounded(quote, citedTexts) {
  const fragments = normalizeForMatch(quote)
    .replace(/^["']|["']$/g, "")
    .split(/\.\.\.|…/)
    .map((f) => f.trim())
    .filter((f) => f.length > 12);
  if (fragments.length === 0) return false;
  return fragments.every((f) => citedTexts.some((t) => t.includes(f)));
}

function qualityRank(quality) {
  return quality === "strong" ? "high" : quality === "adequate" ? "medium" : "low";
}

/** Confidence can only ever be lowered by the data, never raised. */
function capConfidenceByDataset(level, qualities) {
  const safe = RANK[level] === undefined ? "low" : level;
  if (qualities.length === 0) return "low";
  const ceiling = qualities
    .map(qualityRank)
    .reduce((best, next) => (RANK[next] > RANK[best] ? next : best), "low");
  return RANK[safe] > RANK[ceiling] ? ceiling : safe;
}

function validateTheme(theme, realIds, textById, drops) {
  const proposed = Array.isArray(theme.reviewIds) ? theme.reviewIds.map(String) : [];
  const real = proposed.filter((id) => realIds.has(id));
  drops.fabricatedIds += proposed.length - real.length;

  const reviewIds = real.slice(0, MAX_IDS_PER_THEME);
  const citedTexts = reviewIds.map((id) => textById.get(id)).filter(Boolean);

  const proposedExcerpts = Array.isArray(theme.excerpts) ? theme.excerpts : [];
  const excerpts = proposedExcerpts.filter((quote) => isQuoteGrounded(quote, citedTexts));
  drops.ungroundedQuotes += proposedExcerpts.length - excerpts.length;

  return {
    theme: String(theme.theme ?? "").trim(),
    description: String(theme.description ?? "").trim(),
    // A count can never exceed the sample it was drawn from.
    mentionCount: Math.min(Number(theme.mentionCount) || 0, realIds.size),
    reviewIds,
    excerpts: excerpts.slice(0, MAX_EXCERPTS_PER_THEME),
  };
}

function validateSignals(signals, reviews) {
  const drops = { fabricatedIds: 0, ungroundedQuotes: 0, themesWithoutEvidence: 0, themesOverCap: 0 };
  const realIds = new Set(reviews.map((r) => r.appleReviewId));
  const textById = new Map(reviews.map((r) => [r.appleReviewId, normalizeForMatch(`${r.title} ${r.body}`)]));

  const out = {};
  for (const key of Object.keys(THEME_CAPS)) {
    const incoming = Array.isArray(signals?.[key]) ? signals[key] : [];
    if (incoming.length > THEME_CAPS[key]) drops.themesOverCap += incoming.length - THEME_CAPS[key];

    const capped = incoming.slice(0, THEME_CAPS[key]).map((t) => validateTheme(t, realIds, textById, drops));
    // A theme with no surviving evidence is not a finding.
    const kept = capped.filter((t) => t.reviewIds.length > 0 && t.theme);
    drops.themesWithoutEvidence += capped.length - kept.length;
    out[key] = kept;
  }
  return { signals: out, drops };
}

function reportDrops(label, drops) {
  const lines = [];
  if (drops.fabricatedIds) lines.push(`${drops.fabricatedIds} fabricated review id(s) removed`);
  if (drops.ungroundedQuotes) lines.push(`${drops.ungroundedQuotes} excerpt(s) not verbatim removed`);
  if (drops.themesWithoutEvidence) lines.push(`${drops.themesWithoutEvidence} theme(s) left without evidence`);
  if (drops.themesOverCap) lines.push(`${drops.themesOverCap} item(s) over the cap trimmed`);
  console.log(lines.length ? `  ${label}: ${lines.join(" · ")}` : `  ${label}: clean`);
}

async function validateSignalFiles(runDir, only) {
  const run = await readJson(path.join(runDir, "run.json"));
  const positions = only ? [Number(only)] : run.apps.map((a) => a.position);
  let missing = 0;

  for (const position of positions) {
    const app = run.apps.find((a) => a.position === position);
    const signalsFile = path.join(runDir, "signals", `app-${position}.json`);
    let proposed;
    try {
      proposed = await readJson(signalsFile);
    } catch {
      console.log(`  app-${position} (${app?.name ?? "?"}): signals/app-${position}.json not written yet`);
      missing++;
      continue;
    }

    const { reviews } = await readJson(path.join(runDir, "corpus", `app-${position}.json`));
    const { signals, drops } = validateSignals(proposed, reviews);
    await writeJson(path.join(runDir, "signals", `app-${position}.validated.json`), signals);

    const kept = Object.values(signals).reduce((n, list) => n + list.length, 0);
    console.log(`  app-${position} ${app?.name ?? ""} → ${kept} themes kept`);
    reportDrops(`app-${position}`, drops);
  }

  if (missing) {
    console.error(`\n${missing} app(s) still need signals. Write them, then run this again.`);
    process.exit(1);
  }
  console.log("\nSignals validated. Next: read the validated signals and write synthesis.json.");
}

const REQUIRED_SYNTHESIS_KEYS = [
  "marketLabel",
  "executiveSummary",
  "gaps",
  "opportunities",
  "recommendedDirection",
  "directionRationale",
  "mvp",
  "skipForNow",
  "positioning",
  "marketingAngles",
  "confidence",
];

async function validateSynthesis(runDir) {
  const run = await readJson(path.join(runDir, "run.json"));
  const proposed = await readJson(path.join(runDir, "synthesis.json"));

  const missing = REQUIRED_SYNTHESIS_KEYS.filter((key) => proposed[key] === undefined);
  if (missing.length) {
    console.error(`synthesis.json is missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  const corpora = await Promise.all(
    run.apps.map((app) => readJson(path.join(runDir, "corpus", `app-${app.position}.json`))),
  );
  const realIds = new Set(corpora.flatMap((c) => c.reviews.map((r) => r.appleReviewId)));
  const qualityByApp = new Map(run.apps.map((a) => [a.name, a.quality]));
  const appNames = run.apps.map((a) => a.name);

  const drops = { fabricatedIds: 0, ungroundedQuotes: 0, themesWithoutEvidence: 0, themesOverCap: 0 };
  const incomingGaps = Array.isArray(proposed.gaps) ? proposed.gaps : [];
  if (incomingGaps.length > MAX_GAPS) drops.themesOverCap += incomingGaps.length - MAX_GAPS;

  const unknownApps = new Set();
  const gaps = incomingGaps.slice(0, MAX_GAPS).map((gap) => {
    const proposedIds = Array.isArray(gap.supportingReviewIds) ? gap.supportingReviewIds.map(String) : [];
    const supportingReviewIds = proposedIds.filter((id) => realIds.has(id));
    drops.fabricatedIds += proposedIds.length - supportingReviewIds.length;

    const affectedApps = Array.isArray(gap.affectedApps) ? gap.affectedApps.map(String) : [];
    for (const name of affectedApps) if (!qualityByApp.has(name)) unknownApps.add(name);

    const qualities = affectedApps.map((name) => qualityByApp.get(name)).filter(Boolean);
    return {
      ...gap,
      affectedApps,
      supportingReviewIds,
      confidence: {
        level: capConfidenceByDataset(gap.confidence?.level, qualities),
        rationale: String(gap.confidence?.rationale ?? ""),
      },
    };
  });

  const keptGaps = gaps.filter((g) => g.supportingReviewIds.length > 0);
  drops.themesWithoutEvidence += gaps.length - keptGaps.length;

  const capConfidence = (confidence) => ({
    level: RANK[confidence?.level] === undefined ? "low" : confidence.level,
    rationale: String(confidence?.rationale ?? ""),
  });

  const validated = {
    marketLabel: String(proposed.marketLabel),
    executiveSummary: String(proposed.executiveSummary),
    gaps: keptGaps,
    opportunities: (proposed.opportunities ?? []).slice(0, MAX_OPPORTUNITIES).map((o) => ({
      ...o,
      confidence: capConfidence(o.confidence),
    })),
    recommendedDirection: String(proposed.recommendedDirection),
    directionRationale: String(proposed.directionRationale),
    mvp: (proposed.mvp ?? []).slice(0, MAX_MVP_FEATURES),
    skipForNow: proposed.skipForNow ?? [],
    positioning: (proposed.positioning ?? []).slice(0, MAX_POSITIONING),
    marketingAngles: (proposed.marketingAngles ?? []).slice(0, MAX_ANGLES),
    confidence: capConfidence(proposed.confidence),
  };

  await writeJson(path.join(runDir, "synthesis.validated.json"), validated);

  console.log(`  ${validated.gaps.length} gap(s) kept · ${validated.opportunities.length} opportunity(ies)`);
  reportDrops("synthesis", drops);
  if (unknownApps.size) {
    console.log(
      `  affectedApps not in this report (ignored for confidence): ${[...unknownApps].join(", ")}` +
        `\n  competitors are: ${appNames.join(", ")}`,
    );
  }
  if (validated.gaps.length === 0) {
    console.error("\nNo gap survived validation. Every gap must cite review ids that exist in the corpus.");
    process.exit(1);
  }
  console.log("\nSynthesis validated. Next: node build.mjs --run <dir>");
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const mode = positionals[0];
  const runDir = flags.run ? path.resolve(flags.run) : null;

  if (!runDir || (mode !== "signals" && mode !== "synthesis")) {
    console.error("Usage: node validate.mjs signals   --run <dir> [--app 1]");
    console.error("       node validate.mjs synthesis --run <dir>");
    process.exit(1);
  }

  if (mode === "signals") await validateSignalFiles(runDir, flags.app);
  else await validateSynthesis(runDir);
}

main().catch((error) => {
  console.error(`\n${error.message ?? error}`);
  process.exit(1);
});
