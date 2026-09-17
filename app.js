"use strict";

/* ======================================================================
   AI FEATURE HOOK
   ----------------------------------------------------------------------
   This app currently shows a fast, non-AI "compact summary" that's built
   at export time (export_data.py) by picking the longest/most informative
   student comments. It's designed so you can swap in a real AI-generated
   summary later without restructuring anything else.

   To wire it up:
     1. Set AI_CONFIG.enabled = true below.
     2. Point AI_CONFIG.endpoint at your own backend/serverless function
        (do NOT put a real API key directly in this file if this site
        will ever be hosted publicly -- a static file's JS is visible to
        everyone. A tiny backend proxy that holds the key server-side is
        the safe way to do this).
     3. Fill in generateAISummary() below to POST the comments for a
        teacher/course to that endpoint and return the summary text.
   The rest of the app already calls getSummaryForModal() wherever a
   summary is shown, so nothing else needs to change.
====================================================================== */
const AI_CONFIG = {
  enabled: false,
  endpoint: null, // e.g. "https://your-backend.example.com/summarize"
};

async function generateAISummary(commentsForCategory) {
  // TODO: replace with a real call once you have a backend, e.g.:
  //
  // const res = await fetch(AI_CONFIG.endpoint, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ comments: commentsForCategory }),
  // });
  // const data = await res.json();
  // return data.summary;
  return null;
}

/* ====================================================================== */

/* ======================================================================
   DATA LOADING -- fetched from separate JSON files
   ----------------------------------------------------------------------
   Split into two files for the same reason as the local build: summary
   (data-summary.json, ~5MB -- ratings, counts, one preview quote per row)
   is fetched immediately and is all the browse/filter/sort/search UI
   needs; detail (data-detail.json, ~75MB -- every question's full
   breakdown, every comment) is only fetched once, lazily, the first time
   someone opens an instructor's detail view, then cached in memory for
   the rest of the session. On a real server (unlike a local file://
   page) fetch() of same-origin files just works, so this is simpler than
   the local build's version: no chunking, no waiting for full-document
   parse -- the browser's own network/streaming layer handles a large
   JSON response fine.
====================================================================== */
let DATA = { rows: [], departments: {}, meta: {} };
let THRESHOLD = 5;
let QUESTION_LABELS = {};

let DETAIL = null;
function isDetailLoaded() {
  return DETAIL !== null;
}
async function ensureDetail() {
  if (!DETAIL) {
    try {
      const res = await fetch("data-detail.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      DETAIL = await res.json();
    } catch (err) {
      console.error("Failed to load detail data:", err);
      DETAIL = {};
    }
  }
  return DETAIL;
}
function getTerms(insId, crsCode, crsNum) {
  // Safe to read DETAIL directly (no await) here: this is only ever called
  // from renderModalContent(), which openModal() only invokes after already
  // awaiting ensureDetail() once.
  const d = DETAIL || {};
  return d[`${insId}|${crsCode}|${crsNum}`] || [];
}

function semLabel(semCode) {
  if (!semCode || semCode.length < 5) return semCode || "Unknown term";
  const year = parseInt(semCode.slice(0, 4), 10);
  const digit = semCode.slice(4);
  const termName = { "1": "Fall", "2": "Spring", "3": "Summer" }[digit] || `Term ${digit}`;
  return `${year}-${year + 1} ${termName}`;
}

const els = {
  deptSelect: document.getElementById("deptSelect"),
  courseSelect: document.getElementById("courseSelect"),
  search: document.getElementById("search"),
  minResponses: document.getElementById("minResponses"),
  sortBy: document.getElementById("sortBy"),
  clearFilters: document.getElementById("clearFilters"),
  exportCsv: document.getElementById("exportCsv"),
  resultsInfo: document.getElementById("resultsInfo"),
  grid: document.getElementById("grid"),
  statsBar: document.getElementById("statsBar"),
  themeToggle: document.getElementById("themeToggle"),
  modalOverlay: document.getElementById("modalOverlay"),
  modalBody: document.getElementById("modalBody"),
};

let currentDisplayRows = []; // last rendered set, for CSV export

/* ---------------------- Setup: stats + dropdowns ---------------------- */

function initStats() {
  const m = DATA.meta;
  els.statsBar.innerHTML = `
    <div class="stat-pill"><strong>${m.totalTeachers ?? "-"}</strong>instructors</div>
    <div class="stat-pill"><strong>${m.totalCourses ?? "-"}</strong>courses</div>
    <div class="stat-pill"><strong>${m.totalEvaluations ?? "-"}</strong>evaluated sections</div>
    <div class="stat-pill"><strong>${(m.totalResponses ?? 0).toLocaleString()}</strong>student responses</div>
  `;
  const genAt = document.getElementById("genAt");
  if (genAt && m.generatedAt) {
    genAt.textContent = " Data last updated: " + m.generatedAt.slice(0, 10) + ".";
  }
}

// Deterministic accent color per department, like catalog tabs -- purely a
// wayfinding device (same department always gets the same tint), not random
// decoration.
const DEPT_TINTS = ["#7A1F2C", "#1F4B3F", "#2C3E67", "#6B3F69", "#8A5A1F"];
function deptTint(code) {
  if (!code) return DEPT_TINTS[0];
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return DEPT_TINTS[h % DEPT_TINTS.length];
}

function initDepartmentOptions() {
  const entries = Object.entries(DATA.departments).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  for (const [code, label] of entries) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label === code ? code : `${code} (${label})`;
    els.deptSelect.appendChild(opt);
  }
}

function updateCourseOptions() {
  const dept = els.deptSelect.value;
  els.courseSelect.innerHTML = "";
  if (!dept) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Select a department first";
    els.courseSelect.appendChild(opt);
    els.courseSelect.disabled = true;
    return;
  }
  els.courseSelect.disabled = false;
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All courses in department";
  els.courseSelect.appendChild(allOpt);

  const seen = new Map(); // "CRSCODE|NUM" -> label
  for (const r of DATA.rows) {
    if (r.crsCode !== dept) continue;
    const key = `${r.crsCode}|${r.crsNum}`;
    if (!seen.has(key)) {
      const label = `${r.crsCode} ${r.crsNum}${r.courseTitle ? " — " + r.courseTitle : ""}`;
      seen.set(key, label);
    }
  }
  const sorted = [...seen.entries()].sort((a, b) =>
    a[1].localeCompare(b[1], undefined, { numeric: true })
  );
  for (const [key, label] of sorted) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    els.courseSelect.appendChild(opt);
  }
}

/* ---------------------- Filtering + aggregation ---------------------- */

function getFilteredRows() {
  const dept = els.deptSelect.value;
  const courseKey = els.courseSelect.value;
  const q = els.search.value.trim().toLowerCase();
  const qCompact = q.replace(/\s+/g, "");

  return DATA.rows.filter((r) => {
    if (dept && r.crsCode !== dept) return false;
    if (courseKey && `${r.crsCode}|${r.crsNum}` !== courseKey) return false;
    if (q) {
      const nameMatch = r.name && r.name.toLowerCase().includes(q);
      const codeMatch = `${r.crsCode}${r.crsNum}`.toLowerCase().includes(qCompact);
      const titleMatch = r.courseTitle && r.courseTitle.toLowerCase().includes(q);
      if (!nameMatch && !codeMatch && !titleMatch) return false;
    }
    return true;
  });
}

function aggregateByTeacher(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.insId)) byId.set(r.insId, []);
    byId.get(r.insId).push(r);
  }
  const out = [];
  for (const [insId, group] of byId) {
    let instrWsum = 0, instrWtot = 0, courseWsum = 0, courseWtot = 0;
    let nEvals = 0, nResponses = 0;
    const qWsum = new Array(10).fill(0), qWtot = new Array(10).fill(0);
    const counts = { instructor: 0, course: 0, assistant: 0 };
    let cardQuote = null;

    for (const r of group) {
      const w = r.nResponses > 0 ? r.nResponses : 1;
      if (r.rating != null) { instrWsum += r.rating * w; instrWtot += w; }
      if (r.courseRating != null) { courseWsum += r.courseRating * w; courseWtot += w; }
      (r.qAverages || []).forEach((v, i) => {
        if (v != null) { qWsum[i] += v * w; qWtot[i] += w; }
      });
      nEvals += r.nEvals;
      nResponses += r.nResponses;
      for (const cat of ["instructor", "course", "assistant"]) {
        counts[cat] += r.comments[cat].count;
      }
      if (r.cardQuote && (!cardQuote || r.cardQuote.text.length > cardQuote.text.length)) {
        cardQuote = r.cardQuote;
      }
    }

    out.push({
      insId,
      name: group[0].name,
      isAggregate: true,
      rating: instrWtot ? Math.round((instrWsum / instrWtot) * 100) / 100 : null,
      courseRating: courseWtot ? Math.round((courseWsum / courseWtot) * 100) / 100 : null,
      qAverages: qWtot.map((wt, i) => (wt ? Math.round((qWsum[i] / wt) * 100) / 100 : null)),
      nEvals,
      nResponses,
      lowConfidence: nResponses < THRESHOLD,
      comments: {
        instructor: { count: counts.instructor },
        course: { count: counts.course },
        assistant: { count: counts.assistant },
      },
      cardQuote,
      courses: group
        .map((r) => ({
          crsCode: r.crsCode, crsNum: r.crsNum, courseTitle: r.courseTitle,
          rating: r.rating, nResponses: r.nResponses,
        }))
        .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1)),
    });
  }
  return out;
}

function wrapSingleRows(rows) {
  return rows.map((r) => ({
    ...r,
    isAggregate: false,
    courses: [{ crsCode: r.crsCode, crsNum: r.crsNum, courseTitle: r.courseTitle,
                rating: r.rating, nResponses: r.nResponses }],
  }));
}

function sortRows(rows) {
  const mode = els.sortBy.value;
  const withRank = (r) => (r.rating == null ? -1 : r.rating);
  const copy = [...rows];

  const qMatch = /^q(\d+)-desc$/.exec(mode);
  if (qMatch) {
    const idx = parseInt(qMatch[1], 10) - 1;
    copy.sort((a, b) => (b.qAverages?.[idx] ?? -1) - (a.qAverages?.[idx] ?? -1));
    return copy;
  }

  switch (mode) {
    case "rating-asc":
      copy.sort((a, b) => withRank(a) - withRank(b));
      break;
    case "responses-desc":
      copy.sort((a, b) => b.nResponses - a.nResponses);
      break;
    case "evals-desc":
      copy.sort((a, b) => b.nEvals - a.nEvals);
      break;
    case "name-asc":
      copy.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "rating-desc":
    default:
      copy.sort((a, b) => withRank(b) - withRank(a));
  }
  return copy;
}

/* ---------------------------- Rendering ---------------------------- */

function ratingTier(rating) {
  if (rating == null) return "na";
  if (rating >= 4.5) return "excellent";
  if (rating >= 4.0) return "good";
  if (rating >= 3.5) return "fair";
  return "low";
}

function ratingHtml(item) {
  const tier = ratingTier(item.rating);
  const label = item.rating == null ? "—" : item.rating.toFixed(2);
  return `<div class="medallion tier-${tier}">${label}</div>`;
}

function cautionButtonHtml(item, idPrefix) {
  if (!item.lowConfidence) return "";
  return `<button class="provisional-flag" title="Provisional rating"
            data-caution-id="${idPrefix}" aria-label="Provisional rating, click for details">!</button>`;
}

function bestQuote(item) {
  return item.cardQuote || null;
}

function totalCommentCount(item) {
  return item.comments.instructor.count + item.comments.course.count + item.comments.assistant.count;
}

function primaryDept(item) {
  return item.courses[0] ? item.courses[0].crsCode : "";
}

function courseSubHtml(item) {
  if (!item.isAggregate) {
    const c = item.courses[0];
    return `<div class="card-sub">${escapeHtml(c.crsCode)} ${escapeHtml(c.crsNum)}${c.courseTitle ? " — " + escapeHtml(c.courseTitle) : ""}</div>`;
  }
  const codes = [...new Set(item.courses.map((c) => `${c.crsCode} ${c.crsNum}`))];
  const shown = codes.slice(0, 3).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join("");
  const more = codes.length > 3 ? `<span class="chip chip-more">+${codes.length - 3}</span>` : "";
  return `<div class="chips">${shown}${more}</div>`;
}

function renderCard(item, index) {
  const quote = bestQuote(item);
  const count = totalCommentCount(item);
  const idPrefix = `card-${index}`;

  const commentHtml = quote
    ? `<span class="quote">${escapeHtml(quote.text)}</span>`
    : `<span class="none">No written comments on file.</span>`;

  return `
    <div class="card" data-index="${index}" tabindex="0">
      <div class="card-cap" style="--tint:${deptTint(primaryDept(item))}"></div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <div class="card-name">${escapeHtml(item.name || "Unknown instructor")}</div>
            ${courseSubHtml(item)}
          </div>
          <div class="rating-block">
            ${ratingHtml(item)}
            ${cautionButtonHtml(item, idPrefix)}
          </div>
        </div>
        <div class="meta-row">
          <span class="meta-item">👥 <b>${item.nResponses}</b> response${item.nResponses === 1 ? "" : "s"}</span>
          <span class="meta-item">📄 <b>${item.nEvals}</b> section${item.nEvals === 1 ? "" : "s"}</span>
          <span class="meta-item">💬 <b>${count}</b> comment${count === 1 ? "" : "s"}</span>
        </div>
        <div class="pull-quote">${commentHtml}</div>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function render() {
  const filtered = getFilteredRows();
  const courseSelected = !!els.courseSelect.value;
  let display = courseSelected ? wrapSingleRows(filtered) : aggregateByTeacher(filtered);

  const minResp = parseInt(els.minResponses.value, 10) || 0;
  display = display.filter((d) => d.nResponses >= minResp);
  display = sortRows(display);

  currentDisplayRows = display;

  els.resultsInfo.textContent = `Showing ${display.length} instructor${display.length === 1 ? "" : "s"}`;

  if (display.length === 0) {
    els.grid.innerHTML = `
      <div class="empty-state">
        <div class="emoji">🔍</div>
        <h3>No matches</h3>
        <p>Try widening your filters or clearing the search box.</p>
      </div>`;
    return;
  }

  let html = "";
  display.forEach((item, i) => {
    html += renderCard(item, i);
    // A light, clearly-labeled in-feed ad slot every 12 cards -- easy to
    // wire up to a real ad network later, never overlays or auto-plays.
    if ((i + 1) % 12 === 0 && i !== display.length - 1) {
      html += `<div class="ad-slot inline">Advertisement</div>`;
    }
  });
  els.grid.innerHTML = html;
}

/* ---------------------------- Modal ---------------------------- */

function questionBreakdownHtml(term) {
  const groups = [
    { label: "Instructor", nums: [1, 2, 3, 4, 5, 6, 7, 8] },
    { label: "Course", nums: [9, 10] },
  ];
  let html = "";
  for (const g of groups) {
    const rows = g.nums
      .map((qn) => {
        const v = term.q[qn - 1];
        if (v == null) return "";
        return `<div class="q-row"><span class="qtext">${escapeHtml(QUESTION_LABELS[qn] || `Q${qn}`)}</span><span class="qval">${v.toFixed(2)}</span></div>`;
      })
      .join("");
    if (rows) html += `<div class="q-group-label">${g.label}</div>${rows}`;
  }
  return html || `<div class="q-empty">No per-question data on file for this term.</div>`;
}

function termRowsHtml(courseIdx, terms) {
  if (!terms.length) return `<div class="q-empty" style="padding:6px 11px;">No term-by-term data on file.</div>`;
  return terms
    .map((t, tIdx) => {
      const label = semLabel(t.sem);
      const rate = t.rating != null ? t.rating.toFixed(2) : "N/A";
      return `
        <div class="term-item">
          <button class="term-row" data-c="${courseIdx}" data-t="${tIdx}" aria-expanded="false">
            <span><span class="tname">${escapeHtml(label)}</span><span class="tmeta">${t.responses} response${t.responses === 1 ? "" : "s"}</span></span>
            <span style="display:flex; align-items:center; gap:8px;">
              <span class="trate">${rate}</span>
              <span class="chev">▸</span>
            </span>
          </button>
          <div class="q-breakdown" data-qpanel="${courseIdx}-${tIdx}" hidden></div>
        </div>`;
    })
    .join("");
}

function groupedCommentsHtml(item, courseTermsArr, category, courseKey) {
  const multiCourse = item.courses.length > 1 && !courseKey;
  const groups = [];
  item.courses.forEach((c, i) => {
    if (courseKey && `${c.crsCode}|${c.crsNum}` !== courseKey) return;
    const termsDesc = [...courseTermsArr[i]].sort(
      (a, b) => (b.sem + (b.br || "")).localeCompare(a.sem + (a.br || ""))
    );
    for (const t of termsDesc) {
      const items = (t.comments && t.comments[category]) || [];
      if (!items.length) continue;
      const header = multiCourse
        ? `${c.crsCode} ${c.crsNum} — ${semLabel(t.sem)}`
        : semLabel(t.sem);
      groups.push({ header, items });
    }
  });
  if (!groups.length) {
    return `<div class="c-empty">No written comments on file for this category${courseKey ? " in this course" : ""}.</div>`;
  }
  return groups
    .map(
      (g) => `
        <div class="c-term-group">
          <div class="c-term-label">${escapeHtml(g.header)}</div>
          ${g.items.map((s) => `<div class="c-item">${escapeHtml(s)}</div>`).join("")}
        </div>`
    )
    .join("");
}

async function openModal(item) {
  els.modalBody.innerHTML = `
    <button class="modal-close" data-close>&times;</button>
    <div class="modal-loading"><span class="spinner"></span>Loading full details…</div>
  `;
  els.modalBody.querySelector("[data-close]").addEventListener("click", closeModal);
  els.modalOverlay.classList.add("open");

  if (isDetailLoaded()) {
    renderModalContent(item);
    return;
  }
  // Yield so the spinner actually paints before the wait-for-full-parse +
  // one-time JSON.parse sequence begins (the parse itself is synchronous
  // and would otherwise block the very paint meant to show it's loading).
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  await ensureDetail();
  // The modal may have been closed (or reopened for someone else) during
  // that wait -- only render if this is still the open request that matters.
  if (!els.modalOverlay.classList.contains("open")) return;
  renderModalContent(item);
}

function renderModalContent(item) {
  const courseTerms = item.courses.map((c) => getTerms(item.insId, c.crsCode, c.crsNum));

  const cautionHtml = item.lowConfidence
    ? `<div class="caution-box">
         <span class="stamp">Provisional</span>
         <p>Based on only <strong>${item.nResponses}</strong> student response${item.nResponses === 1 ? "" : "s"} across
         ${item.nEvals} section${item.nEvals === 1 ? "" : "s"}. Ratings from very few respondents can swing a lot and may not reflect the typical experience.</p>
       </div>`
    : "";

  const courseRows = item.courses
    .map((c, cIdx) => {
      const label = `${c.crsCode} ${c.crsNum}${c.courseTitle ? " — " + c.courseTitle : ""}`;
      return `
        <div class="course-item">
          <button class="course-row" data-c="${cIdx}" aria-expanded="false">
            <span class="cname">${escapeHtml(label)}</span>
            <span style="display:flex; align-items:center; gap:8px;">
              <span class="crate">${c.rating != null ? c.rating.toFixed(2) : "N/A"}</span>
              <span class="chev">▸</span>
            </span>
          </button>
          <div class="term-list" data-cpanel="${cIdx}" hidden>${termRowsHtml(cIdx, courseTerms[cIdx])}</div>
        </div>`;
    })
    .join("");

  const tabs = ["instructor", "course", "assistant"];
  const tabLabels = { instructor: "Instructor", course: "Course", assistant: "TA / Support" };

  const tabButtons = tabs
    .map(
      (t, i) =>
        `<button class="tab-btn ${i === 0 ? "active" : ""}" data-tab="${t}">
          ${tabLabels[t]} (${item.comments[t].count})
        </button>`
    )
    .join("");

  const courseFilterHtml =
    item.courses.length > 1
      ? `<select id="modalCourseFilter" class="modal-course-filter">
           <option value="">All courses</option>
           ${item.courses
             .map((c) => `<option value="${c.crsCode}|${c.crsNum}">${escapeHtml(c.crsCode)} ${escapeHtml(c.crsNum)}</option>`)
             .join("")}
         </select>`
      : "";

  const tabPanels = tabs
    .map((t) => {
      const body = groupedCommentsHtml(item, courseTerms, t, "");
      return `<div class="comment-block" data-panel="${t}" style="${t === "instructor" ? "" : "display:none;"}">${body}</div>`;
    })
    .join("");

  els.modalBody.innerHTML = `
    <button class="modal-close" data-close>&times;</button>
    <h2>${escapeHtml(item.name || "Unknown instructor")}</h2>
    <div class="modal-sub">${item.isAggregate ? `${item.courses.length} course${item.courses.length === 1 ? "" : "s"} on file` : `${escapeHtml(item.courses[0].crsCode)} ${escapeHtml(item.courses[0].crsNum)}${item.courses[0].courseTitle ? " — " + escapeHtml(item.courses[0].courseTitle) : ""}`}</div>
    ${cautionHtml}
    <div class="stat-boxes">
      <div class="stat-box"><div class="val">${item.rating != null ? item.rating.toFixed(2) : "N/A"}</div><div class="lbl">Instructor rating</div></div>
      <div class="stat-box"><div class="val">${item.courseRating != null ? item.courseRating.toFixed(2) : "N/A"}</div><div class="lbl">Course rating</div></div>
      <div class="stat-box"><div class="val">${item.nResponses}</div><div class="lbl">Total responses</div></div>
    </div>
    <div class="course-list">${courseRows}</div>
    <p class="ai-note" style="margin:-10px 0 16px;">Tap a course to see it by term; tap a term to see the full question breakdown.</p>
    <div class="tabs-row">
      <div class="tabs">${tabButtons}</div>
      ${courseFilterHtml}
    </div>
    ${tabPanels}
    <div class="ai-row">
      <button class="ai-btn" disabled>✨ AI Summary</button>
      <span class="ai-note">Coming soon — connect an API in app.js to enable AI-generated summaries.</span>
    </div>
  `;

  els.modalBody.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.modalBody.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      els.modalBody.querySelectorAll(".comment-block").forEach((p) => {
        p.style.display = p.dataset.panel === tab ? "" : "none";
      });
    });
  });

  const courseFilterEl = els.modalBody.querySelector("#modalCourseFilter");
  if (courseFilterEl) {
    courseFilterEl.addEventListener("change", () => {
      const key = courseFilterEl.value;
      tabs.forEach((t) => {
        const panel = els.modalBody.querySelector(`.comment-block[data-panel="${t}"]`);
        if (panel) panel.innerHTML = groupedCommentsHtml(item, courseTerms, t, key);
      });
    });
  }

  els.modalBody.querySelector("[data-close]").addEventListener("click", closeModal);

  // Accordion: course -> terms -> per-question breakdown. Delegated so it
  // works regardless of how many courses/terms were rendered.
  els.modalBody.querySelector(".course-list")?.addEventListener("click", (e) => {
    const courseBtn = e.target.closest(".course-row");
    if (courseBtn) {
      const panel = els.modalBody.querySelector(`[data-cpanel="${courseBtn.dataset.c}"]`);
      const expanded = courseBtn.getAttribute("aria-expanded") === "true";
      courseBtn.setAttribute("aria-expanded", String(!expanded));
      if (panel) panel.hidden = expanded;
      return;
    }
    const termBtn = e.target.closest(".term-row");
    if (termBtn) {
      const { c, t } = termBtn.dataset;
      const panel = els.modalBody.querySelector(`[data-qpanel="${c}-${t}"]`);
      const expanded = termBtn.getAttribute("aria-expanded") === "true";
      termBtn.setAttribute("aria-expanded", String(!expanded));
      if (panel) {
        panel.hidden = expanded;
        if (!expanded && !panel.dataset.filled) {
          const term = courseTerms[c][t];
          panel.innerHTML = questionBreakdownHtml(term);
          panel.dataset.filled = "1";
        }
      }
    }
  });
}

function closeModal() {
  els.modalOverlay.classList.remove("open");
}

/* ---------------------------- Caution popover ---------------------------- */

let activePopover = null;

function showCautionPopover(anchorEl, item) {
  removePopover();
  const pop = document.createElement("div");
  pop.className = "popover";
  pop.innerHTML = `<span class="pop-close">&times;</span>
    <strong>Provisional rating</strong> — based on only <strong>${item.nResponses}</strong> student
    response${item.nResponses === 1 ? "" : "s"}. With so few respondents, the
    average can swing a lot from a single review and may not represent the
    typical experience.`;
  document.body.appendChild(pop);

  const rect = anchorEl.getBoundingClientRect();
  const top = Math.min(rect.bottom + 8, window.innerHeight - pop.offsetHeight - 12);
  let left = rect.left - 100;
  left = Math.max(12, Math.min(left, window.innerWidth - pop.offsetWidth - 12));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  pop.querySelector(".pop-close").addEventListener("click", (e) => {
    e.stopPropagation();
    removePopover();
  });
  activePopover = pop;
}

function removePopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
}

/* ---------------------------- CSV export ---------------------------- */

function exportCsv() {
  const rows = currentDisplayRows;
  if (!rows.length) return;
  const header = ["Instructor", "Courses", "Instructor Rating", "Course Rating",
                   "Responses", "Evaluated Sections", "Low Confidence"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const courses = r.courses.map((c) => `${c.crsCode} ${c.crsNum}`).join("; ");
    const row = [
      r.name, courses,
      r.rating != null ? r.rating.toFixed(2) : "",
      r.courseRating != null ? r.courseRating.toFixed(2) : "",
      r.nResponses, r.nEvals, r.lowConfidence ? "Yes" : "No",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    lines.push(row.join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bilkent_instructor_results.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------------------- Wiring ---------------------------- */

function init() {
  // Theme is already set on <html> by the inline script in <head> (before
  // first paint, to avoid a flash) based on the OS/browser preference.
  // Just sync the toggle icon to match on load.
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  els.themeToggle.textContent = isDark ? "☀️" : "🌙";

  initStats();
  initDepartmentOptions();  updateCourseOptions();
  render();

  els.deptSelect.addEventListener("change", () => {
    updateCourseOptions();
    render();
  });
  els.courseSelect.addEventListener("change", render);
  els.sortBy.addEventListener("change", render);
  els.minResponses.addEventListener("change", render);

  let searchTimer = null;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });

  els.clearFilters.addEventListener("click", () => {
    els.deptSelect.value = "";
    updateCourseOptions();
    els.search.value = "";
    els.minResponses.value = "0";
    els.sortBy.value = "rating-desc";
    render();
  });

  els.exportCsv.addEventListener("click", exportCsv);

  els.grid.addEventListener("click", (e) => {
    const cautionBtn = e.target.closest(".provisional-flag");
    if (cautionBtn) {
      e.stopPropagation();
      const card = cautionBtn.closest(".card");
      const idx = parseInt(card.dataset.index, 10);
      showCautionPopover(cautionBtn, currentDisplayRows[idx]);
      return;
    }
    const card = e.target.closest(".card");
    if (card) {
      const idx = parseInt(card.dataset.index, 10);
      openModal(currentDisplayRows[idx]);
    }
  });

  els.grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const card = e.target.closest(".card");
    if (card) openModal(currentDisplayRows[parseInt(card.dataset.index, 10)]);
  });

  els.modalOverlay.addEventListener("click", (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
      removePopover();
    }
  });
  document.addEventListener("click", (e) => {
    if (activePopover && !e.target.closest(".popover") && !e.target.closest(".provisional-flag")) {
      removePopover();
    }
  });

  els.themeToggle.addEventListener("click", () => {
    const html = document.documentElement;
    const isDark = html.getAttribute("data-theme") === "dark";
    const goingDark = isDark ? false : true;
    html.setAttribute("data-theme", goingDark ? "dark" : "light");
    els.themeToggle.textContent = goingDark ? "☀️" : "🌙";
    const meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", goingDark ? "#201B27" : "#F6EEF2");
  });

  handleDeepLink();
}

// If someone arrives via a link like "index.html?instructor=6083" (e.g.
// from one of the static per-instructor SEO pages -- see generate_seo.py),
// jump straight to that person: pre-fill the search box so the grid shows
// just them, and open their detail modal automatically.
function handleDeepLink() {
  const insId = new URLSearchParams(location.search).get("instructor");
  if (!insId) return;
  const idNum = parseInt(insId, 10);
  const rows = DATA.rows.filter((r) => r.insId === idNum);
  if (!rows.length) return;
  els.search.value = rows[0].name;
  render();
  const item = aggregateByTeacher(rows)[0];
  if (item) openModal(item);
}

// Bootstrap: fetch the summary data first, then run the normal init().
// (Unlike the local single-file build, this one genuinely needs to wait
// for a network request before there's anything to render.)
async function bootstrap() {
  try {
    const res = await fetch("data-summary.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    console.error("Failed to load site data:", err);
    els.resultsInfo.textContent = "";
    els.grid.innerHTML = `
      <div class="empty-state">
        <div class="emoji">⚠️</div>
        <h3>Couldn't load data</h3>
        <p>data-summary.json didn't load. If you're testing this locally, serve
        it over a local web server rather than opening index.html directly
        (fetch() of local files is blocked by the browser otherwise).</p>
      </div>`;
    return;
  }
  THRESHOLD = DATA.meta.lowResponseThreshold || 5;
  QUESTION_LABELS = DATA.meta.questionLabels || {};
  init();
}
bootstrap();
