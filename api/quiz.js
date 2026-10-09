// POST /api/quiz  { paperId, fresh?, exclude? }  → { quizId, source, questions:[{q, options}] }
// Answers stay on the server; /api/quiz-check grades. Each paper's quizzes are cached, so a quiz
// is paid for once and then served free. New quizzes count against daily per-reader and site limits.
import { admin, readBody, userFrom, paperFor, pdfBytes, pdfText } from "../lib/server.js";
import { quizPrompt, validQuestions } from "../lib/quiz.js";
import { MODEL, quizzesOn, spendOne, askClaude } from "../lib/ai.js";

const MAX_SETS = 5;

const strip = qs => qs.map(q => ({ q: q.q, options: q.options }));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!quizzesOn()) return res.status(503).json({ error: "quizzes are turned off on this site" });
  const user = await userFrom(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  const body = readBody(req);
  const paper = await paperFor(user, body.paperId);
  if (!paper) return res.status(404).json({ error: "paper not found" });
  const db = admin();

  // A reader's own PDF makes a better quiz; quizzes from it stay with that paper (which only they can see).
  const { data: sets } = await db.from("quiz_cache").select("id, questions, source").eq("paper_id", paper.id).order("id");
  const all = sets || [];
  const wantPdf = !!paper.pdf_path;
  const matching = all.filter(s => (wantPdf ? s.source === "pdf" : true));
  const usable = matching.filter(s => s.id !== body.exclude);
  if (usable.length && (!body.fresh || matching.length >= MAX_SETS)) {
    const pick = usable[Math.floor(Math.random() * usable.length)];
    if (pick.questions && pick.questions.unknown) return res.status(200).json({ unknown: true });
    return res.status(200).json({ quizId: pick.id, source: pick.source, questions: strip(pick.questions) });
  }
  if (!usable.length && matching.length && matching[0].questions?.unknown) return res.status(200).json({ unknown: true });

  let verdict;
  try { verdict = await spendOne(user.id); } catch { return res.status(500).json({ error: "usage check failed" }); }
  if (verdict !== "ok") return res.status(429).json({ reason: verdict });

  try {
    let text = null, source = "knowledge";
    if (wantPdf) {
      const bytes = await pdfBytes(paper.pdf_path);
      if (bytes) { const t = await pdfText(bytes); if (t.text.trim().length > 500) { text = t.text; source = "pdf"; } }
    }
    const raw = await askClaude(quizPrompt(paper, text));
    if (raw && raw.unknown) {
      await db.from("quiz_cache").insert({ paper_id: paper.id, questions: { unknown: true }, source, model: MODEL });
      return res.status(200).json({ unknown: true });
    }
    const questions = validQuestions(raw);
    if (questions.length < 3) return res.status(502).json({ error: "incomplete quiz" });
    const { data: saved } = await db.from("quiz_cache").insert({ paper_id: paper.id, questions, source, model: MODEL }).select("id").single();
    return res.status(200).json({ quizId: saved && saved.id, source, questions: strip(questions) });
  } catch (e) {
    return res.status(502).json({ error: "generation failed" });
  }
}
