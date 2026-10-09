// Ring building with Claude: prompts, validation, and checking suggested papers against real records.
import { crossref } from "./server.js";

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MAILTO = () => String(process.env.CROSSREF_MAILTO || "").replace(/^mailto:/, "");

export function organizePrompt(proj, papers) {
  const list = papers.map((p, i) => `${i}. ${clip(p.title, 300)} (${p.year || "n.d."}${p.journal ? ", " + clip(p.journal, 80) : ""})`).join("\n");
  return `You are helping a researcher organize a reading list into concentric "rings": the innermost ring holds the foundations a newcomer should read first, and each ring further out builds on the ones inside it, ending with the current frontier.

Project: ${clip(proj.name, 120)}
${proj.description ? "Description: " + clip(proj.description, 1000) + "\n" : ""}
Papers (index. title (year, journal)):
${list}

Group these papers into 3 to 7 rings, ordered from innermost (foundations) to outermost (frontier). Give each ring a short name (2 to 5 words), a one-line subtitle, and a one or two sentence blurb saying what the ring teaches and why it comes at this point. Assign every paper to exactly one ring, give it a short topic label (2 to 4 words) for grouping within its ring, and mark up to about a fifth of the papers as essential. Also choose a "first pass" of up to 12 papers, in the order a newcomer should read them.

Reply with only this JSON:
{"rings":[{"name":"","sub":"","blurb":""}],"papers":[{"i":0,"ring":0,"topic":"","essential":false}],"firstPass":[0]}`;
}

export function topicPrompt(proj, topic, level) {
  return `You are helping a researcher build a reading list on a topic, organized as concentric "rings": the innermost ring holds the foundations a newcomer should read first, and each ring further out builds on the ones inside it, ending with the current frontier.

Topic: ${clip(topic, 1500)}
Reader: ${clip(level, 200) || "a graduate student new to the topic"}
Project name: ${clip(proj.name, 120)}

Propose 4 to 6 rings, ordered from innermost to outermost. Give each ring a short name (2 to 5 words), a one-line subtitle, and a one or two sentence blurb. For each ring list 4 to 8 real, published papers (reviews are fine) that are widely cited or clearly important. Include each paper's exact title, first author's family name, year, journal, and DOI if you are certain of it (otherwise leave doi empty). Add a one-sentence reason to read it, a short topic label (2 to 4 words), and mark the few most essential papers.

Only list papers you are confident exist with that exact title. Every paper will be checked against bibliographic databases and any that can't be found will be dropped, so never guess or invent a title.

Reply with only this JSON:
{"rings":[{"name":"","sub":"","blurb":"","papers":[{"title":"","author":"","year":2000,"journal":"","doi":"","why":"","topic":"","essential":false}]}]}`;
}

export function cleanRings(raw, max = 7) {
  return (Array.isArray(raw && raw.rings) ? raw.rings : []).slice(0, max)
    .map(r => ({ name: clip(r.name, 80), sub: clip(r.sub, 120), blurb: clip(r.blurb, 400), papers: Array.isArray(r.papers) ? r.papers : [] }))
    .filter(r => r.name);
}

// ---------- checking that a suggested paper exists ----------
const words = s => new Set(String(s).toLowerCase().normalize("NFKD").replace(/<[^>]+>/g, " ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2));
export function titleMatch(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
const shortAuthors = list => list.length > 4 ? list.slice(0, 3).join(", ") + " et al." : list.join(", ");

async function openAlexSearch(title) {
  const u = new URL("https://api.openalex.org/works");
  u.searchParams.set("search", title.slice(0, 250));
  u.searchParams.set("per-page", "5");
  u.searchParams.set("select", "doi,title,publication_year,authorships,primary_location");
  if (MAILTO()) u.searchParams.set("mailto", MAILTO());
  const r = await fetch(u); if (!r.ok) return [];
  return ((await r.json()).results || []).map(w => ({
    title: w.title || "", year: w.publication_year || null, doi: (w.doi || "").replace(/^https?:\/\/doi\.org\//i, "") || null,
    journal: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || "",
    authors: shortAuthors((w.authorships || []).map(a => (a.author && a.author.display_name || "").split(" ").pop()).filter(Boolean)),
  }));
}
async function crossrefSearch(title) {
  const u = new URL("https://api.crossref.org/works");
  u.searchParams.set("query.bibliographic", title.slice(0, 250)); u.searchParams.set("rows", "5");
  u.searchParams.set("select", "DOI,title,issued,author,container-title,short-container-title");
  const r = await fetch(u, { headers: { "User-Agent": "FunReading/1.0 (" + (process.env.CROSSREF_MAILTO || "mailto:unknown@example.com") + ")" } });
  if (!r.ok) return [];
  return (((await r.json()).message || {}).items || []).map(m => ({
    title: (m.title || [])[0] || "", doi: m.DOI || null, year: ((m.issued || {})["date-parts"] || [[null]])[0][0] || null,
    journal: (m["short-container-title"] || [])[0] || (m["container-title"] || [])[0] || "",
    authors: shortAuthors((m.author || []).map(a => a.family || a.name).filter(Boolean)),
  }));
}

// Returns the real record for a suggested paper, or null if it can't be found.
export async function verifyPaper(s) {
  const title = clip(s.title, 500); if (title.length < 8) return null;
  const yearOk = y => !s.year || !y || Math.abs(Number(s.year) - Number(y)) <= 1;
  const doi = clip(s.doi, 200).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  if (/^10\.\d{4,9}\//.test(doi)) {
    const m = await crossref(doi).catch(() => null);
    if (m && titleMatch(title, m.title) >= 0.75) return m;
  }
  for (const search of [openAlexSearch, crossrefSearch]) {
    const hits = await search(title).catch(() => []);
    const best = hits.map(h => ({ h, score: titleMatch(title, h.title) })).filter(x => x.score >= 0.8 && yearOk(x.h.year)).sort((a, b) => b.score - a.score)[0];
    if (best) return best.h;
  }
  return null;
}

// Runs fn over items with a few requests in flight at once.
export async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
