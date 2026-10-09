// GET /api/config → which optional features this deployment has switched on.
import { aiOn, quizzesOn } from "../lib/ai.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ai: aiOn(), quizzes: quizzesOn() });
}
