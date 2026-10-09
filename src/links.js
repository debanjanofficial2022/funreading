// Builds the Paper and SI links for a paper from its DOI.
const NO_SI_BEFORE = 2000;

export function linkSet(p) {
  const d = p.d;
  const scholar = "https://scholar.google.com/scholar?q=" + encodeURIComponent('"' + p.t + '"');
  if (!d) {
    return {
      page: scholar,
      paper: { href: scholar, label: "Find paper", ext: true },
      si: null,
      siNote: p.y < NO_SI_BEFORE ? "No SI (published before SI was standard)" : "No DOI on file; find the SI from the article page",
    };
  }
  const land = "https://doi.org/" + d;
  const pre = d.split("/")[0];
  const suf = d.slice(d.indexOf("/") + 1);
  let pdf = null, si = null, siNote = "";
  if (pre === "10.1021") { pdf = "https://pubs.acs.org/doi/pdf/" + d; si = "https://pubs.acs.org/doi/suppl/" + d; }
  else if (pre === "10.1126") { pdf = "https://www.science.org/doi/pdf/" + d; si = "https://www.science.org/doi/suppl/" + d; }
  else if (pre === "10.1073") { pdf = "https://www.pnas.org/doi/pdf/" + d; si = "https://www.pnas.org/doi/suppl/" + d; }
  else if (pre === "10.1038") { const a = suf.toLowerCase(); pdf = "https://www.nature.com/articles/" + a + ".pdf"; si = "https://www.nature.com/articles/" + a + "#supplementary-information"; }
  else if (pre === "10.1002") { pdf = "https://onlinelibrary.wiley.com/doi/pdf/" + d; si = "https://onlinelibrary.wiley.com/doi/full/" + d + "#support-information-section"; }
  else { si = land; siNote = "SI is listed on the article page"; }
  if (p.y < NO_SI_BEFORE) { si = null; siNote = "No SI (published before SI was standard)"; }
  if (/textbook|book chapter/i.test(p.t + " " + p.j)) { si = null; siNote = "Book: no SI"; }
  return {
    page: land,
    paper: { href: pdf || land, label: pdf ? "PDF" : "Article", ext: false },
    si: si ? { href: si, label: pdf || pre === "10.1038" ? "SI" : "SI (on page)" } : null,
    siNote,
  };
}

export function cleanDoi(s) {
  return String(s || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
}
