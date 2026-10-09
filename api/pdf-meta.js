// POST /api/pdf-meta  { paperId }  → { doi, title, authors, journal, year } read from the reader's uploaded PDF.
// Finds the DOI printed in the PDF, then looks the paper up in Crossref. Falls back to the PDF's own title.
import { readBody, userFrom, paperFor, pdfBytes, pdfText, doiCandidates, identify } from "../lib/server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = await userFrom(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  const paper = await paperFor(user, readBody(req).paperId);
  if (!paper || paper.owner !== user.id || !paper.pdf_path) return res.status(404).json({ error: "paper not found" });

  try {
    const bytes = await pdfBytes(paper.pdf_path);
    if (!bytes) return res.status(404).json({ error: "pdf not found" });
    // Journal PDFs often carry other articles' DOIs (the previous article on page 1, references,
    // corrections), so rank the DOIs printed in the PDF and keep the one whose title matches its text.
    const { text, firstPages, info } = await pdfText(bytes, { maxPages: 40, maxChars: 400000 });
    const candidates = [...new Set([...doiCandidates(JSON.stringify(info)), ...doiCandidates(text)])];
    const meta = candidates.length ? await identify(candidates, firstPages + " " + text.slice(0, 15000)) : null;
    if (meta) { delete meta.score; return res.status(200).json(meta); }
    return res.status(200).json({ doi: candidates[0] || null, title: typeof info.Title === "string" && info.Title.length > 8 ? info.Title.slice(0, 500) : "" });
  } catch (e) {
    return res.status(200).json({});
  }
}
