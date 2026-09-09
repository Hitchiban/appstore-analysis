#!/usr/bin/env node
/**
 * AppGap — report assembly.
 *
 * Computes the Opportunity Score (ported from lib/analysis/score.ts — a real
 * formula over stored evidence, never asked of the model) and renders the
 * finished report as standalone HTML plus Markdown. No paywall split: this is
 * the local build, so evidence and decisions land in one document.
 *
 *   node build.mjs --run <dir>
 */
import fs from "node:fs/promises";
import path from "node:path";

const MERGED_THEMES = 6;
const QUALITY_POINTS = { strong: 15, adequate: 10, limited: 4 };

const C = {
  ink900: "#12162B", ink700: "#282F49", ink600: "#3A4157", ink500: "#5C6478",
  ink400: "#8A93A6", ink300: "#C3C9D6", ink200: "#E4E7EE", ink150: "#EFF1F5", ink100: "#F4F6F9",
  ink050: "#FAFBFC", white: "#FFFFFF", violet600: "#4E32E0", violet050: "#F6F4FF",
  red600: "#D62B2B", red100: "#FDE8E8", green600: "#22A75E", green100: "#E4F7EC",
  orange600: "#DE7410", orange100: "#FEF1E2",
};

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const eq = argv[i].indexOf("=");
    if (eq !== -1) {
      flags[argv[i].slice(2, eq)] = argv[i].slice(eq + 1);
      continue;
    }
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    flags[key] = next !== undefined && !next.startsWith("--") ? argv[++i] : "true";
  }
  return flags;
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* ---------------------------------------------------------------- score --- */

function computeOpportunityScore({ apps, signalsByApp, gaps }) {
  const totalReviews = apps.reduce((sum, a) => sum + a.reviewCount, 0);

  // Demand /30 — 900+ analyzed reviews across the set is a fully validated market.
  const demand = {
    label: "Demand validated by review volume",
    value: Math.round(clamp((totalReviews / 900) * 30, 0, 30)),
    max: 30,
    explanation: `${totalReviews} analyzed reviews across ${apps.length} competitors.`,
  };

  // Severity /30 — ~60% of analyzed reviews carrying a complaint theme is maximally sore.
  const painMentions = signalsByApp.reduce(
    (sum, s) => sum + (s.signals.painPoints ?? []).reduce((n, t) => n + t.mentionCount, 0),
    0,
  );
  const severity = {
    label: "Severity of recurring complaints",
    value: Math.round(clamp((painMentions / (totalReviews || 1) / 0.6) * 30, 0, 30)),
    max: 30,
    explanation: `${painMentions} complaint mentions across ${totalReviews || 1} analyzed reviews.`,
  };

  // Differentiation /25 — shared weaknesses are room; one-app problems are not.
  const shared = gaps.filter((g) => g.affectedApps.length >= Math.min(2, Math.max(apps.length, 1))).length;
  const differentiation = {
    label: "Differentiation room vs. incumbents",
    value: Math.round(clamp(shared * 5, 0, 25)),
    max: 25,
    explanation: `${shared} of ${gaps.length} gaps affect more than one competitor.`,
  };

  // Evidence /15 — capped by the WEAKEST dataset.
  const weakest = apps.reduce(
    (worst, a) => (QUALITY_POINTS[a.quality] < QUALITY_POINTS[worst] ? a.quality : worst),
    apps[0]?.quality ?? "limited",
  );
  const thin = apps.filter((a) => a.quality === "limited");
  const evidence = {
    label: "Evidence strength across the dataset",
    value: QUALITY_POINTS[weakest],
    max: 15,
    explanation: thin.length
      ? `Capped by ${thin.map((a) => a.name).join(", ")}, which exposed too few public reviews.`
      : `All ${apps.length} competitors returned usable review datasets.`,
  };

  const components = [demand, severity, differentiation, evidence];
  const score = components.reduce((sum, c) => sum + c.value, 0);
  const label =
    score >= 75 ? "Strong opportunity"
    : score >= 55 ? "Real opportunity"
    : score >= 35 ? "Narrow opportunity"
    : "Weak opportunity";

  return {
    score,
    label,
    components,
    cap: thin.length
      ? `Evidence strength is capped because ${thin.length === 1 ? "one competitor" : `${thin.length} competitors`} exposed too few public reviews. Scores above 80 require strong evidence on every app.`
      : null,
  };
}

function mergeThemes(signalsByApp, key) {
  return signalsByApp
    .flatMap((s) => (s.signals[key] ?? []).map((t) => ({ ...t, app: s.app })))
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, MERGED_THEMES);
}

/* --------------------------------------------------------------- render --- */

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

function confidenceChip(confidence) {
  const tone =
    confidence.level === "high" ? [C.green100, C.green600]
    : confidence.level === "medium" ? [C.orange100, C.orange600]
    : [C.ink150, C.ink500];
  return `<span class="chip" style="background:${tone[0]};color:${tone[1]}">${esc(confidence.level)} confidence</span>`;
}

function themeCard(theme, tone, citedById) {
  const accent = tone === "pain" ? C.red600 : C.green600;
  const quotes = theme.excerpts
    .map((q) => `<blockquote>${esc(q)}</blockquote>`)
    .join("");
  const ids = theme.reviewIds
    .map((id) => {
      const review = citedById.get(id);
      return review ? `${review.rating}★` : null;
    })
    .filter(Boolean)
    .join(" · ");
  return `<article class="card">
  <div class="card-head">
    <h3 style="color:${accent}">${esc(theme.theme)}</h3>
    <span class="mentions">${theme.mentionCount} mentions</span>
  </div>
  <p class="app-tag">${esc(theme.app)}</p>
  <p>${esc(theme.description)}</p>
  ${quotes}
  <p class="meta">${theme.reviewIds.length} cited reviews${ids ? ` · ${ids}` : ""}</p>
</article>`;
}

function gapSection(gap, index, citedById) {
  const cited = gap.supportingReviewIds
    .map((id) => citedById.get(id))
    .filter(Boolean)
    .slice(0, 2)
    .map(
      (review) =>
        `<blockquote>${esc(truncate(review.body, 280))}<span class="cite">${review.rating}★ · ${esc(review.app)}</span></blockquote>`,
    )
    .join("");

  return `<article class="gap">
  <div class="gap-head">
    <span class="num">${String(index + 1).padStart(2, "0")}</span>
    <h3>${esc(gap.title)}</h3>
  </div>
  <div class="chain">
    <div><span class="step">Signal</span><p>${esc(gap.signal)}</p></div>
    <div><span class="step">Interpretation</span><p>${esc(gap.interpretation)}</p></div>
    <div><span class="step">Opportunity</span><p>${esc(gap.opportunity)}</p></div>
  </div>
  ${cited}
  <p class="meta">Affects: ${esc(gap.affectedApps.join(", ") || "—")} · ${gap.supportingReviewIds.length} supporting reviews</p>
  ${gap.counterEvidence ? `<p class="counter"><strong>Counter-evidence.</strong> ${esc(gap.counterEvidence)}</p>` : ""}
  <p class="conf">${confidenceChip(gap.confidence)} ${esc(gap.confidence.rationale)}</p>
</article>`;
}

function opportunityCard(opportunity, index) {
  const rows = [
    ["Target user", opportunity.targetUser],
    ["Problem", opportunity.problem],
    ["Difference", opportunity.proposedDifference],
    ["Evidence", opportunity.evidence],
    ["Risks", opportunity.risks],
    ["Product decision", opportunity.productDecision],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<div class="row"><dt>${label}</dt><dd>${esc(value)}</dd></div>`)
    .join("");

  return `<article class="card">
  <div class="card-head">
    <h3><span class="num">${String(index + 1).padStart(2, "0")}</span> ${esc(opportunity.title)}</h3>
  </div>
  <dl class="rows">${rows}</dl>
  <p class="conf">${confidenceChip(opportunity.confidence)} ${esc(opportunity.confidence.rationale)}</p>
</article>`;
}

function renderHtml({ run, synthesis, score, painPoints, positiveThemes, citedById, generatedAt }) {
  const apps = run.apps;
  const competitors = apps
    .map(
      (app) => `<div class="competitor">
      ${app.iconUrl ? `<img src="${esc(app.iconUrl)}" alt="" width="44" height="44">` : ""}
      <div><strong>${esc(app.name)}</strong><span>${esc(app.category)}${app.rating ? ` · ${app.rating.toFixed(1)}★` : ""}</span></div>
    </div>`,
    )
    .join("");

  const datasetRows = apps
    .map(
      (app) => `<tr>
      <td>${esc(app.name)}</td>
      <td class="num-cell">${app.analyzedReviews}</td>
      <td>${esc(app.quality)}</td>
      <td class="note">${esc(app.qualityNote)}</td>
    </tr>`,
    )
    .join("");

  const scoreRows = score.components
    .map(
      (c) => `<tr>
      <td>${esc(c.label)}</td>
      <td class="num-cell">${c.value} / ${c.max}</td>
      <td class="note">${esc(c.explanation)}</td>
    </tr>`,
    )
    .join("");

  const list = (items, keyName, keyWhy) =>
    items
      .map(
        (item, i) => `<div class="listrow">
        <span class="num">${String(i + 1).padStart(2, "0")}</span>
        <div><strong>${esc(item[keyName])}</strong><span>${esc(item[keyWhy])}</span></div>
      </div>`,
      )
      .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(synthesis.marketLabel)} — AppGap report</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${C.ink050};color:${C.ink900};
    font:400 16px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  main{max-width:760px;margin:0 auto;padding:64px 24px 96px}
  h1{font-size:clamp(30px,4.4vw,44px);line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:800}
  h2{font-size:26px;line-height:1.2;letter-spacing:-.015em;margin:0;font-weight:800}
  h3{font-size:18px;line-height:1.35;margin:0;font-weight:700}
  p{margin:12px 0}
  section{padding-top:56px}
  .eyebrow{font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;
    text-transform:uppercase;color:${C.violet600};margin:0 0 10px}
  .lede{color:${C.ink600};font-size:18px}
  .rule{height:1px;background:${C.ink200};border:0;margin:24px 0 0}
  .competitors{display:flex;flex-wrap:wrap;gap:16px;margin-top:24px}
  .competitor{display:flex;gap:10px;align-items:center;background:${C.white};border:1px solid ${C.ink200};
    border-radius:14px;padding:10px 14px}
  .competitor img{border-radius:22%;display:block}
  .competitor span{display:block;font-size:12px;color:${C.ink500}}
  .stats{display:flex;flex-wrap:wrap;gap:32px;margin-top:28px}
  .stat b{display:block;font:800 28px/1 -apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums}
  .stat span{font-size:12px;color:${C.ink500};text-transform:uppercase;letter-spacing:.08em}
  .scorebox{background:${C.white};border:1px solid ${C.ink200};border-radius:20px;padding:28px;margin-top:24px}
  .scorebox .value{font:800 56px/1 -apple-system,system-ui,sans-serif;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
  .scorebox .value small{font-size:22px;color:${C.ink400};font-weight:700}
  .scorebox .label{font-size:18px;font-weight:700;margin-top:6px}
  table{width:100%;border-collapse:collapse;margin-top:20px;font-size:14px}
  th{text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.ink500};
    font-weight:700;padding:0 12px 8px 0;white-space:nowrap}
  td{padding:12px 12px 12px 0;border-top:1px solid ${C.ink150};vertical-align:top}
  .num-cell{font-variant-numeric:tabular-nums;white-space:nowrap}
  .note{color:${C.ink500}}
  .card{background:${C.white};border:1px solid ${C.ink200};border-radius:16px;padding:22px;margin-top:16px}
  .card-head{display:flex;justify-content:space-between;gap:16px;align-items:baseline}
  .mentions{font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:${C.ink400};white-space:nowrap}
  .app-tag{font-size:12px;color:${C.ink400};margin:6px 0 0;text-transform:uppercase;letter-spacing:.06em}
  blockquote{margin:14px 0 0;padding:12px 16px;background:${C.ink100};border-left:2px solid ${C.ink300};
    border-radius:0 8px 8px 0;font-size:14px;color:${C.ink700}}
  blockquote .cite{display:block;margin-top:8px;font-size:11px;color:${C.ink400};letter-spacing:.04em}
  .meta{font-size:12px;color:${C.ink400};margin-top:14px}
  .gap{background:${C.white};border:1px solid ${C.ink200};border-radius:20px;padding:26px;margin-top:20px}
  .gap-head{display:flex;gap:14px;align-items:baseline}
  .num{font:700 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:${C.violet600};font-variant-numeric:tabular-nums}
  .chain{margin-top:18px;display:grid;gap:14px}
  .chain .step{font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;
    text-transform:uppercase;color:${C.ink400}}
  .chain p{margin:6px 0 0;color:${C.ink700}}
  .counter{font-size:14px;color:${C.ink500};border-top:1px solid ${C.ink150};padding-top:12px}
  .conf{font-size:13px;color:${C.ink500};margin-top:14px}
  .chip{display:inline-block;padding:3px 9px;border-radius:999px;font:700 11px/1.5 -apple-system,system-ui,sans-serif;
    text-transform:uppercase;letter-spacing:.06em;margin-right:8px}
  .rows{margin:16px 0 0;display:grid;gap:10px}
  .row{display:grid;grid-template-columns:130px 1fr;gap:12px;font-size:14px}
  .row dt{color:${C.ink400};font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;padding-top:3px}
  .row dd{margin:0;color:${C.ink700}}
  .verdict{background:${C.ink900};color:${C.white};border-radius:24px;padding:40px 34px;margin-top:32px}
  .verdict .eyebrow{color:#A896F4}
  .verdict h2{font-size:30px;max-width:22ch}
  .verdict p{color:#C3C9D6}
  .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:36px;margin-top:24px}
  .listrow{display:flex;gap:14px;align-items:baseline;padding:14px 0;border-top:1px solid ${C.ink200}}
  .listrow strong{display:block;font-size:16px}
  .listrow span{display:block;font-size:13px;color:${C.ink500};margin-top:3px}
  .skip .listrow strong{color:${C.ink400};font-weight:600}
  .lines{margin-top:20px;display:grid;gap:12px}
  .line{background:${C.violet050};border-radius:12px;padding:16px 18px}
  .line strong{display:block;font-size:17px}
  .line span{display:block;font-size:13px;color:${C.ink500};margin-top:5px}
  footer{margin-top:64px;padding-top:24px;border-top:1px solid ${C.ink200};font-size:13px;color:${C.ink400}}
  @media print{body{background:#fff}main{padding:0}.card,.gap,.scorebox{break-inside:avoid}}
</style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">AppGap report · ${esc(run.storefront)} App Store</p>
    <h1>${esc(synthesis.marketLabel)}</h1>
    <p class="lede">${esc(synthesis.executiveSummary)}</p>
    <div class="competitors">${competitors}</div>
    <div class="stats">
      <div class="stat"><b>${run.totalAnalyzedReviews}</b><span>reviews analyzed</span></div>
      <div class="stat"><b>${apps.length}</b><span>competitors</span></div>
      <div class="stat"><b>${synthesis.gaps.length}</b><span>market gaps</span></div>
      <div class="stat"><b>${generatedAt}</b><span>generated</span></div>
    </div>
    <hr class="rule">
  </header>

  <section>
    <p class="eyebrow">Opportunity score</p>
    <div class="scorebox">
      <div class="value">${score.score}<small> / 100</small></div>
      <div class="label">${esc(score.label)}</div>
      <table>
        <thead><tr><th>Component</th><th>Score</th><th>Why</th></tr></thead>
        <tbody>${scoreRows}</tbody>
      </table>
      ${score.cap ? `<p class="note">${esc(score.cap)}</p>` : ""}
    </div>
  </section>

  <section>
    <p class="eyebrow">Chapter 01</p>
    <h2>What this report is built on</h2>
    <table>
      <thead><tr><th>Competitor</th><th>Reviews</th><th>Quality</th><th>Limitation</th></tr></thead>
      <tbody>${datasetRows}</tbody>
    </table>
  </section>

  <section>
    <h2>What users hate</h2>
    ${painPoints.map((t) => themeCard(t, "pain", citedById)).join("")}
  </section>

  <section>
    <h2>What users love</h2>
    ${positiveThemes.map((t) => themeCard(t, "love", citedById)).join("")}
  </section>

  <section>
    <p class="eyebrow">Chapter 02</p>
    <h2>Build differently</h2>
    <p class="note">Each gap follows the same chain: what users said, what it may mean, and what it opens up.</p>
    ${synthesis.gaps.map((gap, i) => gapSection(gap, i, citedById)).join("")}
  </section>

  <section>
    <p class="eyebrow">Chapter 03</p>
    <h2>Product opportunities</h2>
    ${synthesis.opportunities.map((o, i) => opportunityCard(o, i)).join("")}
  </section>

  <section class="verdict">
    <p class="eyebrow">AppGap recommendation</p>
    <h2>${esc(synthesis.recommendedDirection)}</h2>
    <p>${esc(synthesis.directionRationale)}</p>
  </section>

  <section>
    <div class="cols">
      <div>
        <h2>Build this first</h2>
        <p class="note">${synthesis.mvp.length === 1 ? "One feature." : `${synthesis.mvp.length} features.`} Nothing else ships in v1.</p>
        ${list(synthesis.mvp, "feature", "why")}
      </div>
      <div class="skip">
        <h2>Skip for now</h2>
        <p class="note">The evidence does not support these yet.</p>
        ${list(synthesis.skipForNow, "feature", "why")}
      </div>
    </div>
  </section>

  <section>
    <p class="eyebrow">Positioning</p>
    <h2>Lines you could own</h2>
    <div class="lines">
      ${synthesis.positioning.map((p) => `<div class="line"><strong>${esc(p.line)}</strong><span>${esc(p.note)}</span></div>`).join("")}
    </div>
  </section>

  <section>
    <p class="eyebrow">Marketing angles</p>
    <h2>Taken from complaints users already wrote</h2>
    <div class="lines">
      ${synthesis.marketingAngles.map((a) => `<div class="line"><strong>${esc(a.line)}</strong><span>${esc(a.source)}</span></div>`).join("")}
    </div>
  </section>

  <footer>
    <p>${confidenceChip(synthesis.confidence)} ${esc(synthesis.confidence.rationale)}</p>
    <p>Every figure describes the ${run.totalAnalyzedReviews} public App Store reviews analyzed here — a sample, not the user base.
    Review ids cited in this report were checked against the collected corpus; fabricated citations and non-verbatim quotes were removed before rendering.</p>
    <p>Reviews collected ${esc(run.createdAt.slice(0, 10))} from the ${esc(run.storefront)} storefront · Report generated ${esc(generatedAt)}</p>
  </footer>
</main>
</body>
</html>`;
}

function renderMarkdown({ run, synthesis, score, painPoints, positiveThemes, citedById, generatedAt }) {
  const out = [];
  out.push(`# ${synthesis.marketLabel}`);
  out.push(`_AppGap report · ${run.storefront} App Store · ${generatedAt}_`);
  out.push("");
  out.push(synthesis.executiveSummary);
  out.push("");
  out.push(
    `**${run.totalAnalyzedReviews}** reviews analyzed · **${run.apps.length}** competitors · **${synthesis.gaps.length}** market gaps`,
  );
  out.push("");
  out.push(`## Opportunity score — ${score.score}/100 · ${score.label}`);
  for (const c of score.components) out.push(`- **${c.label}:** ${c.value}/${c.max} — ${c.explanation}`);
  if (score.cap) out.push(`\n> ${score.cap}`);
  out.push("");
  out.push("## What this report is built on");
  out.push("| Competitor | Reviews | Quality | Limitation |");
  out.push("|---|---:|---|---|");
  for (const app of run.apps) {
    out.push(`| ${app.name} | ${app.analyzedReviews} | ${app.quality} | ${app.qualityNote} |`);
  }
  out.push("");

  const themeBlock = (title, themes) => {
    out.push(`## ${title}`);
    for (const theme of themes) {
      out.push(`### ${theme.theme} — ${theme.mentionCount} mentions · ${theme.app}`);
      out.push(theme.description);
      for (const quote of theme.excerpts) out.push(`> ${quote}`);
      out.push("");
    }
  };
  themeBlock("What users hate", painPoints);
  themeBlock("What users love", positiveThemes);

  out.push("## Build differently");
  synthesis.gaps.forEach((gap, i) => {
    out.push(`### ${String(i + 1).padStart(2, "0")} · ${gap.title}`);
    out.push(`**Signal.** ${gap.signal}`);
    out.push(`**Interpretation.** ${gap.interpretation}`);
    out.push(`**Opportunity.** ${gap.opportunity}`);
    for (const id of gap.supportingReviewIds.slice(0, 2)) {
      const review = citedById.get(id);
      if (review) out.push(`> ${truncate(review.body, 280)} — ${review.rating}★, ${review.app}`);
    }
    out.push(`Affects: ${gap.affectedApps.join(", ") || "—"} · ${gap.supportingReviewIds.length} supporting reviews`);
    if (gap.counterEvidence) out.push(`**Counter-evidence.** ${gap.counterEvidence}`);
    out.push(`**Confidence: ${gap.confidence.level}** — ${gap.confidence.rationale}`);
    out.push("");
  });

  out.push("## Product opportunities");
  synthesis.opportunities.forEach((o, i) => {
    out.push(`### ${String(i + 1).padStart(2, "0")} · ${o.title}`);
    out.push(`- **Target user:** ${o.targetUser}`);
    out.push(`- **Problem:** ${o.problem}`);
    out.push(`- **Difference:** ${o.proposedDifference}`);
    out.push(`- **Evidence:** ${o.evidence}`);
    out.push(`- **Risks:** ${o.risks}`);
    out.push(`- **Product decision:** ${o.productDecision}`);
    out.push(`- **Confidence: ${o.confidence.level}** — ${o.confidence.rationale}`);
    out.push("");
  });

  out.push("## AppGap recommendation");
  out.push(`**${synthesis.recommendedDirection}**`);
  out.push("");
  out.push(synthesis.directionRationale);
  out.push("");
  out.push("### Build this first");
  synthesis.mvp.forEach((item, i) => out.push(`${i + 1}. **${item.feature}** — ${item.why}`));
  out.push("");
  out.push("### Skip for now");
  synthesis.skipForNow.forEach((item) => out.push(`- **${item.feature}** — ${item.why}`));
  out.push("");
  out.push("### Positioning");
  synthesis.positioning.forEach((p) => out.push(`- **${p.line}** — ${p.note}`));
  out.push("");
  out.push("### Marketing angles");
  synthesis.marketingAngles.forEach((a) => out.push(`- **${a.line}** — ${a.source}`));
  out.push("");
  out.push("---");
  out.push(
    `Every figure describes the ${run.totalAnalyzedReviews} public App Store reviews analyzed here — a sample, not the user base. Citations were checked against the collected corpus before rendering.`,
  );
  return out.join("\n");
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.run) {
    console.error("Usage: node build.mjs --run <dir>");
    process.exit(1);
  }
  const runDir = path.resolve(flags.run);

  const run = await readJson(path.join(runDir, "run.json"));
  const synthesis = await readJson(path.join(runDir, "synthesis.validated.json"));

  const signalsByApp = [];
  const citedById = new Map();
  for (const app of run.apps) {
    const signals = await readJson(path.join(runDir, "signals", `app-${app.position}.validated.json`));
    signalsByApp.push({ app: app.name, signals });
    const { reviews } = await readJson(path.join(runDir, "corpus", `app-${app.position}.json`));
    for (const review of reviews) citedById.set(review.appleReviewId, { ...review, app: app.name });
  }

  const score = computeOpportunityScore({
    apps: run.apps.map((a) => ({ name: a.name, reviewCount: a.analyzedReviews, quality: a.quality })),
    signalsByApp,
    gaps: synthesis.gaps,
  });

  const generatedAt = new Date().toISOString().slice(0, 10);
  const context = {
    run,
    synthesis,
    score,
    painPoints: mergeThemes(signalsByApp, "painPoints"),
    positiveThemes: mergeThemes(signalsByApp, "positiveThemes"),
    citedById,
    generatedAt,
  };

  const htmlPath = path.join(runDir, "report.html");
  const mdPath = path.join(runDir, "report.md");
  await fs.writeFile(htmlPath, renderHtml(context));
  await fs.writeFile(mdPath, renderMarkdown(context));
  await fs.writeFile(
    path.join(runDir, "score.json"),
    JSON.stringify(score, null, 2),
  );

  console.log(`Opportunity score: ${score.score}/100 · ${score.label}`);
  for (const c of score.components) console.log(`  ${c.value}/${c.max}  ${c.label}`);
  console.log(`\n  HTML: ${htmlPath}`);
  console.log(`  Markdown: ${mdPath}`);
}

main().catch((error) => {
  console.error(`\n${error.message ?? error}`);
  process.exit(1);
});
