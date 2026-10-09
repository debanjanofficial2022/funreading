// Scholar points, levels, streaks and badges. Pure functions of a reader's reads, so the same
// numbers come out everywhere and nothing has to be stored separately.

export const XP = { read: 10, quiz: 50, dailyGoal: 20, weeklyGoal: 50 };

export const LEVELS = [
  [0, "Curious reader"], [50, "Undergraduate"], [150, "First-year"], [300, "Qualifier"], [500, "Candidate"],
  [800, "Senior candidate"], [1200, "Postdoc"], [1700, "Research scientist"], [2400, "Principal investigator"], [3500, "Distinguished professor"],
];

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const weekKey = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(d); };

export function levelFor(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++;
  const [floor, name] = LEVELS[i], next = LEVELS[i + 1] || null;
  return { n: i + 1, name, floor, next: next ? { xp: next[0], name: next[1] } : null };
}

function streakOf(perDay, goal, from) {
  let s = 0; const d = new Date(from);
  if ((perDay[dayKey(d)] || 0) < goal) d.setDate(d.getDate() - 1);
  while ((perDay[dayKey(d)] || 0) >= goal) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
function bestStreak(perDay, goal) {
  const days = Object.keys(perDay).filter(k => perDay[k] >= goal).map(k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getTime(); }).sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const t of days) { run = prev !== null && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = t; }
  return best;
}

/**
 * @param reads  [{paper_id, read_at, quiz_passed}]
 * @param goals  {daily, weekly}
 * @param index  Map paper_id → {project_id, section}   (papers the reader can see)
 * @param now    Date (for tests)
 */
export function computeGame(reads, goals, index = new Map(), now = new Date()) {
  const daily = Math.max(1, goals.daily | 0), weekly = Math.max(1, goals.weekly | 0);
  const perDay = {}, perWeek = {};
  for (const r of reads) {
    const t = new Date(r.read_at).getTime(); if (!t) continue;
    perDay[dayKey(t)] = (perDay[dayKey(t)] || 0) + 1;
    perWeek[weekKey(t)] = (perWeek[weekKey(t)] || 0) + 1;
  }
  const nRead = reads.length, nQuiz = reads.filter(r => r.quiz_passed).length;
  const goalDays = Object.values(perDay).filter(n => n >= daily).length;
  const goalWeeks = Object.values(perWeek).filter(n => n >= weekly).length;
  const xp = nRead * XP.read + nQuiz * XP.quiz + goalDays * XP.dailyGoal + goalWeeks * XP.weeklyGoal;

  const today = perDay[dayKey(now)] || 0, week = perWeek[weekKey(now)] || 0;
  const streak = streakOf(perDay, daily, now), best = bestStreak(perDay, daily);

  // completed sections and projects
  const readSet = new Set(reads.map(r => r.paper_id));
  const secTotal = {}, secRead = {}, projTotal = {}, projRead = {};
  for (const [id, p] of index) {
    const sk = p.project_id + "|" + p.section;
    secTotal[sk] = (secTotal[sk] || 0) + 1; projTotal[p.project_id] = (projTotal[p.project_id] || 0) + 1;
    if (readSet.has(id)) { secRead[sk] = (secRead[sk] || 0) + 1; projRead[p.project_id] = (projRead[p.project_id] || 0) + 1; }
  }
  const ringsDone = Object.keys(secTotal).filter(k => secTotal[k] >= 3 && secRead[k] === secTotal[k]).length;
  const projectsDone = Object.keys(projTotal).filter(k => projTotal[k] >= 5 && projRead[k] === projTotal[k]).length;

  const B = (id, name, desc, have, need) => ({ id, name, desc, earned: have >= need, progress: Math.min(have, need), need });
  const badges = [
    B("first", "First page", "Read your first paper", nRead, 1),
    B("ten", "Bookworm", "Read 10 papers", nRead, 10),
    B("fifty", "Deep diver", "Read 50 papers", nRead, 50),
    B("hundred", "Centurion", "Read 100 papers", nRead, 100),
    B("quiz1", "Quiz whiz", "Pass your first quiz", nQuiz, 1),
    B("quiz10", "Examiner", "Pass 10 quizzes", nQuiz, 10),
    B("quiz50", "Defended", "Pass 50 quizzes", nQuiz, 50),
    B("streak3", "On a roll", "Meet your daily goal 3 days in a row", best, 3),
    B("streak7", "Unstoppable", "Meet your daily goal 7 days in a row", best, 7),
    B("streak30", "Habit formed", "Meet your daily goal 30 days in a row", best, 30),
    B("weeks4", "Steady scholar", "Meet your weekly goal in 4 different weeks", goalWeeks, 4),
    B("ring", "Ring complete", "Read every paper in a section of 3 or more", ringsDone, 1),
    B("project", "Finisher", "Read every paper in a project of 5 or more", projectsDone, 1),
  ];
  return { xp, level: levelFor(xp), nRead, nQuiz, today, week, daily, weekly, streak, best, goalDays, goalWeeks, badges };
}
