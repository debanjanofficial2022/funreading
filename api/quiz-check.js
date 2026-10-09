// POST /api/quiz-check  { quizId, answers:[index,...] }
// Grades on the server and records the result, so quiz points can't be awarded from the browser.
import { admin, readBody, userFrom, paperFor } from "../lib/server.js";
import { quizzesOn } from "../lib/ai.js";
import { PASS_FRACTION } from "../lib/quiz.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!quizzesOn()) return res.status(503).json({ error: "quizzes are turned off on this site" });
  const user = await userFrom(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  const body = readBody(req);
  const db = admin();

  const { data: quiz } = await db.from("quiz_cache").select("id, paper_id, questions").eq("id", Number(body.quizId) || 0).maybeSingle();
  if (!quiz || !Array.isArray(quiz.questions)) return res.status(404).json({ error: "quiz not found" });
  const paper = await paperFor(user, quiz.paper_id);
  if (!paper) return res.status(404).json({ error: "quiz not found" });

  const { data: read } = await db.from("reads").select("*").eq("user_id", user.id).eq("paper_id", paper.id).maybeSingle();
  if (!read) return res.status(409).json({ error: "mark the paper as read first" });

  const answers = Array.isArray(body.answers) ? body.answers : [];
  const qs = quiz.questions;
  const correct = qs.map(q => q.answer);
  const score = qs.reduce((s, q, i) => s + (Number(answers[i]) === q.answer ? 1 : 0), 0);
  const need = Math.ceil(qs.length * PASS_FRACTION);
  const passed = score >= need;
  const newlyPassed = passed && !read.quiz_passed;

  await db.from("reads").update({
    quiz_best: Math.max(read.quiz_best || 0, score),
    quiz_n: qs.length,
    quiz_passed: read.quiz_passed || passed,
    quiz_attempts: (read.quiz_attempts || 0) + 1,
    quiz_passed_at: newlyPassed ? new Date().toISOString() : read.quiz_passed_at,
  }).eq("user_id", user.id).eq("paper_id", paper.id);

  return res.status(200).json({ score, n: qs.length, need, passed, newlyPassed, correct, explain: qs.map(q => q.explain || "") });
}
