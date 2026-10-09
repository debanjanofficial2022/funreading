// POST /api/rings  { projectId, mode: "organize" | "topic", topic?, level? }
// Asks Claude to lay out a project's rings and returns a preview; nothing is saved until the reader applies it.
//  organize: sorts the papers already in the project into rings, with topics, essentials and a first pass.
//  topic:    proposes rings and papers for a topic. Every suggested paper is looked up in OpenAlex or Crossref
//            and dropped if it can't be found, so the preview only holds real papers with real details.
import { admin, readBody, userFrom } from "../lib/server.js";
import { aiOn, spendOne, askClaude } from "../lib/ai.js";
import { organizePrompt, topicPrompt, cleanRings, verifyPaper, pool } from "../lib/rings.js";

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!aiOn()) return res.status(503).json({ error: "AI features are turned off on this site" });
  const user = await userFrom(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  const body = readBody(req);
  if (!/^[0-9a-f-]{36}$/i.test(String(body.projectId || ""))) return res.status(400).json({ error: "bad project" });
  const db = admin();
  const { data: proj } = await db.from("projects").select("id, owner, name, description").eq("id", body.projectId).maybeSingle();
  if (!proj || proj.owner !== user.id) return res.status(404).json({ error: "project not found" });

  const mode = body.mode === "topic" ? "topic" : "organize";
  let papers = [];
  if (mode === "organize") {
    const { data } = await db.from("papers").select("id, title, year, journal").eq("project_id", proj.id).order("position").limit(401);
    papers = data || [];
    if (papers.length < 3) return res.status(400).json({ error: "Add at least 3 papers first, or start from a topic." });
    if (papers.length > 400) return res.status(400).json({ error: "This project has more than 400 papers, too many to sort in one go." });
  } else if (clip(body.topic, 1500).length < 3) {
    return res.status(400).json({ error: "Describe the topic in a few words." });
  }

  let verdict;
  try { verdict = await spendOne(user.id); } catch { return res.status(500).json({ error: "usage check failed" }); }
  if (verdict !== "ok") return res.status(429).json({ reason: verdict });

  try {
    if (mode === "organize") {
      const raw = await askClaude(organizePrompt(proj, papers), 12000);
      const rings = cleanRings(raw).map(({ papers: _, ...r }) => r);
      if (rings.length < 2) return res.status(502).json({ error: "Claude didn't return usable rings. Try again." });
      const byIdx = new Map();
      for (const a of Array.isArray(raw.papers) ? raw.papers : []) {
        const i = Number(a.i), ring = Number(a.ring);
        if (Number.isInteger(i) && papers[i] && Number.isInteger(ring) && rings[ring] && !byIdx.has(i))
          byIdx.set(i, { id: papers[i].id, ring, topic: clip(a.topic, 60), essential: !!a.essential });
      }
      // anything Claude skipped goes to the outermost ring, so no paper is lost
      const assign = papers.map((p, i) => byIdx.get(i) || { id: p.id, ring: rings.length - 1, topic: "", essential: false });
      const firstPass = [...new Set((Array.isArray(raw.firstPass) ? raw.firstPass : []).map(Number))].filter(i => papers[i]).slice(0, 12).map(i => papers[i].id);
      return res.status(200).json({ mode, rings, assign, firstPass, skipped: papers.length - byIdx.size });
    }

    const raw = await askClaude(topicPrompt(proj, body.topic, body.level), 12000);
    const rings = cleanRings(raw, 6);
    if (!rings.length) return res.status(502).json({ error: "Claude didn't return usable rings. Try again." });
    const flat = rings.flatMap((r, ri) => r.papers.slice(0, 8).map(p => ({ ...p, ri })));
    const found = await pool(flat, 6, p => verifyPaper(p).catch(() => null));
    const seen = new Set();
    const out = rings.map(r => ({ name: r.name, sub: r.sub, blurb: r.blurb, papers: [] }));
    flat.forEach((s, k) => {
      const m = found[k]; if (!m) return;
      const key = (m.doi || m.title).toLowerCase(); if (seen.has(key)) return; seen.add(key);
      out[s.ri].papers.push({ title: clip(m.title, 500), authors: clip(m.authors, 1000), journal: clip(m.journal, 200), year: m.year || null, doi: m.doi || null,
        note: clip(s.why, 1000), topic: clip(s.topic, 60), essential: !!s.essential });
    });
    const kept = out.filter(r => r.papers.length);
    return res.status(200).json({ mode, rings: kept, suggested: flat.length, verified: seen.size });
  } catch (e) {
    return res.status(502).json({ error: "Couldn't build rings this time. Try again." });
  }
}
