// Shared helpers for the serverless functions in /api. Server-only: uses the service-role key.
import { createClient } from "@supabase/supabase-js";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

let _admin = null;
export function admin() {
  if (!_admin) _admin = createClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
  return _admin;
}

export function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export async function userFrom(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await admin().auth.getUser(token);
  return (data && data.user) || null;
}

// Loads a paper with its project and checks the reader may use it (the example project, or their own).
export async function paperFor(user, paperId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(paperId || ""))) return null;
  const { data } = await admin().from("papers").select("*, projects!inner(id, owner, is_template)").eq("id", paperId).maybeSingle();
  if (!data) return null;
  const pr = data.projects;
  if (!(pr.is_template || pr.owner === user.id)) return null;
  return data;
}

export async function pdfBytes(path) {
  const { data, error } = await admin().storage.from("pdfs").download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

export async function pdfText(bytes, { maxPages = 40, maxChars = 60000 } = {}) {
  const pdf = await getDocumentProxy(bytes.slice()); // pdf.js takes ownership of the buffer
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text.slice(0, maxPages) : [String(text)];
  let meta = {};
  try { meta = (await getMeta(pdf)).info || {}; } catch {}
  return { text: pages.join("\n\n").replace(/[ \t]+/g, " ").slice(0, maxChars), firstPages: pages.slice(0, 2).join("\n"), info: meta };
}

// DOIs printed in a text, most frequent first, cleaned of common extraction junk.
export function doiCandidates(text) {
  const counts = new Map();
  for (const m of String(text).matchAll(/\b10\.\d{4,9}\/[^\s"<>,]+/g)) {
    let d = m[0].replace(/(View|Download|Supporting|Received|Published).*$/, "").replace(/[^A-Za-z0-9]+$/, "");
    if (/\(ISSN\)|\(ISBN\)/i.test(d) || d.length < 10) continue;
    d = d.replace(/^10\.1002\/ange\./i, "10.1002/anie."); // German edition of Angewandte → international
    const k = d.toLowerCase();
    const e = counts.get(k) || { doi: d, n: 0 }; e.n++; counts.set(k, e);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map(e => e.doi);
}
export const findDoi = text => doiCandidates(text)[0] || null;

// Picks the candidate whose Crossref title best matches the PDF's opening text.
export async function identify(candidates, openingText) {
  const words = s => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 3);
  const hay = new Set(words(openingText));
  let best = null;
  for (const doi of candidates.slice(0, 3)) {
    const m = await crossref(doi).catch(() => null);
    if (!m || !m.title) continue;
    const w = words(m.title); const score = w.length ? w.filter(x => hay.has(x)).length / w.length : 0;
    if (!best || score > best.score) best = { ...m, score };
    if (score >= 0.8) break;
  }
  return best && best.score >= 0.5 ? best : null;
}

export async function crossref(doi) {
  const r = await fetch("https://api.crossref.org/works/" + encodeURIComponent(doi), {
    headers: { "User-Agent": "ReadingRings/1.0 (" + (process.env.CROSSREF_MAILTO || "mailto:unknown@example.com") + ")" },
  });
  if (!r.ok) return null;
  const m = (await r.json()).message || {};
  const authors = (m.author || []).map(a => a.family || a.name).filter(Boolean);
  return {
    doi: m.DOI || doi,
    title: (m.title || [])[0] || "",
    authors: authors.length > 4 ? authors.slice(0, 3).join(", ") + " et al." : authors.join(", "),
    journal: (m["short-container-title"] || [])[0] || (m["container-title"] || [])[0] || "",
    year: ((m.issued || {})["date-parts"] || [[null]])[0][0] || null,
  };
}
