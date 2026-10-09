// Claude calls and feature switches, shared by the AI functions in /api. Server-only.
import { admin } from "./server.js";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
export const aiOn = () => !!process.env.ANTHROPIC_API_KEY;
export const quizzesOn = () => aiOn() && (process.env.QUIZZES === "on" || process.env.VITE_QUIZZES === "true");

const num = (v, d) => { const n = parseInt(v || "", 10); return Number.isFinite(n) && n > 0 ? n : d; };
// One shared daily budget for everything that calls Claude (new quizzes and ring building).
export const USER_DAILY = num(process.env.AI_USER_DAILY_LIMIT || process.env.QUIZ_USER_DAILY_LIMIT, 10);
export const GLOBAL_DAILY = num(process.env.AI_GLOBAL_DAILY_LIMIT || process.env.QUIZ_GLOBAL_DAILY_LIMIT, 300);

// Counts one Claude call against the reader's and the site's daily limits. Returns "ok", "user" or "global".
export async function spendOne(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await admin().rpc("bump_quiz_usage", { p_user: userId, p_day: day, p_user_limit: USER_DAILY, p_global_limit: GLOBAL_DAILY });
  if (error) throw new Error("usage check failed");
  return data;
}

// Sends one prompt and returns the JSON object in Claude's reply.
export async function askClaude(prompt, maxTokens = 2500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("anthropic " + r.status);
  const out = await r.json();
  const text = (out.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no json");
  return JSON.parse(text.slice(a, b + 1));
}
