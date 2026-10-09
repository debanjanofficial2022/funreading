import { createClient } from "@supabase/supabase-js";
import { EXAMPLE_PROJECT, EXAMPLE_PAPERS } from "./example.js";
import { linkSet, cleanDoi } from "./links.js";
import { computeGame, XP } from "./game.js";

/* ============ setup ============ */
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL, SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const sb = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY, { auth: { flowType: "pkce", detectSessionInUrl: true } }) : null;
// Optional features, switched on by the server (see /api/config): AI ring building and quizzes.
let QUIZ = false, AI = false;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EX = EXAMPLE_PROJECT.id;
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const A = {
  session: null, ready: false,
  profile: { daily_goal: 1, weekly_goal: 5 },
  projects: [],                 // the reader's own projects (the example is always added in front)
  papers: { [EX]: EXAMPLE_PAPERS }, // project id → papers (loaded on demand)
  index: new Map(),             // paper id → {project_id, section}, for every paper the reader can see
  reads: new Map(),             // paper id → read row
  view: { q: "", star: false, hide: false, confirm: null, addTab: "find", findQ: "", find: null },
  game: null,
};
EXAMPLE_PAPERS.forEach(p => A.index.set(p.id, { project_id: EX, section: p.section }));
const allProjects = () => [EXAMPLE_PROJECT, ...A.projects];
const projectById = id => allProjects().find(p => p.id === id);
const isOwner = p => !!(A.session && p && p.owner === A.session.user.id);
const signedIn = () => !!A.session;

/* ============ toasts and the game ============ */
function toast(html, cls = "") {
  const t = document.createElement("div"); t.className = "toast " + cls; t.innerHTML = html;
  $("toasts").appendChild(t); setTimeout(() => t.remove(), 4200);
}
function regame(announce = true) {
  const before = A.game;
  A.game = computeGame([...A.reads.values()], { daily: A.profile.daily_goal, weekly: A.profile.weekly_goal }, A.index);
  if (announce && before) {
    const d = A.game.xp - before.xp;
    if (d > 0) toast(`<b>+${d} XP</b> · ${esc(d >= XP.quiz ? "Quiz passed" : A.game.today >= A.game.daily && before.today < before.daily ? "Daily goal met" : "Paper read")}`);
    if (A.game.level.n > before.level.n) toast(`Level up! You're now a <b>${esc(A.game.level.name)}</b>.`, "level");
    for (const b of shownBadges(A.game)) if (b.earned && !before.badges.find(x => x.id === b.id).earned) toast(`Badge unlocked: <b>${esc(b.name)}</b>`);
  }
  drawTop();
}
function drawTop() {
  const g = A.game, el = $("topright");
  const pill = g ? `<a class="xp-pill" href="#/" title="Your level and scholar points">Lv ${g.level.n}<span class="lvl-name"> · ${esc(g.level.name)}</span> · <b>${g.xp} XP</b></a>` : "";
  el.innerHTML = pill;
}

/* ============ data ============ */
const guestReads = () => ls.get("rr-guest-reads", {});
function loadGuest() {
  A.reads = new Map(Object.entries(guestReads()).map(([id, r]) => [id, { paper_id: id, ...r }]));
  A.profile = { ...A.profile, ...ls.get("rr-guest-goals", {}) };
}
function saveGuest() {
  const o = {}; for (const [id, r] of A.reads) o[id] = { read_at: r.read_at, confidence: r.confidence || null };
  ls.set("rr-guest-reads", o); ls.set("rr-guest-goals", { daily_goal: A.profile.daily_goal, weekly_goal: A.profile.weekly_goal });
}
async function loadAccount() {
  const uid = A.session.user.id;
  let { data: prof } = await sb.from("profiles").select("*").eq("user_id", uid).maybeSingle();
  if (!prof) {
    const g = ls.get("rr-guest-goals", {});
    ({ data: prof } = await sb.from("profiles").insert({ user_id: uid, daily_goal: g.daily_goal || 1, weekly_goal: g.weekly_goal || 5 }).select().single());
  }
  if (prof) A.profile = prof;
  const { data: projects } = await sb.from("projects").select("*").eq("owner", uid).order("created_at");
  A.projects = projects || [];
  const ids = A.projects.map(p => p.id);
  if (ids.length) {
    const { data: idx } = await sb.from("papers").select("id, project_id, section").in("project_id", ids);
    (idx || []).forEach(p => A.index.set(p.id, { project_id: p.project_id, section: p.section }));
  }
  // bring over papers ticked before signing in (example project only)
  const guest = guestReads();
  const { data: reads } = await sb.from("reads").select("*");
  A.reads = new Map((reads || []).map(r => [r.paper_id, r]));
  const carry = Object.keys(guest).filter(id => !A.reads.has(id) && A.index.get(id)?.project_id === EX);
  if (carry.length) {
    const { data: added } = await sb.from("reads").insert(carry.map(id => ({ user_id: uid, paper_id: id, confidence: guest[id].confidence || null }))).select();
    (added || []).forEach(r => A.reads.set(r.paper_id, r));
    ls.set("rr-guest-reads", {});
  }
}
async function loadPapers(pid) {
  if (pid === EX || A.papers[pid]) return;
  const { data, error } = await sb.from("papers").select("*").eq("project_id", pid).order("position").order("created_at");
  if (error) throw error;
  A.papers[pid] = data || [];
  A.papers[pid].forEach(p => A.index.set(p.id, { project_id: pid, section: p.section }));
}

/* ============ reading actions ============ */
async function setRead(paper, on) {
  const before = A.reads.get(paper.id);
  if (on) A.reads.set(paper.id, { paper_id: paper.id, read_at: new Date().toISOString(), confidence: null, quiz_passed: false });
  else A.reads.delete(paper.id);
  regame(); render();
  if (!signedIn()) { saveGuest(); return; }
  const uid = A.session.user.id;
  const { data, error } = on
    ? await sb.from("reads").insert({ user_id: uid, paper_id: paper.id }).select().single()
    : await sb.from("reads").delete().eq("user_id", uid).eq("paper_id", paper.id);
  if (error) { if (before) A.reads.set(paper.id, before); else A.reads.delete(paper.id); toast("Couldn't save that. Check your connection and try again."); regame(false); render(); return; }
  if (on && data) A.reads.set(paper.id, data);
}
async function setConfidence(paper, v) {
  const r = A.reads.get(paper.id); if (!r) return;
  r.confidence = v; render();
  if (!signedIn()) { saveGuest(); return; }
  const { error } = await sb.from("reads").update({ confidence: v }).eq("user_id", A.session.user.id).eq("paper_id", paper.id);
  if (error) toast("Couldn't save your confidence. Try again.");
}
async function saveGoals(daily, weekly) {
  A.profile = { ...A.profile, daily_goal: daily, weekly_goal: weekly };
  regame(false); render();
  if (!signedIn()) { saveGuest(); return; }
  await sb.from("profiles").update({ daily_goal: daily, weekly_goal: weekly }).eq("user_id", A.session.user.id);
}

/* ============ library proxy (per browser) ============ */
let proxy = ls.get("rr-proxy", { prefix: "", on: false });
const via = (u, ext) => (proxy.on && proxy.prefix && !ext ? proxy.prefix + u : u);

/* ============ views ============ */
const app = $("app");
function route() {
  const m = location.hash.match(/^#\/p\/([0-9a-f-]{36})/i);
  return m ? { name: "project", id: m[1] } : { name: "home" };
}
function render() {
  if (!A.ready) { app.innerHTML = `<p class="note">Loading…</p>`; return; }
  const r = route();
  if (r.name === "project") renderProject(r.id); else renderHome();
}

/* ---------- ring map ---------- */
function ringMap(project, papers) {
  const secs = project.sections || [];
  const Sz = 420, c = Sz / 2, inner = 34, w = (c - inner - 8) / Math.max(1, secs.length);
  let h = `<svg viewBox="0 0 ${Sz} ${Sz}" role="img" aria-label="${secs.length} sections as concentric rings">`;
  for (let i = secs.length - 1; i >= 0; i--) {
    const s = secs[i], r0 = inner + i * w, r1 = r0 + w, col = `var(--r${Math.min(5, Math.round(i * 5 / Math.max(1, secs.length - 1)))})`;
    const inSec = papers.filter(p => p.section === s.id), rd = inSec.filter(p => A.reads.has(p.id)).length;
    const dark = i * 5 / Math.max(1, secs.length - 1) < 2.5;
    const d = `M ${c - r1} ${c} a ${r1} ${r1} 0 1 0 ${2 * r1} 0 a ${r1} ${r1} 0 1 0 ${-2 * r1} 0 Z M ${c - r0} ${c} a ${r0} ${r0} 0 1 1 ${2 * r0} 0 a ${r0} ${r0} 0 1 1 ${-2 * r0} 0 Z`;
    h += `<a href="#sec-${esc(s.id)}" data-act="jump" data-id="sec-${esc(s.id)}" aria-label="${esc(s.name)}: ${rd} of ${inSec.length} read"><path class="band" fill-rule="evenodd" d="${d}" fill="${col}" stroke="var(--bg)" stroke-width="2"></path></a>`;
    if (w >= 16) {
      const label = `${ROMAN[i] || i + 1} · ${s.name.replace(/^The /, "").toUpperCase()}`.slice(0, 30);
      h += `<text class="ringlabel" x="${c}" y="${c - (r0 + w / 2) - 1}" text-anchor="middle" fill="${dark ? "var(--bg)" : "var(--ink)"}">${esc(label)}</text>`;
      h += `<text class="ringcount" x="${c}" y="${c + (r0 + w / 2) + 4}" text-anchor="middle" fill="${dark ? "var(--bg)" : "var(--muted)"}">${rd}/${inSec.length} read</text>`;
    }
  }
  return h + `<circle cx="${c}" cy="${c}" r="${inner - 3}" fill="var(--ink)"></circle></svg>`;
}

/* ---------- home ---------- */
const BADGE_ICON = (earned, i) => `<svg viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="15" fill="${earned ? "var(--accent)" : "var(--line)"}"/><circle cx="17" cy="17" r="10" fill="none" stroke="var(--bg)" stroke-width="2.5"/><text x="17" y="21" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--bg)">${ROMAN[i % 12]}</text></svg>`;
function projectCard(p) {
  const papers = [...A.index.entries()].filter(([, v]) => v.project_id === p.id);
  const n = papers.length, rd = papers.filter(([id]) => A.reads.has(id)).length, pct = n ? Math.round(100 * rd / n) : 0;
  return `<a class="card pcard" href="#/p/${p.id}">
    <div class="row"><span>${p.is_template ? '<span class="tag example">EXAMPLE</span>' : '<span class="tag mine">MY PROJECT</span>'}</span><span>${n} paper${n === 1 ? "" : "s"}</span></div>
    <h3>${esc(p.name)}</h3><p>${esc(p.description || "No description yet.")}</p>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="row"><span>${rd} read</span><span>${pct}%</span></div></a>`;
}
const shownBadges = g => QUIZ ? g.badges : g.badges.filter(b => !b.id.startsWith("quiz"));
function renderHome() {
  const g = A.game;
  const guestNote = signedIn() ? `<p class="note">No account needed: your projects and progress are tied to this browser. Clearing this site's data or switching browsers starts you fresh.</p>`
    : `<p class="note">${sb ? "Couldn't set up storage for your projects just now, so only the example project is available and progress is saved in this browser. Reload to try again." : "This copy of the site has no database, so only the example project is available and progress is saved in this browser."}</p>`;
  const landing = A.projects.length ? "" : `
    <section class="landing">
      <div>
        <div class="eyebrow">Literature, gamified</div>
        <h1>Turn your reading list into a <em>game</em></h1>
        <p class="lede">Build a project for any topic, add papers by DOI or PDF, and work through them ring by ring. Set daily and weekly goals, keep your streak, ${QUIZ ? "pass quizzes on what you read, " : ""}and earn scholar points as you level up from curious reader to distinguished professor.</p>
        <ol class="steps"><li><span>Open the example project, <b>Electrocatalysis Must-Reads</b>, to see how it works.</span></li><li><span>Start your own project below: search for papers, paste DOIs or drop in PDFs.</span></li><li><span>Tick papers as you read them${QUIZ ? ", then prove it with a quiz" : " and rate how well you understood each one"}.</span></li></ol>
        <div class="cta"><a class="btn primary" href="#/p/${EX}">Open the example project</a>${signedIn() ? `<a class="btn" href="#/" data-act="jump" data-id="newproj">Start a project</a>` : ""}</div>
      </div>
      <div class="ringmap">${ringMap(EXAMPLE_PROJECT, EXAMPLE_PAPERS)}</div>
    </section>`;
  const lv = g.level, toNext = lv.next ? lv.next.xp - g.xp : 0, pct = lv.next ? Math.round(100 * (g.xp - lv.floor) / (lv.next.xp - lv.floor)) : 100;
  app.innerHTML = `${landing}
    <div class="section-title"><div><div class="eyebrow">Your progress</div><h2>Scholar dashboard</h2></div>
      <div class="goals"><label for="goal-d">Daily goal<input type="number" id="goal-d" min="1" max="50" value="${A.profile.daily_goal}"></label><label for="goal-w">Weekly goal<input type="number" id="goal-w" min="1" max="200" value="${A.profile.weekly_goal}"></label><span>papers</span></div></div>
    ${guestNote}
    <div class="grid g4">
      <div class="card level stat"><div class="eyebrow">Level ${lv.n}</div><div class="lvname">${esc(lv.name)}</div><div class="bar"><i style="width:${pct}%"></i></div><span>${g.xp} XP${lv.next ? ` · ${toNext} to ${esc(lv.next.name)}` : " · top level"}</span></div>
      <div class="card stat"><div class="eyebrow">Today</div><b>${g.today}<small> / ${g.daily}</small></b><div class="bar"><i style="width:${Math.min(100, 100 * g.today / g.daily)}%"></i></div><span>${g.today >= g.daily ? `Daily goal met · +${XP.dailyGoal} XP` : `${g.daily - g.today} to go for +${XP.dailyGoal} XP`}</span></div>
      <div class="card stat"><div class="eyebrow">This week</div><b>${g.week}<small> / ${g.weekly}</small></b><div class="bar"><i style="width:${Math.min(100, 100 * g.week / g.weekly)}%"></i></div><span>${g.week >= g.weekly ? `Weekly goal met · +${XP.weeklyGoal} XP` : `${g.weekly - g.week} to go for +${XP.weeklyGoal} XP`}</span></div>
      <div class="card stat"><div class="eyebrow">Streak</div><b>${g.streak}<small> day${g.streak === 1 ? "" : "s"}</small></b><span>Best: ${g.best} · ${g.nRead} read${QUIZ ? ` · ${g.nQuiz} quiz${g.nQuiz === 1 ? "" : "zes"} passed` : ""}</span></div>
    </div>
    <p class="note">How points work: ${XP.read} XP per paper read, ${QUIZ ? `${XP.quiz} per quiz passed, ` : ""}${XP.dailyGoal} for each day you meet your daily goal, ${XP.weeklyGoal} for each week you meet your weekly goal.</p>

    <div class="section-title"><div><div class="eyebrow">Your reading</div><h2>Projects</h2></div></div>
    <div class="grid g3">
      ${allProjects().map(projectCard).join("")}
      ${signedIn() ? `<div class="card pcard newproj"><div class="eyebrow">New project</div>
        <form id="newproj" class="stack">
          <label for="np-name">Name<input id="np-name" required maxlength="120" placeholder="e.g. Single-atom catalysis"></label>
          <label for="np-desc">Description<input id="np-desc" maxlength="500" placeholder="What is this reading list for?"></label>
          <label for="np-secs">Sections, one per line<textarea id="np-secs" rows="3" placeholder="Foundations&#10;Key papers&#10;Recent work"></textarea></label>
          ${AI ? `<label class="note" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="np-ai" style="width:auto;margin:0" checked> Have Claude suggest rings and papers from the name and description</label>` : ""}
          <button class="btn primary" type="submit">Create project</button></form></div>`
      : ""}
    </div>

    ${(() => { const bs = shownBadges(g); return `<div class="section-title"><div><div class="eyebrow">Achievements</div><h2>Badges</h2></div><span class="note">${bs.filter(b => b.earned).length} of ${bs.length} earned</span></div>
    <div class="badges">${bs.map((b, i) => `<div class="badge${b.earned ? "" : " locked"}">${BADGE_ICON(b.earned, i)}<div><b>${esc(b.name)}</b><span>${esc(b.desc)}${b.earned ? "" : ` · ${b.progress}/${b.need}`}</span></div></div>`).join("")}</div>`; })()}

    <div class="section-title"><div><div class="eyebrow">Settings</div><h2>Off-campus access</h2></div></div>
    <div class="card stack">
      <label for="proxy-prefix">Your library's proxy prefix<input id="proxy-prefix" value="${esc(proxy.prefix)}" placeholder="e.g. https://ezproxy.lib.utexas.edu/login?url="></label>
      <label class="note" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="proxy-on" style="width:auto;margin:0" ${proxy.on ? "checked" : ""} ${proxy.prefix ? "" : "disabled"}> Open PDF and SI links through my library</label>
      <p class="note">Most university libraries publish an EZproxy prefix. With it, paper links open through your library when you're off campus. Saved in this browser.</p>
    </div>`;
}

/* ---------- project ---------- */
async function renderProject(id) {
  const proj = projectById(id);
  if (!proj) { app.innerHTML = `<p><a href="#/">← All projects</a></p><p>This project doesn't exist or isn't yours.</p>`; return; }
  if (!A.papers[id]) {
    app.innerHTML = `<p class="note">Loading papers…</p>`;
    try { await loadPapers(id); } catch { app.innerHTML = `<p>Couldn't load this project. <a href="#/p/${id}" data-act="reload">Try again</a></p>`; return; }
    if (route().id !== id) return;
  }
  const papers = A.papers[id], own = isOwner(proj), v = A.view, secs = proj.sections || [];
  const nRead = papers.filter(p => A.reads.has(p.id)).length, nQuiz = papers.filter(p => A.reads.get(p.id)?.quiz_passed).length;
  const fp = (proj.meta && proj.meta.firstPass) || [];
  const match = p => (!v.star || p.essential) && (!v.hide || !A.reads.has(p.id)) &&
    (!v.q || v.q.split(/\s+/).every(w => (p.title + " " + p.authors + " " + p.journal + " " + (p.year || "") + " " + p.note + " " + p.topic).toLowerCase().includes(w)));
  const shown = papers.filter(match);
  const secOptions = sel => secs.map(s => `<option value="${esc(s.id)}"${s.id === sel ? " selected" : ""}>${esc(s.name)}</option>`).join("");

  const addPanel = own ? `<details class="panel" id="addpanel"${papers.length ? "" : " open"}><summary>Add papers</summary><div class="panel-body">
      <div class="tabs">${[["find", "Search"], ["doi", "By DOI"], ["pdf", "Upload PDFs"], ["manual", "Type it in"]].map(([k, l]) => `<button class="chip sm" data-act="tab" data-tab="${k}" aria-pressed="${v.addTab === k}">${l}</button>`).join("")}</div>
      <label for="add-sec">Add to section<select id="add-sec">${secOptions(secs[0]?.id)}</select></label>
      <div class="${v.addTab === "find" ? "" : "hidden"} stack">
        <form id="find-form" class="findrow"><input type="search" id="find-q" value="${esc(v.findQ || "")}" placeholder="Title, topic or author, e.g. cobalt phthalocyanine CO2 reduction" aria-label="Search for papers"><button class="btn primary" type="submit">Search</button></form>
        <div class="cta"><span class="note">Also search in:</span><button class="btn sm" data-act="ext" data-to="scholar">Google Scholar ↗</button><button class="btn sm" data-act="ext" data-to="consensus">Consensus ↗</button></div>
        <div id="find-results" class="results">${findResultsHtml(proj)}</div>
        <p class="note">Results come from OpenAlex, a free index of scholarly papers. Found something on Scholar or Consensus? Copy its DOI into “By DOI”.</p></div>
      <div class="${v.addTab === "doi" ? "" : "hidden"} stack"><label for="doi-box">DOIs or DOI links, one per line<textarea id="doi-box" rows="4" placeholder="10.1021/jacs.7b06765&#10;https://doi.org/10.1038/s41586-019-1760-8"></textarea></label><div><button class="btn primary" data-act="add-dois">Look up and add</button></div></div>
      <div class="${v.addTab === "pdf" ? "" : "hidden"} stack"><div class="drop" id="drop" tabindex="0" role="button">Drop PDFs here or click to choose. We read the DOI from each PDF and fill in the details.</div><input type="file" id="pdf-input" accept="application/pdf" multiple hidden><p class="note">Up to 25 MB each. Your PDFs are private to your account${QUIZ ? " and make quizzes more accurate" : ""}.</p></div>
      <form id="manual" class="${v.addTab === "manual" ? "" : "hidden"} form3">
        <label class="wide" for="m-title">Title<input id="m-title" required maxlength="500"></label>
        <label for="m-auth">Authors<input id="m-auth" maxlength="1000"></label><label for="m-jour">Journal<input id="m-jour" maxlength="200"></label><label for="m-year">Year<input id="m-year" type="number" min="1600" max="2200"></label>
        <label for="m-doi">DOI<input id="m-doi" maxlength="200"></label><label for="m-topic">Topic<input id="m-topic" maxlength="200"></label><label for="m-ess" style="display:flex;gap:8px;align-items:center;margin-top:20px"><input type="checkbox" id="m-ess" style="width:auto;margin:0"> Essential ★</label>
        <label class="wide" for="m-note">Why read it<input id="m-note" maxlength="1000"></label>
        <div class="wide"><button class="btn primary" type="submit">Add paper</button></div></form>
      <div class="joblist" id="jobs" role="status"></div></div></details>` : "";

  const editPanel = own ? `<details class="panel" id="editpanel"><summary>Edit project</summary><div class="panel-body">
      <label for="e-name">Name<input id="e-name" value="${esc(proj.name)}" maxlength="120"></label>
      <label for="e-desc">Description<textarea id="e-desc" rows="2" maxlength="2000">${esc(proj.description)}</textarea></label>
      <div class="eyebrow">Sections (inner ring first)</div>
      ${secs.map((s, i) => { const n = papers.filter(p => p.section === s.id).length; return `<div class="secrow"><input data-sec="${esc(s.id)}" value="${esc(s.name)}" maxlength="80" aria-label="Section name"><button class="btn sm" data-act="sec-up" data-i="${i}" ${i ? "" : "disabled"} aria-label="Move up">↑</button><button class="btn sm" data-act="sec-down" data-i="${i}" ${i < secs.length - 1 ? "" : "disabled"} aria-label="Move down">↓</button><button class="btn sm" data-act="sec-del" data-i="${i}" ${n || secs.length === 1 ? `disabled title="${n ? "Move or delete its papers first" : "A project needs one section"}"` : ""}>Delete</button></div>`; }).join("")}
      <div><button class="btn sm" data-act="sec-add">Add section</button></div>
      <div class="cta" style="margin-top:4px"><button class="btn primary" data-act="save-proj">Save changes</button>
      ${v.confirm === "delproj" ? `<span class="note">Delete this project and all its papers?</span><button class="btn danger" data-act="del-proj-yes">Delete project</button><button class="btn" data-act="cancel">Cancel</button>` : `<button class="linkbtn" data-act="del-proj">Delete project</button>`}</div></div></details>` : "";

  const banner = proj.is_template ? `<div class="banner"><span>This is the example project. Read along and track your progress here, or make your own copy to add, move and remove papers.</span>${signedIn() ? `<button class="btn primary" data-act="copy-ex">Make my own copy</button>` : ""}</div>` : "";
  const firstPass = fp.length ? `<div class="card firstpass"><div class="eyebrow">Start here</div><h3>First pass, in order</h3><ol>${fp.map(pid => { const p = papers.find(x => x.id === pid); return p ? `<li${A.reads.has(p.id) ? ' class="done"' : ""}><a href="#p-${p.id}" data-act="jump" data-id="p-${p.id}">${esc(p.title)}</a></li>` : ""; }).join("")}</ol></div>` : "";

  let body = "";
  secs.forEach((s, i) => {
    const items = shown.filter(p => p.section === s.id);
    const topics = [...new Set(papers.filter(p => p.section === s.id).map(p => p.topic || ""))];
    const dark = i * 5 / Math.max(1, secs.length - 1) < 2.5;
    body += `<section class="ring" id="sec-${esc(s.id)}"><div class="ring-head"><div class="ring-dot" style="background:var(--r${Math.min(5, Math.round(i * 5 / Math.max(1, secs.length - 1)))});color:${dark ? "var(--bg)" : "var(--ink)"}">${ROMAN[i] || i + 1}</div>
      <div>${s.sub ? `<div class="eyebrow">${esc(s.sub)}</div>` : ""}<h2>${esc(s.name)}</h2>${s.blurb ? `<p>${esc(s.blurb)}</p>` : ""}</div></div>`;
    if (!items.length) body += `<div class="empty">${papers.some(p => p.section === s.id) ? "No papers here match the current filters." : own ? "No papers in this section yet. Add some with “Add papers” above." : "No papers in this section."}</div>`;
    for (const t of topics) {
      const gi = items.filter(p => (p.topic || "") === t).sort((a, b) => (b.essential - a.essential) || (a.year || 0) - (b.year || 0));
      if (gi.length) body += `<div class="group">${t ? `<h3>${esc(t)}</h3>` : ""}${gi.map(p => paperRow(p, proj, own, secOptions)).join("")}</div>`;
    }
    body += `</section>`;
  });

  app.innerHTML = `<p class="crumb"><a href="#/">← All projects</a></p>
    <div class="phead"><div>${proj.is_template ? '<span class="tag example">EXAMPLE PROJECT</span>' : '<span class="tag mine">MY PROJECT</span>'}<h1>${esc(proj.name)}</h1>${proj.description ? `<p class="lede">${esc(proj.description)}</p>` : ""}
      <div class="pstats"><div class="stat"><b>${nRead}<small> / ${papers.length}</small></b><span>papers read</span></div>${QUIZ ? `<div class="stat"><b>${nQuiz}</b><span>quizzes passed</span></div>` : ""}<div class="stat"><b>${papers.filter(p => p.essential).length}</b><span>★ essentials</span></div></div></div>
      <div class="ringmap">${ringMap(proj, papers)}</div></div>
    ${banner}
    ${own && AI ? `<div class="banner ai"><span><b>Build rings with Claude.</b> ${papers.length >= 3 ? "Sort the papers you have into rings, or add rings and papers for a topic." : "Describe a topic and Claude will suggest rings and real papers to start with."}</span><button class="btn primary" data-act="ai-rings">✦ Build rings</button></div>` : ""}
    <div class="tools">${firstPass}${addPanel}${editPanel}</div>
    <div class="controls"><input type="search" id="q" value="${esc(v.q)}" placeholder="Search this project…" aria-label="Search this project">
      <button class="chip" data-act="star" aria-pressed="${v.star}">★ Essentials only</button><button class="chip" data-act="hide" aria-pressed="${v.hide}">Hide read</button>
      <span class="shown">${shown.length} of ${papers.length} shown</span></div>
    ${papers.length ? body : `<div class="empty">This project has no papers yet. ${own ? "Add some with “Add papers” above." : ""}</div>`}`;
  wireProject(proj);
}

function paperRow(p, proj, own, secOptions) {
  const r = A.reads.get(p.id), L = linkSet({ d: p.doi, t: p.title, y: p.year, j: p.journal }), v = A.view;
  const confirm = v.confirm === "del-" + p.id;
  const conf = r ? r.confidence : null, chip = (val, l) => `<button class="chip sm" data-act="conf" data-id="${p.id}" data-v="${val}" aria-pressed="${conf === val}">${l}</button>`;
  let quiz = "";
  if (!QUIZ) quiz = "";
  else if (r && conf === "high") {
    if (!sb) quiz = `<span class="note">Quizzes need an account on a configured site.</span>`;
    else if (!signedIn()) quiz = "";
    else if (r.quiz_passed) quiz = `<span class="passed">Quiz passed · best ${r.quiz_best}/${r.quiz_n}</span><button class="btn sm" data-act="quiz" data-id="${p.id}" data-fresh="1">Retake</button>`;
    else quiz = `<button class="btn sm primary" data-act="quiz" data-id="${p.id}">${r.quiz_attempts ? `Try again (best ${r.quiz_best}/${r.quiz_n})` : `Take the quiz · +${XP.quiz} XP`}</button>`;
  } else if (r && conf) quiz = `<span class="note">Mark yourself confident when you're ready for the quiz.</span>`;
  return `<article class="paper${r ? " read" : ""}" id="p-${p.id}">
    <input type="checkbox" data-act="read" data-id="${p.id}" ${r ? "checked" : ""} aria-label="Mark as read: ${esc(p.title)}">
    <div style="min-width:0">
      <a class="ptitle" href="${esc(via(L.page, !p.doi))}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <div class="meta">${p.essential ? '<span class="star" title="Essential">★</span>' : ""}${p.authors ? `<span>${esc(p.authors)}</span>` : ""}<span>${esc(p.journal)} ${p.year || ""}</span></div>
      ${p.note ? `<p class="why">${esc(p.note)}</p>` : ""}
      <div class="links">
        ${p.pdf_path ? `<button class="btn sm primary" data-act="mypdf" data-id="${p.id}">Your PDF</button>` : ""}
        <a class="btn sm${p.pdf_path ? "" : " primary"}" href="${esc(via(L.paper.href, L.paper.ext))}" target="_blank" rel="noopener">${L.paper.label}</a>
        ${L.si ? `<a class="btn sm" href="${esc(via(L.si.href))}" target="_blank" rel="noopener">${L.si.label}</a>` : `<span class="btn sm off" title="${esc(L.siNote)}">No SI link</span>`}
        ${p.doi ? `<span class="doi">doi:${esc(p.doi)}</span>` : `<span class="doi">no DOI</span>`}
        <span class="spacer"></span>
        ${own ? (confirm ? `<span class="note">Delete this paper?</span><button class="btn sm danger" data-act="del-yes" data-id="${p.id}">Delete</button><button class="btn sm" data-act="cancel">Cancel</button>`
          : `${p.pdf_path ? "" : `<button class="linkbtn" data-act="attach" data-id="${p.id}">Attach PDF</button>`}<select class="movesel" data-act="move" data-id="${p.id}" aria-label="Move to section">${secOptions(p.section)}</select><button class="linkbtn" data-act="del" data-id="${p.id}">Delete</button>`) : ""}
      </div>
      ${r ? `<div class="study"><span class="note">How well do you understand it?</span>${chip("low", "Still fuzzy")}${chip("mid", "Mostly")}${chip("high", "Confident")}${quiz}</div>` : ""}
    </div></article>`;
}

/* ============ project actions ============ */
function wireProject(proj) {
  const q = $("q");
  if (q) q.addEventListener("input", e => { A.view.q = e.target.value.trim().toLowerCase(); const pos = q.selectionStart; render(); const n = $("q"); n.focus(); n.setSelectionRange(pos, pos); });
  const manual = $("manual");
  if (manual) manual.addEventListener("submit", async e => {
    e.preventDefault(); const g = id => $(id).value.trim();
    await addPaper(proj, { title: g("m-title"), authors: g("m-auth"), journal: g("m-jour"), year: parseInt(g("m-year"), 10) || null, doi: cleanDoi(g("m-doi")) || null, topic: g("m-topic"), note: g("m-note"), essential: $("m-ess").checked });
  });
  const drop = $("drop"), input = $("pdf-input");
  if (drop && input) {
    drop.onclick = () => input.click();
    drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); uploadPdfs(proj, [...e.dataTransfer.files]); };
    input.onchange = () => uploadPdfs(proj, [...input.files]);
  }
}
function job(text) { const el = $("jobs"); if (!el) return { set() {} }; const d = document.createElement("div"); d.textContent = text; el.prepend(d); return { set(t) { d.textContent = t; } }; }
const addSection = () => ($("add-sec") && $("add-sec").value) || "s1";

async function addPaper(proj, f, quiet) {
  if (!f.title) return null;
  const papers = A.papers[proj.id];
  const row = { project_id: proj.id, owner: A.session.user.id, title: f.title.slice(0, 500), authors: (f.authors || "").slice(0, 1000), journal: (f.journal || "").slice(0, 200),
    year: f.year || null, doi: f.doi || null, section: f.section || addSection(), topic: (f.topic || "").slice(0, 200), note: (f.note || "").slice(0, 1000), essential: !!f.essential,
    pdf_path: f.pdf_path || null, position: papers.length };
  const { data, error } = await sb.from("papers").insert(row).select().single();
  if (error) { toast(esc(error.message || "Couldn't add that paper.")); return null; }
  papers.push(data); A.index.set(data.id, { project_id: proj.id, section: data.section });
  if (!quiet) { toast(`Added <b>${esc(data.title.slice(0, 60))}</b>`); render(); }
  return data;
}
async function crossrefLookup(doi) {
  const r = await fetch("https://api.crossref.org/works/" + encodeURIComponent(doi));
  if (!r.ok) return null;
  const m = (await r.json()).message || {};
  const au = (m.author || []).map(a => a.family || a.name).filter(Boolean);
  return { title: (m.title || [])[0] || "", authors: au.length > 4 ? au.slice(0, 3).join(", ") + " et al." : au.join(", "),
    journal: (m["short-container-title"] || [])[0] || (m["container-title"] || [])[0] || "", year: ((m.issued || {})["date-parts"] || [[null]])[0][0] || null, doi: m.DOI || doi };
}
async function addDois(proj) {
  const box = $("doi-box"); const dois = [...new Set((box.value.match(/10\.\d{4,9}\/[^\s"<>,;]+/g) || []).map(d => d.replace(/[.)\]]+$/, "")))];
  if (!dois.length) { toast("Paste at least one DOI, like 10.1021/jacs.7b06765."); return; }
  const section = addSection(); box.value = "";
  const existing = new Set(A.papers[proj.id].map(p => (p.doi || "").toLowerCase()));
  for (const doi of dois) {
    const j = job(`Looking up ${doi}…`);
    if (existing.has(doi.toLowerCase())) { j.set(`Already in this project: ${doi}`); continue; }
    try {
      const m = await crossrefLookup(doi);
      if (!m || !m.title) { j.set(`Couldn't find ${doi}. Check it, or add it with “Type it in”.`); continue; }
      const added = await addPaper(proj, { ...m, section }, true);
      j.set(added ? `Added: ${m.title}` : `Couldn't add ${doi}.`);
    } catch { j.set(`Couldn't reach Crossref for ${doi}. Try again in a moment.`); }
  }
  render();
}
async function uploadOne(proj, file, paper) {
  const uid = A.session.user.id;
  const path = `${uid}/${paper.id}.pdf`;
  const { error } = await sb.storage.from("pdfs").upload(path, file, { contentType: "application/pdf", upsert: true });
  if (error) throw error;
  await sb.from("papers").update({ pdf_path: path }).eq("id", paper.id);
  paper.pdf_path = path;
  // read the DOI from the PDF and fill in details we don't have yet
  const res = await api("/api/pdf-meta", { paperId: paper.id }).catch(() => null);
  const m = res && res.ok ? res.data : null;
  if (m && (m.title || m.doi)) {
    const upd = {};
    const fromFile = paper.title === file.name.replace(/\.pdf$/i, "").slice(0, 500);
    if (m.title && fromFile) upd.title = m.title.slice(0, 500);
    if (m.authors && !paper.authors) upd.authors = m.authors;
    if (m.journal && !paper.journal) upd.journal = m.journal;
    if (m.year && !paper.year) upd.year = m.year;
    if (m.doi && !paper.doi) upd.doi = m.doi;
    if (Object.keys(upd).length) { await sb.from("papers").update(upd).eq("id", paper.id); Object.assign(paper, upd); }
  }
  return paper;
}
async function uploadPdfs(proj, files) {
  const pdfs = files.filter(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast("Choose PDF files."); return; }
  const section = addSection();
  for (const f of pdfs) {
    const j = job(`Uploading ${f.name}…`);
    if (f.size > 25 * 1024 * 1024) { j.set(`${f.name} is over 25 MB.`); continue; }
    const paper = await addPaper(proj, { title: f.name.replace(/\.pdf$/i, ""), section }, true);
    if (!paper) { j.set(`Couldn't add ${f.name}.`); continue; }
    try { await uploadOne(proj, f, paper); j.set(`Added: ${paper.title}${paper.doi ? "" : " (no DOI found; edit the details if needed)"}`); }
    catch { j.set(`${f.name} was added, but the upload failed. Use “Attach PDF” on it to try again.`); }
  }
  render();
}
async function copyExample() {
  const uid = A.session.user.id;
  const { data: proj, error } = await sb.from("projects").insert({ owner: uid, name: EXAMPLE_PROJECT.name + " (my copy)", description: EXAMPLE_PROJECT.description, sections: EXAMPLE_PROJECT.sections }).select().single();
  if (error) { toast(esc(error.message)); return; }
  const rows = EXAMPLE_PAPERS.map(p => ({ project_id: proj.id, owner: uid, title: p.title, authors: p.authors, journal: p.journal, year: p.year, doi: p.doi, section: p.section, topic: p.topic, note: p.note, essential: p.essential, position: p.position }));
  for (let i = 0; i < rows.length; i += 100) {
    const { error: e2 } = await sb.from("papers").insert(rows.slice(i, i + 100));
    if (e2) { toast("Your copy was created but some papers didn't copy. Open it and try adding them again."); break; }
  }
  A.projects.push(proj); delete A.papers[proj.id];
  toast("Made your own copy. Papers you read in the example aren't carried over, since the copy has its own papers.");
  location.hash = "#/p/" + proj.id;
}

/* ============ finding papers (OpenAlex, plus links out to Scholar and Consensus) ============ */
const normTitle = t => String(t || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function inProject(proj, w) {
  const ps = A.papers[proj.id] || [];
  return ps.some(p => (w.doi && p.doi && p.doi.toLowerCase() === w.doi.toLowerCase()) || normTitle(p.title) === normTitle(w.title));
}
function findResultsHtml(proj) {
  const f = A.view.find;
  if (!f) return "";
  if (f.loading) return `<p class="note">Searching…</p>`;
  if (f.error) return `<p class="note">${esc(f.error)}</p>`;
  if (!f.items.length) return `<p class="note">No papers found. Try fewer or different words.</p>`;
  return f.items.map((w, i) => {
    const have = inProject(proj, w);
    return `<div class="result"><div style="min-width:0"><div class="rtitle">${esc(w.title)}</div><div class="meta"><span>${esc(w.authors)}</span><span>${esc(w.journal)} ${w.year || ""}</span>${w.cites ? `<span>${w.cites.toLocaleString()} citations</span>` : ""}${w.doi ? `<span class="doi">doi:${esc(w.doi)}</span>` : ""}</div></div>
      ${have ? `<span class="note">In project</span>` : `<button class="btn sm" data-act="find-add" data-i="${i}">Add</button>`}</div>`;
  }).join("");
}
async function findPapers(q) {
  A.view.findQ = q;
  if (q.length < 3) { toast("Type a few words to search."); return; }
  A.view.find = { loading: true, items: [] }; drawFind();
  try {
    const u = new URL("https://api.openalex.org/works");
    u.searchParams.set("search", q.slice(0, 250)); u.searchParams.set("per-page", "15");
    u.searchParams.set("select", "doi,title,publication_year,authorships,primary_location,cited_by_count");
    const r = await fetch(u); if (!r.ok) throw new Error();
    const items = ((await r.json()).results || []).filter(w => w.title).map(w => {
      const au = (w.authorships || []).map(a => (a.author && a.author.display_name || "").split(" ").pop()).filter(Boolean);
      return { title: w.title.replace(/<[^>]+>/g, ""), year: w.publication_year || null, doi: (w.doi || "").replace(/^https?:\/\/doi\.org\//i, "") || null,
        journal: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || "",
        authors: au.length > 4 ? au.slice(0, 3).join(", ") + " et al." : au.join(", "), cites: w.cited_by_count || 0 };
    });
    const seen = new Set();
    A.view.find = { items: items.filter(w => { const k = normTitle(w.title); if (seen.has(k)) return false; seen.add(k); return true; }) };
  } catch { A.view.find = { error: "Couldn't reach the paper index. Try again in a moment.", items: [] }; }
  drawFind();
}
function drawFind() { const el = $("find-results"), proj = projectById(route().id); if (el && proj) el.innerHTML = findResultsHtml(proj); }
async function addFound(proj, i, btn) {
  const w = A.view.find && A.view.find.items[i]; if (!w) return;
  btn.disabled = true; btn.textContent = "Adding…";
  const added = await addPaper(proj, { title: w.title, authors: w.authors, journal: w.journal, year: w.year, doi: w.doi }, true);
  if (added) toast(`Added <b>${esc(w.title.slice(0, 60))}</b>`);
  render();
}

/* ============ building rings with Claude ============ */
const rdlg = $("rings");
let ringsToken = 0;
$("rings-close").onclick = () => { ringsToken++; rdlg.close(); };
rdlg.addEventListener("close", () => { ringsToken++; });
function openRings(proj, mode, topic, autorun) {
  const n = (A.papers[proj.id] || []).length;
  if (mode === "organize" && n < 3) mode = "topic";
  $("rings-title").textContent = proj.name;
  const body = $("rings-body");
  body.innerHTML = `<div class="tabs"><button class="chip sm" data-rmode="organize" aria-pressed="${mode === "organize"}" ${n >= 3 ? "" : "disabled title=\"Add at least 3 papers first\""}>Sort my ${n} papers</button><button class="chip sm" data-rmode="topic" aria-pressed="${mode === "topic"}">Start from a topic</button></div>
    <div id="r-topic" class="stack ${mode === "topic" ? "" : "hidden"}">
      <label for="r-topic-in">Topic<textarea id="r-topic-in" rows="3" maxlength="1500" placeholder="e.g. Electrochemical CO2 reduction to methanol on molecular catalysts">${esc(topic || "")}</textarea></label>
      <label for="r-level">Who's reading (optional)<input id="r-level" maxlength="200" placeholder="e.g. first-year PhD student in catalysis"></label>
      <p class="note">Claude suggests rings and papers. Each paper is then looked up in OpenAlex and Crossref, and any that can't be found are dropped.</p></div>
    <p id="r-org" class="note ${mode === "organize" ? "" : "hidden"}">Claude will group your papers into rings from foundations to frontier, label topics, star the essentials and pick a first pass. You'll see a preview before anything changes.</p>
    <div class="cta"><button class="btn primary" id="r-go">Build rings</button></div>
    <div id="r-out" role="status"></div>`;
  rdlg.dataset.mode = mode;
  body.querySelectorAll("[data-rmode]").forEach(c => c.onclick = () => {
    rdlg.dataset.mode = c.dataset.rmode;
    body.querySelectorAll("[data-rmode]").forEach(x => x.setAttribute("aria-pressed", x === c));
    $("r-topic").classList.toggle("hidden", c.dataset.rmode !== "topic"); $("r-org").classList.toggle("hidden", c.dataset.rmode !== "organize");
    $("r-out").innerHTML = "";
  });
  $("r-go").onclick = () => runRings(proj);
  if (!rdlg.open) rdlg.showModal();
  if (autorun && (topic || "").length >= 3) runRings(proj);
}
async function runRings(proj) {
  const my = ++ringsToken, mode = rdlg.dataset.mode, out = $("r-out"), go = $("r-go");
  const topic = mode === "topic" ? $("r-topic-in").value.trim() : "";
  if (mode === "topic" && topic.length < 3) { out.innerHTML = `<p class="note">Describe the topic in a few words.</p>`; return; }
  go.disabled = true;
  out.innerHTML = `<p class="note">Claude is working on it. ${mode === "topic" ? "Building rings and checking every paper takes a minute or two." : "This takes up to a minute."}</p>`;
  let res;
  try { res = await api("/api/rings", { projectId: proj.id, mode, topic, level: mode === "topic" ? $("r-level").value.trim() : "" }); } catch { res = { ok: false, status: 0, data: {} }; }
  if (my !== ringsToken) return;
  go.disabled = false;
  const d = res.data || {};
  if (res.status === 401) { out.innerHTML = `<p>Your session expired. Reload the page and try again.</p>`; return; }
  if (res.status === 429) { out.innerHTML = `<p>${d.reason === "global" ? "The site has reached today's limit for Claude requests. Please try again tomorrow." : "You've used today's Claude requests. They reset tomorrow."}</p>`; return; }
  if (!res.ok) { out.innerHTML = `<p>${esc(d.error || "Couldn't build rings this time.")}</p>`; return; }
  rdlg._preview = d;
  out.innerHTML = mode === "organize" ? previewOrganize(proj, d) : previewTopic(proj, d);
  const apply = $("r-apply"); if (apply) apply.onclick = () => applyRings(proj, d, apply);
}
function previewOrganize(proj, d) {
  const ps = A.papers[proj.id] || [], byId = new Map(ps.map(p => [p.id, p]));
  return `<div class="rprev">${d.rings.map((r, i) => {
    const items = d.assign.filter(a => a.ring === i);
    return `<div class="rring"><div class="eyebrow">Ring ${ROMAN[i] || i + 1} · ${items.length} paper${items.length === 1 ? "" : "s"}</div><h4>${esc(r.name)}</h4>${r.sub ? `<p class="note">${esc(r.sub)}</p>` : ""}
      <ul>${items.slice(0, 5).map(a => `<li>${a.essential ? "★ " : ""}${esc((byId.get(a.id) || {}).title || "")}</li>`).join("")}${items.length > 5 ? `<li class="note">and ${items.length - 5} more</li>` : ""}</ul></div>`;
  }).join("")}</div>
  ${d.firstPass && d.firstPass.length ? `<p class="note">First pass: ${d.firstPass.length} paper${d.firstPass.length === 1 ? "" : "s"} in reading order.</p>` : ""}
  <div class="cta"><button class="btn primary" id="r-apply">Use these rings</button><span class="note">Replaces this project's sections, topics and stars. Your reading progress is kept.</span></div>`;
}
function previewTopic(proj, d) {
  const n = (A.papers[proj.id] || []).length;
  if (!d.rings.length) return `<p>None of Claude's suggestions could be found in OpenAlex or Crossref, so nothing was added. Try a more specific topic.</p>`;
  return `<p class="note">${d.verified} of ${d.suggested} suggested papers were found in OpenAlex or Crossref and are shown with their real details. ${d.suggested - d.verified ? `${d.suggested - d.verified} couldn't be found and were dropped.` : ""} Untick any you don't want.</p>
  <div class="rprev">${d.rings.map((r, i) => `<div class="rring"><div class="eyebrow">Ring ${ROMAN[i] || i + 1}</div><h4>${esc(r.name)}</h4>${r.blurb ? `<p class="note">${esc(r.blurb)}</p>` : ""}
    ${r.papers.map((p, j) => `<label class="rpaper"><input type="checkbox" data-rp="${i}-${j}" checked><span><b>${p.essential ? "★ " : ""}${esc(p.title)}</b><span class="meta"><span>${esc(p.authors)}</span><span>${esc(p.journal)} ${p.year || ""}</span></span>${p.note ? `<span class="why">${esc(p.note)}</span>` : ""}</span></label>`).join("")}</div>`).join("")}</div>
  <div class="cta"><button class="btn primary" id="r-apply">Add to project</button><span class="note">${n ? "Adds these as new rings after your current ones." : "Sets up this project's rings."}</span></div>`;
}
async function applyRings(proj, d, btn) {
  btn.disabled = true; btn.textContent = "Saving…";
  const uid = A.session.user.id, stamp = Date.now().toString(36);
  const newSecs = d.rings.map((r, i) => ({ id: `r${stamp}${i}`, name: r.name, sub: r.sub || "", blurb: r.blurb || "" }));
  try {
    if (d.mode === "organize") {
      const ps = A.papers[proj.id] || [], byId = new Map(ps.map(p => [p.id, p]));
      const rows = d.assign.filter(a => byId.has(a.id)).map(a => ({ ...byId.get(a.id), section: newSecs[a.ring].id, topic: a.topic || "", essential: !!a.essential }));
      for (let i = 0; i < rows.length; i += 100) {
        const { error } = await sb.from("papers").upsert(rows.slice(i, i + 100), { onConflict: "id" });
        if (error) throw error;
      }
      const meta = { ...(proj.meta || {}), firstPass: d.firstPass || [] };
      const { error } = await sb.from("projects").update({ sections: newSecs, meta, updated_at: new Date().toISOString() }).eq("id", proj.id);
      if (error) throw error;
      proj.sections = newSecs; proj.meta = meta;
    } else {
      const picked = new Set([...$("r-out").querySelectorAll("input[data-rp]:checked")].map(x => x.dataset.rp));
      const ps = A.papers[proj.id] || [];
      const keep = newSecs.map((s, i) => ({ s, papers: d.rings[i].papers.filter((p, j) => picked.has(`${i}-${j}`) && !inProject(proj, p)) })).filter(x => x.papers.length);
      if (!keep.length) { btn.disabled = false; btn.textContent = "Add to project"; toast("Nothing new to add."); return; }
      const sections = ps.length ? [...(proj.sections || []), ...keep.map(x => x.s)] : keep.map(x => x.s);
      const { error } = await sb.from("projects").update({ sections, updated_at: new Date().toISOString() }).eq("id", proj.id);
      if (error) throw error;
      proj.sections = sections;
      let pos = ps.length;
      const rows = keep.flatMap(x => x.papers.map(p => ({ project_id: proj.id, owner: uid, title: p.title, authors: p.authors || "", journal: p.journal || "", year: p.year || null, doi: p.doi || null,
        section: x.s.id, topic: p.topic || "", note: p.note || "", essential: !!p.essential, position: pos++ })));
      const { error: e2 } = await sb.from("papers").insert(rows);
      if (e2) throw e2;
    }
    delete A.papers[proj.id]; await loadPapers(proj.id);
    rdlg.close(); regame(false); render();
    toast(d.mode === "organize" ? "Your project now has new rings." : "Added the new rings and papers.");
  } catch (e) {
    btn.disabled = false; btn.textContent = "Try saving again";
    toast(esc((e && e.message) || "Couldn't save the rings."));
  }
}

/* ============ server calls ============ */
async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + A.session.access_token }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

/* ============ quiz ============ */
const dlg = $("quiz");
let quizToken = 0;
$("quiz-close").onclick = () => { quizToken++; dlg.close(); };
dlg.addEventListener("close", () => { quizToken++; });
async function openQuiz(paper, fresh, exclude) {
  const my = ++quizToken;
  $("quiz-title").textContent = paper.title; $("quiz-kind").textContent = "Quiz";
  if (!dlg.open) dlg.showModal();
  const body = $("quiz-body");
  body.innerHTML = `<p class="note">Getting 5 questions${paper.pdf_path ? " from your PDF" : ""}. A brand-new quiz can take up to a minute.</p>`;
  let res;
  try { res = await api("/api/quiz", { paperId: paper.id, fresh: !!fresh, exclude: exclude || null }); } catch { res = { ok: false, status: 0, data: {} }; }
  if (my !== quizToken) return;
  const d = res.data || {};
  if (res.status === 401) { body.innerHTML = `<p>Your session expired. Reload the page and try again.</p>`; return; }
  if (res.status === 429) { body.innerHTML = `<p>${d.reason === "global" ? "The site has reached today's limit for new quizzes. Please try again tomorrow." : "You've reached today's limit for new quizzes. Quizzes that already exist still work; new ones unlock tomorrow."}</p>`; return; }
  if (d.unknown) { body.innerHTML = `<p>Claude doesn't know this paper well enough to quiz you fairly.${paper.pdf_path ? "" : " Attach the PDF and try again: quizzes from your PDF work for any paper."}</p>`; return; }
  const qs = d.questions || [];
  if (!res.ok || qs.length < 3) { body.innerHTML = `<p>The quiz couldn't be loaded this time.</p><button class="btn primary" id="quiz-retry">Try again</button>`; $("quiz-retry").onclick = () => openQuiz(paper, fresh, exclude); return; }
  $("quiz-kind").textContent = d.source === "pdf" ? "Quiz · from your PDF" : "Quiz";
  body.innerHTML = `<form id="quiz-form"><p class="note">Answer all ${qs.length}. Pass with ${Math.ceil(qs.length * 0.8)} or more correct to earn ${XP.quiz} XP.</p>` +
    qs.map((q, i) => `<fieldset class="qq" id="qq${i}"><legend>${i + 1}. ${esc(q.q)}</legend>${q.options.map((o, j) => `<label><input type="radio" name="q${i}" value="${j}" required> ${esc(o)}</label>`).join("")}<p class="explain" hidden></p></fieldset>`).join("") +
    `<div class="qactions"><button class="btn primary" type="submit">Check answers</button></div></form>`;
  $("quiz-form").onsubmit = async ev => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Checking…";
    const answers = qs.map((_, i) => Number((ev.target.querySelector(`input[name="q${i}"]:checked`) || {}).value));
    let g; try { g = await api("/api/quiz-check", { quizId: d.quizId, answers }); } catch { g = { ok: false, data: {} }; }
    if (my !== quizToken) return;
    if (!g.ok) { btn.disabled = false; btn.textContent = "Check answers"; toast(g.status === 409 ? "Mark the paper as read first." : "Couldn't check your answers. Try again."); return; }
    const res2 = g.data;
    qs.forEach((q, i) => {
      const ok = answers[i] === res2.correct[i], fs = $("qq" + i); fs.classList.add(ok ? "right" : "wrong");
      fs.querySelectorAll("input").forEach(inp => { inp.disabled = true; if (Number(inp.value) === res2.correct[i]) inp.parentElement.classList.add("correct"); });
      const ex = fs.querySelector(".explain"); ex.hidden = false; ex.textContent = (ok ? "Correct. " : "Not quite. ") + (res2.explain[i] || "");
    });
    const r = A.reads.get(paper.id);
    if (r) Object.assign(r, { quiz_best: Math.max(r.quiz_best || 0, res2.score), quiz_n: res2.n, quiz_passed: r.quiz_passed || res2.passed, quiz_attempts: (r.quiz_attempts || 0) + 1 });
    regame(); render();
    ev.target.querySelector(".qactions").innerHTML = `<p class="${res2.passed ? "passed" : "note"}">${res2.score}/${res2.n} correct. ${res2.passed ? (res2.newlyPassed ? `Passed! +${XP.quiz} XP.` : "Passed again.") : `You need ${res2.need} to pass. Reread the parts you missed and try again.`}</p><button class="btn" type="button" id="quiz-new">Different questions</button><button class="btn primary" type="button" id="quiz-done">Done</button>`;
    $("quiz-new").onclick = () => openQuiz(paper, true, d.quizId);
    $("quiz-done").onclick = () => dlg.close();
  };
}

/* ============ events ============ */
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id, proj = projectById(route().id);
  const paper = id && proj && A.papers[proj.id] ? A.papers[proj.id].find(p => p.id === id) : null;
  if (act === "read" || act === "move") return; // handled on change
  if (act === "jump") { e.preventDefault(); const el = $(b.dataset.id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  if (act === "conf" && paper) return setConfidence(paper, b.dataset.v);
  if (act === "quiz" && paper && QUIZ) return openQuiz(paper, !!b.dataset.fresh);
  if (act === "star" || act === "hide") { A.view[act] = !A.view[act]; return render(); }
  if (act === "tab") { A.view.addTab = b.dataset.tab; return render(); }
  if (act === "cancel") { A.view.confirm = null; return render(); }
  if (act === "copy-ex") { b.disabled = true; b.textContent = "Copying…"; return copyExample(); }
  if (act === "mypdf" && paper) {
    const w = window.open("", "_blank");
    const { data, error } = await sb.storage.from("pdfs").createSignedUrl(paper.pdf_path, 3600);
    if (error || !data) { if (w) w.close(); toast("Couldn't open your PDF."); return; }
    if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
    return;
  }
  if (act === "attach" && paper) {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/pdf";
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; toast("Uploading…"); try { await uploadOne(proj, f, paper); toast("PDF attached."); } catch { toast("Upload failed. Try again."); } render(); };
    inp.click(); return;
  }
  if (act === "add-dois") return addDois(proj);
  if (act === "ext") { const q = ($("find-q") && $("find-q").value.trim()) || ""; window.open((b.dataset.to === "scholar" ? "https://scholar.google.com/scholar?q=" : "https://consensus.app/results/?q=") + encodeURIComponent(q), "_blank", "noopener"); return; }
  if (act === "find-add" && proj) return addFound(proj, Number(b.dataset.i), b);
  if (act === "ai-rings" && proj) return openRings(proj, (A.papers[proj.id] || []).length >= 3 ? "organize" : "topic", [proj.name, proj.description].filter(Boolean).join(". "), false);
  if (act === "del") { A.view.confirm = "del-" + id; return render(); }
  if (act === "del-yes" && paper) {
    A.view.confirm = null;
    const { error } = await sb.from("papers").delete().eq("id", paper.id);
    if (error) { toast("Couldn't delete it."); return; }
    if (paper.pdf_path) await sb.storage.from("pdfs").remove([paper.pdf_path]);
    A.papers[proj.id] = A.papers[proj.id].filter(p => p.id !== paper.id); A.index.delete(paper.id); A.reads.delete(paper.id);
    regame(false); return render();
  }
  if (proj && isOwner(proj) && act.startsWith("sec-")) {
    const secs = readSections(proj), i = Number(b.dataset.i);
    if (act === "sec-up" && i > 0) [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]];
    if (act === "sec-down" && i < secs.length - 1) [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]];
    if (act === "sec-del") secs.splice(i, 1);
    if (act === "sec-add") secs.push({ id: "s" + Date.now().toString(36), name: "New section" });
    proj.sections = secs; render(); $("editpanel").open = true; return;
  }
  if (act === "save-proj" && proj) {
    const upd = { name: $("e-name").value.trim() || proj.name, description: $("e-desc").value.trim(), sections: readSections(proj), updated_at: new Date().toISOString() };
    const { error } = await sb.from("projects").update(upd).eq("id", proj.id);
    if (error) { toast(esc(error.message)); return; }
    Object.assign(proj, upd); toast("Project saved."); return render();
  }
  if (act === "del-proj") { A.view.confirm = "delproj"; render(); $("editpanel").open = true; return; }
  if (act === "del-proj-yes" && proj) {
    const pdfs = (A.papers[proj.id] || []).filter(p => p.pdf_path).map(p => p.pdf_path);
    const { error } = await sb.from("projects").delete().eq("id", proj.id);
    if (error) { toast("Couldn't delete the project."); return; }
    if (pdfs.length) await sb.storage.from("pdfs").remove(pdfs);
    for (const p of A.papers[proj.id] || []) { A.index.delete(p.id); A.reads.delete(p.id); }
    A.projects = A.projects.filter(p => p.id !== proj.id); delete A.papers[proj.id]; A.view.confirm = null;
    regame(false); toast("Project deleted."); location.hash = "#/";
  }
});
function readSections(proj) {
  return (proj.sections || []).map(s => { const inp = document.querySelector(`input[data-sec="${CSS.escape(s.id)}"]`); return { ...s, name: (inp ? inp.value.trim() : s.name) || s.name }; });
}
document.addEventListener("change", async e => {
  const t = e.target, proj = projectById(route().id);
  if (t.dataset.act === "read") { const p = A.papers[proj.id].find(x => x.id === t.dataset.id); if (p) setRead(p, t.checked); return; }
  if (t.dataset.act === "move") {
    const p = A.papers[proj.id].find(x => x.id === t.dataset.id); if (!p) return;
    const { error } = await sb.from("papers").update({ section: t.value }).eq("id", p.id);
    if (error) { toast("Couldn't move it."); return render(); }
    p.section = t.value; A.index.set(p.id, { project_id: proj.id, section: p.section }); return render();
  }
  if (t.id === "goal-d" || t.id === "goal-w") {
    const d = Math.max(1, Math.min(50, parseInt($("goal-d").value, 10) || 1)), w = Math.max(1, Math.min(200, parseInt($("goal-w").value, 10) || 1));
    return saveGoals(d, w);
  }
  if (t.id === "proxy-prefix") { const v = t.value.trim(); proxy.prefix = /^https?:\/\/\S+$/.test(v) ? v : ""; if (!proxy.prefix) proxy.on = false; ls.set("rr-proxy", proxy); return render(); }
  if (t.id === "proxy-on") { proxy.on = t.checked; ls.set("rr-proxy", proxy); return; }
});
document.addEventListener("submit", async e => {
  if (e.target.id === "find-form") { e.preventDefault(); return findPapers($("find-q").value.trim()); }
  if (e.target.id !== "newproj") return;
  e.preventDefault();
  const names = $("np-secs").value.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 12);
  const sections = (names.length ? names : ["Papers"]).map((n, i) => ({ id: "s" + (i + 1), name: n.slice(0, 80) }));
  const { data, error } = await sb.from("projects").insert({ owner: A.session.user.id, name: $("np-name").value.trim(), description: $("np-desc").value.trim(), sections }).select().single();
  if (error) { toast(esc(error.message)); return; }
  A.projects.push(data); A.papers[data.id] = []; A.view.addTab = "find"; A.view.find = null; A.view.findQ = "";
  const useAi = AI && $("np-ai") && $("np-ai").checked;
  location.hash = "#/p/" + data.id;
  if (useAi) openRings(data, "topic", [data.name, data.description].filter(Boolean).join(". "), true);
});
window.addEventListener("hashchange", () => { A.view.confirm = null; A.view.q = ""; render(); window.scrollTo(0, 0); });

/* ============ start ============ */
async function start() {
  loadGuest(); regame(false);
  if (sb) {
    // No sign-in: each browser gets its own anonymous account the first time it opens the site.
    let { data } = await sb.auth.getSession();
    if (!data.session) {
      const r = await sb.auth.signInAnonymously().catch(() => ({ data: {} }));
      data = { session: (r.data && r.data.session) || null };
    }
    A.session = data.session;
    if (A.session) { try { await loadAccount(); } catch { toast("Couldn't load your projects. Reload to try again."); } }
    sb.auth.onAuthStateChange((event, s) => { if (s) A.session = s; }); // token refresh
  }
  A.ready = true; regame(false); render();
  if (sb) {
    try {
      const cfg = await fetch("/api/config").then(r => (r.ok ? r.json() : {}));
      QUIZ = !!cfg.quizzes; AI = !!cfg.ai;
      $("quiz-foot").hidden = !QUIZ; $("ai-foot").hidden = !AI;
      if (QUIZ || AI) { regame(false); render(); }
    } catch {}
  }
}
start();
