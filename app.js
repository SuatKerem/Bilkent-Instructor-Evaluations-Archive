"use strict";

/* ======================================================================
   AI FEATURE HOOK
   ----------------------------------------------------------------------
   This app shows a fast, non-AI "compact summary" by default (built at
   export time by picking the longest/most informative student comments).
   The block below lets you turn on a real AI-generated summary instead,
   via the "AI Summary" button in each instructor's modal.

   To turn it on:
     1. Deploy the small proxy in gemini-proxy/ to Vercel (see its
        README -- it holds your Gemini API key server-side; never put a
        real key directly in this file, since a static site's JS is
        visible to anyone who views the page source).
     2. Set AI_CONFIG.enabled = true and AI_CONFIG.endpoint to your
        Vercel URL + "/api/summarize" below.
   That's it -- the button, the request, and displaying the result are
   already wired up.
====================================================================== */
const AI_CONFIG = {
  enabled: true,
  endpoint: "https://gemini-proxy-beta-lyart.vercel.app/api/summarize",
};

async function generateAISummary(comments, category, instructorName) {
  if (!AI_CONFIG.enabled || !AI_CONFIG.endpoint) return { error: "AI summaries aren't configured yet." };
  try {
    const res = await fetch(AI_CONFIG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comments, category, instructorName }),
    });
    const data = await res.json();
    if (!res.ok || !data.summary) {
      return { error: data.error || `Server returned ${res.status}` };
    }
    return { summary: data.summary };
  } catch (err) {
    console.error("Failed to fetch AI summary:", err);
    return { error: "Couldn't reach the summary service." };
  }
}

async function generateAIComparison(course, instructors, query) {
  if (!AI_CONFIG.enabled || !AI_CONFIG.endpoint) return { error: "AI comparisons aren't configured yet." };
  const compareEndpoint = AI_CONFIG.endpoint.replace(/\/summarize$/, "/compare");
  try {
    const res = await fetch(compareEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ course, instructors, query }),
    });
    const data = await res.json();
    if (!res.ok || !data.comparison) {
      return { error: data.error || `Server returned ${res.status}` };
    }
    return { comparison: data.comparison };
  } catch (err) {
    console.error("Failed to fetch AI comparison:", err);
    return { error: "Couldn't reach the comparison service." };
  }
}

/* ====================================================================== */

/* ======================================================================
   DATA LOADING -- summary fetched immediately, detail per-instructor
   ----------------------------------------------------------------------
   Summary (data-summary.json, ~7MB -- ratings, counts, one preview quote
   per row) is fetched immediately and is all the browse/filter/sort/
   search UI needs.

   Detail is now ONE SMALL FILE PER INSTRUCTOR (detail/<insId>.json --
   typically 30-60KB, rarely over half a MB for the most-evaluated
   people), fetched only for the specific instructor someone actually
   opens, then cached for the rest of the session. This used to be one
   ~100MB file fetched in full on the very first modal open regardless
   of who was clicked -- exactly the "everything downloads at once, slow
   on slow wifi" problem. Now opening any instructor's profile costs
   roughly a network round-trip plus tens of KB, not the whole dataset.
====================================================================== */
let DATA = { rows: [], departments: {}, meta: {} };
let THRESHOLD = 5;
let QUESTION_LABELS = {};

const instructorDetailCache = new Map(); // insId -> {"crsCode|crsNum": [terms]}

async function ensureInstructorDetail(insId) {
  if (instructorDetailCache.has(insId)) return instructorDetailCache.get(insId);
  let data;
  try {
    const res = await fetch(`detail/${insId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(`Failed to load detail for instructor ${insId}:`, err);
    data = {};
  }
  instructorDetailCache.set(insId, data);
  return data;
}
function getTerms(insId, crsCode, crsNum) {
  // Safe to read the cache directly (no await) here: this is only ever
  // called from renderModalContent(), which openModal() only invokes
  // after already awaiting ensureInstructorDetail(item.insId) once.
  const d = instructorDetailCache.get(insId) || {};
  return d[`${crsCode}|${crsNum}`] || [];
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
  courseWaiting: document.getElementById("courseWaiting"),
  search: document.getElementById("search"),
  minResponses: document.getElementById("minResponses"),
  sortBy: document.getElementById("sortBy"),
  clearFilters: document.getElementById("clearFilters"),
  resultsInfo: document.getElementById("resultsInfo"),
  grid: document.getElementById("grid"),
  statsBar: document.getElementById("statsBar"),
  themeToggle: document.getElementById("themeToggle"),
  modalOverlay: document.getElementById("modalOverlay"),
  modalBody: document.getElementById("modalBody"),
  compareBar: document.getElementById("compareBar"),
  compareBarText: document.getElementById("compareBarText"),
  compareHint: document.getElementById("compareHint"),
  compareBarClear: document.getElementById("compareBarClear"),
  compareBarGo: document.getElementById("compareBarGo"),
};

let currentDisplayRows = []; // last rendered set
const compareSelection = new Map(); // insId -> {name, crsCode, crsNum, courseTitle, rating, responses}

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
    els.courseWaiting.style.display = "";
    els.courseSelect.style.display = "none";
    els.courseSelect.value = "";
    return;
  }

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

  // "Pop in" the real dropdown in place of the waiting hint -- this is the
  // actual fix for people trying to pick a course before a department:
  // there's nothing there to click until a department is chosen, rather
  // than a disabled control that invites a click anyway.
  const wasHidden = els.courseWaiting.style.display !== "none";
  els.courseWaiting.style.display = "none";
  els.courseSelect.style.display = "";
  if (wasHidden) {
    els.courseSelect.classList.remove("pop-in");
    void els.courseSelect.offsetWidth; // restart the animation
    els.courseSelect.classList.add("pop-in");
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
  const shown = codes.slice(0, 2).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join("");
  const more = codes.length > 2 ? `<span class="chip chip-more">+${codes.length - 2}</span>` : "";
  return `<div class="chips">${shown}${more}</div>`;
}

function renderCard(item, index, courseSelected) {
  const quote = bestQuote(item);
  const count = totalCommentCount(item);
  const idPrefix = `card-${index}`;

  const commentHtml = quote
    ? `<span class="quote">${escapeHtml(quote.text)}</span>`
    : `<span class="none">No written comments on file.</span>`;

  // Comparing is only offered when looking at one specific course (so every
  // card is directly comparable -- same course, same students' context).
  const checkHtml = courseSelected
    ? `<label class="compare-check-wrap" title="Select to compare">
         <input type="checkbox" class="compare-check" data-insid="${item.insId}" ${compareSelection.has(item.insId) ? "checked" : ""} />
       </label>`
    : "";

  return `
    <div class="card" data-index="${index}" tabindex="0">
      <div class="card-cap" style="--tint:${deptTint(primaryDept(item))}"></div>
      <div class="card-body">
        <div class="card-top">
          ${checkHtml}
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
  renderCompareBar(courseSelected);

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
    html += renderCard(item, i, courseSelected);
    // A light, clearly-labeled in-feed ad slot every 12 cards -- easy to
    // wire up to a real ad network later, never overlays or auto-plays.
    if ((i + 1) % 12 === 0 && i !== display.length - 1) {
      html += `<div class="ad-slot inline">Advertisement</div>`;
    }
  });
  els.grid.innerHTML = html;
}

/* ---------------------------- Compare tool ---------------------------- */

function renderCompareBar(courseSelected) {
  // The hint banner: visible whenever a specific course is selected (so
  // the compare checkboxes are actually on the cards) and the person
  // hasn't started using it yet. Once they've picked 2+, the floating bar
  // below takes over as the active indicator, so the static hint steps
  // aside rather than sitting there redundantly.
  if (els.compareHint) {
    els.compareHint.style.display = (courseSelected && compareSelection.size < 2) ? "" : "none";
  }

  const bar = els.compareBar;
  if (!bar) return; // gracefully no-op if this element is missing for any reason
  if (!courseSelected || compareSelection.size < 2) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "";
  if (els.compareBarText) {
    els.compareBarText.textContent =
      `${compareSelection.size} instructors selected for comparison`;
  }
}

function openCompareModal() {
  const entries = [...compareSelection.values()];
  if (entries.length < 2) return;
  const course = entries[0]; // all entries share the same course by construction

  const rows = entries
    .map(
      (e) => `<div class="compare-instructor-row">
        <span class="name">${escapeHtml(e.name)}</span>
        <span class="stat">${e.rating != null ? e.rating.toFixed(2) : "N/A"} <span style="font-weight:400; color:var(--ink-soft); font-size:11px;">(${e.responses} resp.)</span></span>
      </div>`
    )
    .join("");

  els.modalBody.innerHTML = `
    <button class="modal-close" data-close>&times;</button>
    <h2>Comparing ${entries.length} instructors</h2>
    <div class="modal-sub">${escapeHtml(course.crsCode)} ${escapeHtml(course.crsNum)}${course.courseTitle ? " — " + escapeHtml(course.courseTitle) : ""}</div>
    <div class="course-list" style="border-top:none; margin-top:12px;">${rows}</div>
    <label for="compareQuery" style="font-size:12px; font-weight:600; color:var(--ink-soft);">
      What are you looking for? (optional)
    </label>
    <textarea id="compareQuery" class="compare-query-input" placeholder="e.g. lighter workload, clearer grading, more interactive classes…"></textarea>
    <div class="ai-row ai-row-active">
      <button id="compareGenerate" class="ai-btn" ${AI_CONFIG.enabled ? "" : "disabled"}>✨ Generate AI Comparison</button>
      <span class="ai-note">${AI_CONFIG.enabled ? "Uses each instructor's ratings and comments for this course." : "Set up the AI proxy first (see gemini-proxy/README.md)."}</span>
    </div>
    <div class="ai-summary-box" id="compareResult" style="display:none;"></div>
  `;

  els.modalBody.querySelector("[data-close]").addEventListener("click", closeModal);

  const genBtn = document.getElementById("compareGenerate");
  const resultBox = document.getElementById("compareResult");
  if (AI_CONFIG.enabled) {
    genBtn.addEventListener("click", async () => {
      genBtn.disabled = true;
      genBtn.textContent = "✨ Comparing…";
      resultBox.style.display = "none";

      // Make sure each selected instructor's detail is loaded, then pull
      // their comments for THIS specific course only.
      const instructors = [];
      for (const e of entries) {
        await ensureInstructorDetail(e.insId);
        const terms = getTerms(e.insId, course.crsCode, course.crsNum);
        instructors.push({
          name: e.name,
          rating: e.rating,
          responses: e.responses,
          instrComments: terms.flatMap((t) => (t.comments && t.comments.instructor) || []).slice(0, 8),
          courseComments: terms.flatMap((t) => (t.comments && t.comments.course) || []).slice(0, 8),
        });
      }

      const query = document.getElementById("compareQuery").value;
      const result = await generateAIComparison(course, instructors, query);

      genBtn.disabled = false;
      genBtn.textContent = "✨ Generate AI Comparison";
      if (result.comparison) {
        resultBox.innerHTML = `<span class="ai-label">AI comparison</span>${escapeHtml(result.comparison).replace(/\n/g, "<br>")}`;
        resultBox.style.display = "";
      } else {
        const note = els.modalBody.querySelector(".ai-row .ai-note");
        note.textContent = result.error || "Couldn't generate a comparison right now.";
      }
    });
  }

  els.modalOverlay.classList.add("open");
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

function buildCommentGroups(item, courseTermsArr, category, courseKey) {
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
  return groups;
}

function groupHtml(g) {
  return `
    <div class="c-term-group">
      <div class="c-term-label">${escapeHtml(g.header)}</div>
      ${g.items.map((s) => `<div class="c-item">${escapeHtml(s)}</div>`).join("")}
    </div>`;
}

// Renders comment groups a few at a time as the panel is scrolled, instead
// of building potentially thousands of comments into the DOM the moment a
// popular instructor's modal opens. Small comment counts (the common case)
// just render in one pass with no observer at all -- this machinery only
// kicks in when there's actually enough content for it to matter.
const GROUPS_PER_BATCH = 4;

function mountIncrementalComments(panelEl, groups, emptyMessage) {
  panelEl.innerHTML = "";
  if (!groups.length) {
    panelEl.innerHTML = `<div class="c-empty">${emptyMessage}</div>`;
    return;
  }

  let shown = 0;

  function renderNextBatch() {
    if (shown >= groups.length) return;
    const end = Math.min(shown + GROUPS_PER_BATCH, groups.length);
    panelEl.insertAdjacentHTML("beforeend", groups.slice(shown, end).map(groupHtml).join(""));
    shown = end;
    if (shown >= groups.length) panelEl.removeEventListener("scroll", onScroll);
  }

  // A plain scroll listener with a distance-from-bottom threshold, rather
  // than IntersectionObserver: a moving sentinel's intersection state
  // doesn't reliably toggle enter/exit as content grows beneath a fixed
  // scroll position (verified directly -- the batching logic itself is
  // correct and converges perfectly when driven directly; only the
  // observer-based trigger was unreliable). This fires on every scroll
  // event where the check holds, which is simpler and predictable.
  function onScroll() {
    if (panelEl.scrollTop + panelEl.clientHeight >= panelEl.scrollHeight - 300) {
      renderNextBatch();
    }
  }

  renderNextBatch();
  if (shown < groups.length) {
    panelEl.addEventListener("scroll", onScroll);
    // The first batch might not even fill the panel enough to produce a
    // scrollbar at all -- keep topping up until it does or everything's shown.
    while (shown < groups.length && panelEl.scrollHeight <= panelEl.clientHeight) {
      renderNextBatch();
    }
  }
}

async function openModal(item) {
  els.modalBody.innerHTML = `
    <button class="modal-close" data-close>&times;</button>
    <div class="modal-loading"><span class="spinner"></span>Loading…</div>
  `;
  els.modalBody.querySelector("[data-close]").addEventListener("click", closeModal);
  els.modalOverlay.classList.add("open");

  if (instructorDetailCache.has(item.insId)) {
    renderModalContent(item);
    return;
  }
  // Yield once so the spinner actually paints before the fetch kicks off.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  await ensureInstructorDetail(item.insId);
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
    .map((t) => `<div class="comment-block" data-panel="${t}" data-mounted="0" style="${t === "instructor" ? "" : "display:none;"}"></div>`)
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
    <div class="ai-row${AI_CONFIG.enabled ? " ai-row-active" : ""}">
      <button class="ai-btn" ${AI_CONFIG.enabled ? "" : "disabled"}>✨ AI Summary</button>
      <span class="ai-note">${AI_CONFIG.enabled
        ? "Summarizes the comments below using Gemini."
        : "Coming soon — connect an API in app.js to enable AI-generated summaries."}</span>
    </div>
    <div class="ai-summary-box" style="display:none;"></div>
    <div class="course-list">${courseRows}</div>
    <p class="ai-note" style="margin:-10px 0 16px;">Tap a course to see it by term; tap a term to see the full question breakdown.</p>
    <div class="tabs-row">
      <div class="tabs">${tabButtons}</div>
      ${courseFilterHtml}
    </div>
    ${tabPanels}
  `;

  const aiBtn = els.modalBody.querySelector(".ai-btn");
  const aiNote = els.modalBody.querySelector(".ai-row .ai-note");
  const aiBox = els.modalBody.querySelector(".ai-summary-box");
  if (AI_CONFIG.enabled) {
    aiBtn.addEventListener("click", async () => {
      const activeTab = els.modalBody.querySelector(".tab-btn.active")?.dataset.tab || "instructor";
      const courseKey = courseFilterEl ? courseFilterEl.value : "";
      const groups = buildCommentGroups(item, courseTerms, activeTab, courseKey);
      const allComments = groups.flatMap((g) => g.items);
      if (!allComments.length) {
        aiNote.textContent = "No comments to summarize for this tab.";
        return;
      }
      aiBtn.disabled = true;
      aiBtn.textContent = "✨ Summarizing…";
      aiNote.textContent = "";
      aiBox.style.display = "none";

      const result = await generateAISummary(allComments, activeTab, item.name);

      aiBtn.disabled = false;
      aiBtn.textContent = "✨ AI Summary";
      if (result.summary) {
        aiBox.innerHTML = `<span class="ai-label">AI summary</span>${escapeHtml(result.summary)}`;
        aiBox.style.display = "";
      } else {
        aiNote.textContent = result.error || "Couldn't generate a summary right now.";
      }
    });
  }

  function mountTabPanel(category) {
    const panel = els.modalBody.querySelector(`.comment-block[data-panel="${category}"]`);
    if (!panel) return;
    const courseKey = courseFilterEl ? courseFilterEl.value : "";
    const groups = buildCommentGroups(item, courseTerms, category, courseKey);
    const emptyMsg = `No written comments on file for this category${courseKey ? " in this course" : ""}.`;
    mountIncrementalComments(panel, groups, emptyMsg);
    panel.dataset.mounted = "1";
  }

  const courseFilterEl = els.modalBody.querySelector("#modalCourseFilter");
  mountTabPanel("instructor"); // the initially-visible tab

  els.modalBody.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.modalBody.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      els.modalBody.querySelectorAll(".comment-block").forEach((p) => {
        p.style.display = p.dataset.panel === tab ? "" : "none";
      });
      const panel = els.modalBody.querySelector(`.comment-block[data-panel="${tab}"]`);
      if (panel && panel.dataset.mounted !== "1") mountTabPanel(tab);
    });
  });

  if (courseFilterEl) {
    courseFilterEl.addEventListener("change", () => {
      // The filter changes which groups belong to every category, so any
      // already-mounted panel is stale -- remount only the visible one now
      // (lazily) and let the others re-mount next time they're clicked.
      els.modalBody.querySelectorAll(".comment-block").forEach((p) => { p.dataset.mounted = "0"; });
      const activeTab = els.modalBody.querySelector(".tab-btn.active")?.dataset.tab || "instructor";
      mountTabPanel(activeTab);
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

/* ---------------------------- Wiring ---------------------------- */

function init() {
  // Theme is already set on <html> by the inline script in <head> (before
  // first paint, to avoid a flash) based on the OS/browser preference.
  // Just sync the toggle icon to match on load.
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  els.themeToggle.textContent = isDark ? "☀️" : "🌙";

  initStats();
  initDepartmentOptions();
  updateCourseOptions();

  // Every event listener is attached BEFORE the first render() call below.
  // This matters: if render() (or anything it calls) throws for any reason
  // -- a missing element from a partial file update, a data quirk, whatever
  // -- the page must still stay clickable. Attaching listeners first means
  // a render failure degrades to "the list didn't draw" instead of "the
  // whole page stops responding to anything," which is what happens if a
  // thrown error partway through init() prevents every addEventListener
  // after it from ever running.

  els.deptSelect.addEventListener("change", () => {
    compareSelection.clear();
    updateCourseOptions();
    render();
  });
  els.courseSelect.addEventListener("change", () => {
    compareSelection.clear();
    render();
  });
  els.sortBy.addEventListener("change", render);
  els.minResponses.addEventListener("change", render);

  let searchTimer = null;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });

  els.clearFilters.addEventListener("click", () => {
    compareSelection.clear();
    els.deptSelect.value = "";
    updateCourseOptions();
    els.search.value = "";
    els.minResponses.value = "0";
    els.sortBy.value = "rating-desc";
    render();
  });

  els.grid.addEventListener("click", (e) => {
    const checkWrap = e.target.closest(".compare-check-wrap");
    if (checkWrap) {
      e.stopPropagation();
      return; // the checkbox's own "change" listener (below) handles this
    }
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

  els.grid.addEventListener("change", (e) => {
    if (!e.target.matches(".compare-check")) return;
    const card = e.target.closest(".card");
    const idx = parseInt(card.dataset.index, 10);
    const item = currentDisplayRows[idx];
    const insId = item.insId;
    if (e.target.checked) {
      const c = item.courses[0];
      compareSelection.set(insId, {
        insId, name: item.name, crsCode: c.crsCode, crsNum: c.crsNum,
        courseTitle: c.courseTitle, rating: item.rating, responses: item.nResponses,
      });
    } else {
      compareSelection.delete(insId);
    }
    renderCompareBar(true);
  });

  els.grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const card = e.target.closest(".card");
    if (card) openModal(currentDisplayRows[parseInt(card.dataset.index, 10)]);
  });

  if (els.compareBarClear) {
    els.compareBarClear.addEventListener("click", () => {
      compareSelection.clear();
      render();
    });
  }
  if (els.compareBarGo) {
    els.compareBarGo.addEventListener("click", openCompareModal);
  }

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

  // The actual first render, now that every listener above is guaranteed
  // to be attached regardless of whether this succeeds.
  render();
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
