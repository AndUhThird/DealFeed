// DealFeed pipeline — pulls live Regulation CF offerings from SEC EDGAR.
// Zero dependencies. Node 18+.
//
// Usage:
//   node pipeline/fetch.mjs          -> fetches recent Form C filings, writes docs/data.json
//   node pipeline/fetch.mjs --test   -> parses the local fixture file only (no network)
//
// SEC requires a User-Agent identifying you. Set SEC_USER_AGENT or edit below.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = process.env.SEC_USER_AGENT || "DealFeed-prototype (contact: EDIT-ME@example.com)";
const LOOKBACK_DAYS = 60;   // how far back to search for filings
const MAX_FILINGS = 120;    // safety cap per run
const PAUSE_MS = 350;       // be polite to SEC servers (max ~3 req/sec allowed)

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);

async function get(url, type = "json") {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return type === "json" ? res.json() : res.text();
}

// Extract the text of a single XML tag (Form C XML is flat enough for this).
function tag(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : null;
}
const num = (xml, name) => { const v = tag(xml, name); return v === null ? null : parseFloat(v); };

// MM-DD-YYYY -> YYYY-MM-DD
function usDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function money(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const a = Math.abs(n);
  const s = a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? Math.round(a / 1e3) + "K" : a.toFixed(0);
  return (n < 0 ? "-$" : "$") + s;
}

// Friendly platform names for common intermediaries (fallback: cleaned-up raw name).
const PLATFORMS = {
  "DEALMAKER SECURITIES LLC": "DealMaker",
  "WEFUNDER PORTAL LLC": "Wefunder",
  "STARTENGINE CAPITAL LLC": "StartEngine",
  "STARTENGINE CAPITAL, LLC": "StartEngine",
  "CLIMATIZE EARTH SECURITIES LLC": "Climatize",
  "HONEYCOMB PORTAL LLC": "Honeycomb",
  "SMBX INC": "SMBX",
  "REPUBLIC CORE LLC": "Republic",
  "OPENDEAL PORTAL LLC": "Republic",
  "SILICON PRAIRIE CAPITAL PARTNERS LLC": "Silicon Prairie",
  "FUNDANNA INC": "Fundanna",
  "NETCAPITAL FUNDING PORTAL INC": "Netcapital",
  "VICINITY CAPITAL LLC": "Vicinity",
};
function platformName(raw) {
  if (!raw) return "Unknown platform";
  const key = raw.toUpperCase().replace(/\./g, "").trim();
  if (PLATFORMS[key]) return PLATFORMS[key];
  return raw.replace(/\b(LLC|INC|CORP|L\.L\.C\.|,)\b/gi, "").trim()
            .toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- template summary + red flags (no AI needed) ----------
function summarize(d) {
  const s = [];
  const raise = d.type === "Debt"
    ? `up to ${money(d.maxAmount)} in loan notes`
    : `up to ${money(d.maxAmount)} by selling ${d.security || "shares"}${d.price ? ` at $${d.price.toFixed(2)}/share` : ""}`;
  s.push(`${d.name}, based in ${d.city || "?"}, ${d.state || "?"}, is raising ${raise} on ${d.platform}.`);

  if (d.rev > 0) {
    let g = "";
    if (d.revPrior > 0) {
      const pct = Math.round(((d.rev - d.revPrior) / d.revPrior) * 100);
      g = pct >= 0 ? `, up ${pct}% year-over-year` : `, down ${Math.abs(pct)}% year-over-year`;
    }
    s.push(`It reported ${money(d.rev)} in revenue for its most recent fiscal year${g}, with a net ${d.ni >= 0 ? "profit" : "loss"} of ${money(Math.abs(d.ni))}.`);
  } else {
    s.push(`The company reported no revenue for its most recent fiscal year.`);
  }
  if (d.ni < 0 && d.cash !== null && d.cash < Math.abs(d.ni)) {
    s.push(`Reported cash (${money(d.cash)}) is below its annual loss (${money(Math.abs(d.ni))}), so this raise materially affects its runway.`);
  }
  return s.join(" ");
}

function redFlags(d) {
  const f = [];
  if (d.rev === 0 || d.rev === null) f.push("Pre-revenue: no sales reported in the most recent fiscal year.");
  if (d.rev > 0 && d.revPrior > 0 && d.rev < d.revPrior)
    f.push(`Revenue declined ${Math.round(((d.revPrior - d.rev) / d.revPrior) * 100)}% year-over-year.`);
  if (d.ni < 0 && d.cash !== null && d.cash < Math.abs(d.ni) / 2)
    f.push("Cash on hand covers less than half the most recent annual loss.");
  if (d.shortDebt && d.assets && d.shortDebt > d.assets)
    f.push(`Short-term debt (${money(d.shortDebt)}) exceeds total assets (${money(d.assets)}).`);
  if (d.founded && new Date().getFullYear() - d.founded < 1)
    f.push("Newly formed entity with little or no operating history.");
  if (d.fees) f.push(`Issuer fee load: ${d.fees.length > 150 ? d.fees.slice(0, 150) + "…" : d.fees}`);
  return f;
}

// ---------- parse one Form C primary_doc.xml ----------
function parseFormC(xml, meta = {}) {
  const type = tag(xml, "submissionType");
  if (type !== "C" && type !== "C/A") return null; // skip updates/withdrawals/annual reports

  const secType = tag(xml, "securityOfferedType");
  const deadline = usDate(tag(xml, "deadlineDate"));
  if (deadline && new Date(deadline) < new Date()) return null; // expired offering

  const issuerBlock = xml.split(/<(?:\w+:)?coIssuers>/)[0]; // avoid grabbing co-issuer fields
  const name = tag(issuerBlock, "nameOfIssuer");
  if (!name) return null;

  const incDate = usDate(tag(issuerBlock, "dateIncorporation"));
  return {
    name: name.replace(/,?\s+(INC|LLC|CORP)\.?$/i, "").trim(),
    legal: name,
    city: (tag(issuerBlock, "city") || "").replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase()),
    state: tag(issuerBlock, "stateOrCountry"),
    site: tag(issuerBlock, "issuerWebsite"),
    founded: incDate ? parseInt(incDate.slice(0, 4)) : null,
    type: secType === "Debt" ? "Debt" : "Equity",
    security: tag(xml, "securityOfferedOtherDesc") || secType,
    price: num(xml, "price"),
    minAmount: num(xml, "offeringAmount"),
    maxAmount: num(xml, "maximumOfferingAmount"),
    deadline,
    platformRaw: tag(xml, "companyName"),
    platform: platformName(tag(xml, "companyName")),
    fees: tag(xml, "compensationAmount"),
    rev: num(xml, "revenueMostRecentFiscalYear"),
    revPrior: num(xml, "revenuePriorFiscalYear"),
    ni: num(xml, "netIncomeMostRecentFiscalYear"),
    cash: num(xml, "cashEquiMostRecentFiscalYear"),
    assets: num(xml, "totalAssetMostRecentFiscalYear"),
    shortDebt: num(xml, "shortTermDebtMostRecentFiscalYear"),
    employees: num(xml, "currentEmployees"),
    amended: type === "C/A",
    ...meta,
  };
}

// ---------- EDGAR search ----------
async function searchFilings() {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 86400000);
  const seen = new Set();
  const filings = [];

  for (const q of ["%22crowdfunding%22", "%22offering%22"]) {
    for (let from = 0; from < 100; from += 10) {
      const url = `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=C&startdt=${iso(start)}&enddt=${iso(end)}&from=${from}`;
      let data;
      try { data = await get(url); } catch { break; }
      const hits = data?.hits?.hits || [];
      if (!hits.length) break;
      for (const h of hits) {
        const src = h._source || {};
        const adsh = (h._id || "").split(":")[0] || src.adsh;
        const cik = (src.ciks || [])[0];
        if (!adsh || !cik || seen.has(adsh)) continue;
        seen.add(adsh);
        filings.push({ adsh, cik: parseInt(cik, 10), filed: src.file_date });
      }
      await sleep(PAUSE_MS);
    }
  }
  return filings.slice(0, MAX_FILINGS);
}

async function run() {
  console.log(`Searching EDGAR for Form C filings (last ${LOOKBACK_DAYS} days)…`);
  const filings = await searchFilings();
  console.log(`Found ${filings.length} candidate filings. Fetching details…`);

  const byCik = new Map(); // keep newest filing per issuer
  for (const f of filings) {
    const acc = f.adsh.replace(/-/g, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${acc}/primary_doc.xml`;
    let xml;
    try { xml = await get(url, "text"); } catch { continue; }
    const deal = parseFormC(xml, {
      filed: f.filed,
      filingUrl: `https://www.sec.gov/Archives/edgar/data/${f.cik}/${acc}/`,
      cik: f.cik,
    });
    if (deal) {
      const prev = byCik.get(f.cik);
      if (!prev || (deal.filed || "") > (prev.filed || "")) byCik.set(f.cik, deal);
    }
    await sleep(PAUSE_MS);
  }

  const deals = [...byCik.values()]
    .sort((a, b) => (b.filed || "").localeCompare(a.filed || ""))
    .map((d) => ({ ...d, summary: summarize(d), flags: redFlags(d) }));

  const out = { generated: new Date().toISOString(), count: deals.length, deals };
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(join(ROOT, "docs", "data.json"), JSON.stringify(out, null, 1));
  console.log(`Wrote docs/data.json with ${deals.length} live deals.`);
}

function testFixture() {
  const xml = readFileSync(join(ROOT, "pipeline", "fixtures", "sample_form_c.xml"), "utf8");
  const deal = parseFormC(xml, { filed: "2026-06-12", filingUrl: "https://example.test/", cik: 0 });
  if (!deal) { console.error("FAIL: fixture did not parse"); process.exit(1); }
  deal.summary = summarize(deal);
  deal.flags = redFlags(deal);
  console.log(JSON.stringify(deal, null, 2));
  const ok = deal.name && deal.platform && deal.maxAmount > 0 && deal.summary.length > 50;
  console.log(ok ? "\nPASS: parser + summary look good." : "\nFAIL: missing fields.");
  process.exit(ok ? 0 : 1);
}

process.argv.includes("--test") ? testFixture() : run().catch((e) => { console.error(e); process.exit(1); });
