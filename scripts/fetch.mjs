#!/usr/bin/env node
/**
 * AppGap — local review collector.
 *
 * Ports the parts of the product that MUST stay identical for a local report to
 * be worth the same as a paid one: lib/apple/url.ts (link parsing),
 * lib/apple/client.ts (catalog lookup), lib/reviews/apple-mzstore.ts (the
 * review endpoint that replaced the dead RSS feed on 2026-09-01) and the
 * dataset floor in lib/reviews/types.ts.
 *
 * Node built-ins only: this must run without installing anything, from any
 * directory, with no ANTHROPIC_API_KEY, no Supabase and no Stripe.
 *
 *   node fetch.mjs search "muslim pro" --storefront FR
 *   node fetch.mjs collect <url|id> <url|id> [...] --storefront FR
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SEARCH_ENDPOINT = "https://itunes.apple.com/search";
const LOOKUP_ENDPOINT = "https://itunes.apple.com/lookup";
const REVIEWS_ENDPOINT = "https://itunes.apple.com/WebObjects/MZStore.woa/wa/userReviewsRow";

/** Required. Apple serves JSON to its store client and an HTML redirect to everything else. */
const ITUNES_UA = "iTunes/12.11.3 (Macintosh; OS X 10.15.7) AppleWebKit/605.1.15";
const WINDOW = 250;
const SORT_MOST_RECENT = 4; // Most Recent. The dataset note promises recent reviews.
const DISPLAYABLE_KIND = 11; // iOS software. Without it the endpoint 400s.
const REQUEST_SPACING_MS = 120;

const DEFAULT_LIMIT = 500;
/**
 * Characters of review text handed to one extraction pass.
 *
 * Production caps this at 70k because a large structured-output request to the
 * API fails intermittently (runner.ts). Reading a file in-session has no such
 * ceiling, so the default is doubled here and stays adjustable with --budget.
 */
const DEFAULT_BUDGET = 140_000;
const MIN_TOTAL_REVIEWS = 100;
const MIN_BEST_APP_REVIEWS = 80;
const MAX_APPS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** lib/apple/url.ts — match on the numeric id; slugs are localized and unstable. */
function parseAppStoreUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!/(^|\.)(apps|itunes)\.apple\.com$/i.test(url.hostname)) return null;

  const idMatch = url.pathname.match(/\/id(\d+)/i);
  const appleAppId = idMatch?.[1] ?? url.searchParams.get("id");
  if (!appleAppId || !/^\d+$/.test(appleAppId)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0];
  const storefront = first && /^[a-z]{2}$/i.test(first) ? first.toUpperCase() : null;
  return { appleAppId, storefront };
}

async function callItunes(url) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("The App Store catalog is unreachable right now.");
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error("The App Store catalog is rate limiting us. Try again shortly.");
  }
  if (!response.ok) throw new Error(`The App Store catalog returned HTTP ${response.status}.`);

  // The lookup endpoint sometimes replies with text/javascript, so parse manually.
  const body = await response.text();
  const json = JSON.parse(body);
  return Array.isArray(json.results) ? json.results : [];
}

function normalizeApp(raw, storefront) {
  if (!raw || typeof raw.trackId !== "number" || typeof raw.trackName !== "string") return null;
  return {
    appleAppId: String(raw.trackId),
    name: raw.trackName,
    developer: raw.artistName ?? "",
    category: raw.primaryGenreName ?? "",
    rating: typeof raw.averageUserRating === "number" ? raw.averageUserRating : null,
    ratingCount: typeof raw.userRatingCount === "number" ? raw.userRatingCount : null,
    iconUrl: raw.artworkUrl512 ?? raw.artworkUrl100 ?? null,
    appStoreUrl: raw.trackViewUrl ?? null,
    storefront: storefront.toUpperCase(),
  };
}

async function searchApps(term, storefront, limit = 8) {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("term", term.trim());
  url.searchParams.set("country", storefront.toUpperCase());
  url.searchParams.set("entity", "software");
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 5), 10)));
  const results = await callItunes(url);
  return results.map((r) => normalizeApp(r, storefront)).filter(Boolean);
}

async function fetchAppMetadata(appleAppId, storefront) {
  const url = new URL(LOOKUP_ENDPOINT);
  url.searchParams.set("id", appleAppId);
  url.searchParams.set("country", storefront.toUpperCase());
  url.searchParams.set("entity", "software");
  const results = await callItunes(url);
  const first = results[0];
  if (!first) return null;
  const summary = normalizeApp(first, storefront);
  if (!summary) return null;
  return { ...summary, description: typeof first.description === "string" ? first.description : "" };
}

function normalizeReview(row) {
  const appleReviewId = row?.userReviewId != null ? String(row.userReviewId) : "";
  const rating = Number(row?.rating);
  const body = typeof row?.body === "string" ? row.body.trim() : "";
  if (!appleReviewId) return null;
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return null;
  if (!body) return null; // Empty-review removal (PHASE-2).
  return {
    appleReviewId,
    rating,
    title: typeof row.title === "string" ? row.title.trim() : "",
    body,
    author: typeof row.name === "string" ? row.name.trim() : "",
    reviewDate: typeof row.date === "string" ? row.date : "",
  };
}

async function fetchReviewWindow(appleAppId, cc, startIndex, endIndex) {
  const params = new URLSearchParams({
    cc,
    id: appleAppId,
    "displayable-kind": String(DISPLAYABLE_KIND),
    startIndex: String(startIndex),
    endIndex: String(endIndex),
    sort: String(SORT_MOST_RECENT),
    appVersion: "all",
  });
  try {
    // Apple answers a non-store client with a 302 to the HTML page. Following it
    // would hand JSON.parse a web page; treat it as a failed window.
    const response = await fetch(`${REVIEWS_ENDPOINT}?${params}`, {
      headers: { "User-Agent": ITUNES_UA, Accept: "application/json" },
      redirect: "manual",
    });
    if (!response.ok) return { reviews: [], failed: response.status !== 404 };
    const parsed = JSON.parse(await response.text());
    const rows = parsed?.userReviewList;
    if (!Array.isArray(rows)) return { reviews: [], failed: true };
    return { reviews: rows.map(normalizeReview).filter(Boolean), failed: false };
  } catch {
    return { reviews: [], failed: true };
  }
}

async function fetchReviews(appleAppId, storefront, limit) {
  const cc = storefront.toLowerCase();
  const byId = new Map();
  let requests = 0;
  let failures = 0;

  for (let startIndex = 0; byId.size < limit; startIndex += WINDOW) {
    const endIndex = Math.min(startIndex + WINDOW, limit);
    requests++;
    const { reviews, failed } = await fetchReviewWindow(appleAppId, cc, startIndex, endIndex);
    if (failed) failures++;

    const before = byId.size;
    for (const review of reviews) {
      if (!byId.has(review.appleReviewId)) byId.set(review.appleReviewId, review);
    }
    // A window that adds nothing new is the end of the list, so this cannot spin.
    if (byId.size === before) break;
    await sleep(REQUEST_SPACING_MS);
  }

  const reviews = [...byId.values()].sort((a, b) => (b.reviewDate ?? "").localeCompare(a.reviewDate ?? ""));
  return { reviews: reviews.slice(0, limit), requests, failures };
}

/** lib/reviews/types.ts — thresholds calibrated against measured yields. */
function assessDataset(reviewCount) {
  if (reviewCount >= 250) {
    return { quality: "strong", note: "Enough recent reviews for confident, repeated themes." };
  }
  if (reviewCount >= 80) {
    return { quality: "adequate", note: "Enough to find recurring themes, but thin for rare ones." };
  }
  return { quality: "limited", note: "Too few public reviews to support a finding on its own." };
}

function meetsAnalysisMinimum(counts) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  const best = counts.reduce((max, n) => Math.max(max, n), 0);
  return total >= MIN_TOTAL_REVIEWS && best >= MIN_BEST_APP_REVIEWS;
}

/** The most recent reviews that fit the budget. A report may never claim more than was read. */
function fitToBudget(reviews, budget) {
  const newestFirst = [...reviews].sort((a, b) => (b.reviewDate ?? "").localeCompare(a.reviewDate ?? ""));
  const kept = [];
  let used = 0;
  for (const review of newestFirst) {
    const size = review.appleReviewId.length + review.title.length + review.body.length + 24;
    if (used + size > budget && kept.length > 0) break;
    kept.push(review);
    used += size;
  }
  return kept;
}

/** Exactly how lib/analysis/prompts.ts renders a review for extraction. */
function renderReviewCorpus(app, reviews, quality) {
  const header = [
    `App: ${app.name} by ${app.developer}`,
    `Analyzed sample: ${reviews.length} public App Store reviews (dataset quality: ${quality}).`,
    `Storefront: ${app.storefront} · Category: ${app.category}`,
    "",
    "REVIEWS:",
  ].join("\n");
  const body = reviews
    .map((r) => `[${r.appleReviewId}] ${"*".repeat(r.rating)} (${r.rating}/5) ${r.title}\n${r.body}`)
    .join("\n---\n");
  return `${header}\n${body}\n`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "report";
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function runSearch(terms, storefront) {
  for (const term of terms) {
    const results = await searchApps(term, storefront);
    console.log(`\nSearch "${term}" · ${storefront} App Store`);
    if (results.length === 0) {
      console.log("  no results");
      continue;
    }
    for (const app of results) {
      const rating = app.rating ? `${app.rating.toFixed(1)}★` : "no rating";
      const count = app.ratingCount ? ` (${app.ratingCount.toLocaleString("en-US")})` : "";
      console.log(`  ${app.appleAppId}  ${app.name} — ${app.developer} · ${app.category} · ${rating}${count}`);
    }
  }
  console.log("\nPass the chosen ids to: node fetch.mjs collect <id> <id> --storefront " + storefront);
}

async function runCollect(targets, flags) {
  const resolved = [];
  let storefrontFromUrl = null;

  for (const target of targets) {
    if (/^\d{5,}$/.test(target.trim())) {
      resolved.push(target.trim());
      continue;
    }
    const parsed = parseAppStoreUrl(target);
    if (!parsed) {
      console.error(`Not an App Store link or id: ${target}`);
      console.error('Search by name first: node fetch.mjs search "app name" --storefront US');
      process.exit(1);
    }
    resolved.push(parsed.appleAppId);
    storefrontFromUrl ??= parsed.storefront;
  }

  const unique = [...new Set(resolved)];
  if (unique.length === 0) {
    console.error("Give at least one App Store link or id.");
    process.exit(1);
  }
  if (unique.length > MAX_APPS) {
    console.error(`At most ${MAX_APPS} competitors per report (PRD scope). Got ${unique.length}.`);
    process.exit(1);
  }

  const storefront = (flags.storefront ?? storefrontFromUrl ?? "US").toUpperCase();
  if (!/^[A-Z]{2}$/.test(storefront)) {
    console.error(`Not a storefront code: ${storefront}`);
    process.exit(1);
  }
  const limit = Number(flags.limit ?? DEFAULT_LIMIT);
  const budget = Number(flags.budget ?? DEFAULT_BUDGET);

  console.log(`Storefront: ${storefront} · ${unique.length} competitor(s) · up to ${limit} reviews each\n`);

  const apps = [];
  for (const id of unique) {
    const metadata = await fetchAppMetadata(id, storefront);
    if (!metadata) {
      console.error(`App ${id} is not sold in the ${storefront} App Store. Pick another storefront.`);
      process.exit(1);
    }
    apps.push(metadata);
    console.log(`  ✓ ${metadata.name} — ${metadata.developer}`);
  }

  const outDir = flags.out
    ? path.resolve(flags.out)
    : path.join(os.homedir(), "AppGap Reports", `${slugify(apps[0].name)}-${storefront}-${stamp()}`);
  await fs.mkdir(path.join(outDir, "corpus"), { recursive: true });
  await fs.mkdir(path.join(outDir, "reviews"), { recursive: true });
  await fs.mkdir(path.join(outDir, "signals"), { recursive: true });

  console.log("\nCollecting reviews…");
  // One app's reviews say nothing about another's, so they run together.
  const collected = await Promise.all(
    apps.map(async (app, index) => {
      const { reviews, requests, failures } = await fetchReviews(app.appleAppId, storefront, limit);
      const analyzed = fitToBudget(reviews, budget);
      const dataset = assessDataset(analyzed.length);
      const position = index + 1;

      await fs.writeFile(
        path.join(outDir, "corpus", `app-${position}.json`),
        JSON.stringify({ app, fetchedReviews: reviews.length, reviews: analyzed }, null, 2),
      );
      await fs.writeFile(
        path.join(outDir, "reviews", `app-${position}.txt`),
        renderReviewCorpus(app, analyzed, dataset.quality),
      );

      return { position, app, fetched: reviews.length, analyzed: analyzed.length, requests, failures, dataset };
    }),
  );

  for (const row of collected) {
    const trimmed = row.fetched !== row.analyzed ? ` (of ${row.fetched} fetched)` : "";
    console.log(
      `  ${row.app.name}: ${row.analyzed} reviews${trimmed} · ${row.dataset.quality}` +
        (row.failures ? ` · ${row.failures} failed request(s)` : ""),
    );
  }

  const counts = collected.map((r) => r.analyzed);
  const total = counts.reduce((sum, n) => sum + n, 0);

  const run = {
    createdAt: new Date().toISOString(),
    storefront,
    limit,
    budget,
    totalAnalyzedReviews: total,
    meetsMinimum: meetsAnalysisMinimum(counts),
    apps: collected.map((r) => ({
      position: r.position,
      ...r.app,
      fetchedReviews: r.fetched,
      analyzedReviews: r.analyzed,
      quality: r.dataset.quality,
      qualityNote: r.dataset.note,
    })),
  };
  await fs.writeFile(path.join(outDir, "run.json"), JSON.stringify(run, null, 2));

  console.log(`\nRun directory: ${outDir}`);
  console.log(`Total analyzed: ${total} reviews`);

  if (!run.meetsMinimum) {
    console.error(
      `\nREFUSED: below the analysis floor (${MIN_TOTAL_REVIEWS} total and ${MIN_BEST_APP_REVIEWS} on one app).`,
    );
    console.error("Apple exposed too few public reviews to support an honest report.");
    console.error("Try a bigger storefront (US), bigger apps, or pass --force to analyze anyway.");
    if (flags.force !== "true") process.exit(2);
    console.error("--force given: continuing on a dataset the product itself would refuse.\n");
  }

  console.log("\nNext: read reviews/app-N.txt and write signals/app-N.json for each app.");
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0] === "search" || positionals[0] === "collect" ? positionals.shift() : "collect";
  const storefront = (flags.storefront ?? "US").toUpperCase();

  if (positionals.length === 0) {
    console.error('Usage: node fetch.mjs search "app name" --storefront FR');
    console.error("       node fetch.mjs collect <url|id> [<url|id> ...] --storefront FR");
    process.exit(1);
  }

  if (command === "search") await runSearch(positionals, storefront);
  else await runCollect(positionals, flags);
}

main().catch((error) => {
  console.error(`\n${error.message ?? error}`);
  process.exit(1);
});
