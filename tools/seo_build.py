#!/usr/bin/env python3
"""Build crawlable static pages for search engines.

Run from the repo root after updating data-summary.json / detail/*.json:

    python3 tools/seo_build.py

It (re)writes:
  - instructors/<slug>-<id>.html   one page per instructor (existing slugs kept)
  - courses/<code>-<num>.html      one page per course, instructors ranked
  - departments/<code>.html        one hub page per department
  - the "Browse by department" block in index.html (between SEO markers)
  - sitemap.xml                    every page above, with lastmod

The interactive app (index.html + app.js) is untouched apart from the
marked block, so nothing changes for people using the site.
"""
import html
import json
import os
import re
import unicodedata
from collections import defaultdict

BASE = "https://suatkerem.github.io/Bilkent-Instructor-Evaluations-Archive/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_COMMENTS = 8
COMMENT_CHARS = 400

e = lambda s: html.escape(str(s), quote=True)


def slugify(text):
    text = text.replace("ı", "i").replace("İ", "I")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def sem_label(code):
    if not code or len(code) < 5:
        return code or "Unknown term"
    y = int(code[:4])
    term = {"1": "Fall", "2": "Spring", "3": "Summer"}.get(code[4:], "Term " + code[4:])
    return f"{y}-{y + 1} {term}"


def course_slug(code, num):
    return slugify(f"{code}-{num}")


def page(title, desc, canonical, body, depth=1):
    up = "../" * depth
    return f"""<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}" />
<link rel="canonical" href="{e(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Bilkent Instructor &amp; Course Guide" />
<meta property="og:title" content="{e(title)}" />
<meta property="og:description" content="{e(desc)}" />
<meta property="og:url" content="{e(canonical)}" />
<meta name="theme-color" content="#F6EEF2" />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{up}style.css" />
</head>
<body>
<div class="wrap" style="max-width:720px;">
{body}
  <footer class="site-footer">
    Data source: Bilkent University STARS public course &amp; instructor evaluation reports.
    Built for personal course-selection use &mdash; not an official Bilkent University resource.
  </footer>
</div>
</body>
</html>
"""


def crumbs(*links):
    parts = [f'<a href="{e(h)}" class="link-btn">{e(t)}</a>' for h, t in links]
    return '  <p style="margin:18px 0;">' + " &rsaquo; ".join(parts) + "</p>"


def row(href, name, rating, extra=""):
    r = f"{rating:.2f}" if isinstance(rating, (int, float)) else "&ndash;"
    sub = f' <span style="color:var(--ink-soft);font-weight:400;font-size:12px;">{extra}</span>' if extra else ""
    return (f'      <a class="course-row" href="{e(href)}" style="text-decoration:none;color:inherit;">'
            f'<span class="cname">{name}{sub}</span><span class="crate">{r}</span></a>')


def wavg(rows, key="rating"):
    tot = sum(r["nResponses"] for r in rows if r.get(key) is not None)
    if not tot:
        return None
    return sum(r[key] * r["nResponses"] for r in rows if r.get(key) is not None) / tot


def main():
    os.chdir(ROOT)
    data = json.load(open("data-summary.json", encoding="utf-8"))
    rows, depts, meta = data["rows"], data["departments"], data["meta"]
    lastmod = (meta.get("generatedAt") or "")[:10]

    # Keep the existing instructor URLs (Google may already know them).
    ins_file = {}
    for f in os.listdir("instructors"):
        m = re.match(r"(.+)-(\d+)\.html$", f)
        if m:
            ins_file[int(m.group(2))] = f

    by_ins = defaultdict(list)
    by_course = defaultdict(list)
    for r in rows:
        by_ins[r["insId"]].append(r)
        by_course[(r["crsCode"], r["crsNum"])].append(r)

    course_title = {k: v[0]["courseTitle"] for k, v in by_course.items()}
    urls = [BASE]

    # ---------- instructor pages ----------
    for ins_id, irows in by_ins.items():
        name = irows[0]["name"]
        fname = ins_file.get(ins_id) or f"{slugify(name)}-{ins_id}.html"
        ins_file[ins_id] = fname
        irows.sort(key=lambda r: -r["nResponses"])
        rating = wavg(irows)
        n_resp = sum(r["nResponses"] for r in irows)
        n_sec = sum(r["nEvals"] for r in irows)
        codes = [f'{r["crsCode"]} {r["crsNum"]}' for r in irows]

        comments = []
        try:
            detail = json.load(open(f"detail/{ins_id}.json", encoding="utf-8"))
        except (OSError, ValueError):
            detail = {}
        for ckey, secs in detail.items():
            code, num = ckey.split("|", 1)
            for s in secs:
                for c in (s.get("comments") or {}).get("instructor") or []:
                    if c and len(c.strip()) > 25:
                        comments.append((s.get("sem") or "", f"{code} {num}", c.strip()))
        comments.sort(key=lambda x: x[0], reverse=True)
        comments = comments[:MAX_COMMENTS]

        rating_txt = f"{rating:.2f}/5" if rating is not None else "no rating"
        title = f"{name} — Bilkent Instructor Ratings & Student Reviews"
        desc = (f"{name} at Bilkent University: {rating_txt} instructor rating from {n_resp} student responses "
                f"(hoca yorumları ve değerlendirmeleri) across {', '.join(codes[:6])}"
                + ("…" if len(codes) > 6 else "") + ".")
        course_rows = "\n".join(
            row(f'../courses/{course_slug(r["crsCode"], r["crsNum"])}.html',
                f'{e(r["crsCode"])} {e(r["crsNum"])} &mdash; {e(r["courseTitle"])}', r["rating"],
                f'{r["nResponses"]} responses')
            for r in irows)
        cm = ""
        if comments:
            items = "\n".join(
                f'      <div class="pull-quote" style="margin:10px 0;"><span class="quote">{e(c[:COMMENT_CHARS] + ("…" if len(c) > COMMENT_CHARS else ""))}</span>'
                f'<div style="font-size:12px;color:var(--ink-soft);margin-top:4px;">{e(code)} &middot; {e(sem_label(sem))}</div></div>'
                for sem, code, c in comments)
            cm = f"    <h3 style=\"margin-top:22px;\">Recent student comments</h3>\n{items}\n"
        body = f"""{crumbs(("../", "All instructors"))}
  <div class="modal" style="margin:0; border-top:5px solid var(--rose);">
    <h1 style="font-family:var(--serif);font-weight:600;font-size:24px;margin:0 0 2px;">{e(name)}</h1>
    <div class="modal-sub">Bilkent University instructor &middot; {len(irows)} course{'s' if len(irows) != 1 else ''} on file</div>
    <div class="stat-boxes">
      <div class="stat-box"><div class="val">{f'{rating:.2f}' if rating is not None else '&ndash;'}</div><div class="lbl">Instructor rating</div></div>
      <div class="stat-box"><div class="val">{n_resp}</div><div class="lbl">Total responses</div></div>
      <div class="stat-box"><div class="val">{n_sec}</div><div class="lbl">Sections evaluated</div></div>
    </div>
    <h3>Courses</h3>
    <div class="course-list">
{course_rows}
    </div>
{cm}    <div class="ai-row" style="margin-top:20px;">
      <a href="../?instructor={ins_id}" class="small-btn" style="text-decoration:none; display:inline-block;">
        Open full profile &mdash; every course, every comment &rarr;
      </a>
    </div>
  </div>"""
        url = BASE + "instructors/" + fname
        with open("instructors/" + fname, "w", encoding="utf-8") as fh:
            fh.write(page(title, desc, url, body))
        urls.append(url)

    # ---------- course pages ----------
    os.makedirs("courses", exist_ok=True)
    dept_courses = defaultdict(list)
    for (code, num), crows in by_course.items():
        dept_courses[code].append((code, num))
        crows.sort(key=lambda r: (r["lowConfidence"], -(r["rating"] or 0)))
        ct = course_title[(code, num)]
        dname = depts.get(code, code)
        n_resp = sum(r["nResponses"] for r in crows)
        best = [r["name"] for r in crows[:3]]
        title = f"{code} {num} {ct} — Bilkent Instructors Compared"
        desc = (f"Who to take for {code} {num} ({ct}) at Bilkent? {len(crows)} instructor{'s' if len(crows) != 1 else ''} "
                f"ranked by {n_resp} student evaluations: {', '.join(best)}.")
        lines = "\n".join(
            row(f'../instructors/{ins_file[r["insId"]]}', e(r["name"]), r["rating"],
                f'{r["nResponses"]} responses · {r["nSemesters"]} semester{"s" if r["nSemesters"] != 1 else ""}'
                + (" · few responses" if r["lowConfidence"] else ""))
            for r in crows)
        body = f"""{crumbs(("../", "All instructors"), (f"../departments/{slugify(code)}.html", dname))}
  <div class="modal" style="margin:0; border-top:5px solid var(--rose);">
    <h1 style="font-family:var(--serif);font-weight:600;font-size:24px;margin:0 0 2px;">{e(code)} {e(num)} &mdash; {e(ct)}</h1>
    <div class="modal-sub">{e(dname)} &middot; Bilkent University &middot; {n_resp} student responses</div>
    <h3>Instructors, best rated first</h3>
    <div class="course-list">
{lines}
    </div>
  </div>"""
        fname = f"courses/{course_slug(code, num)}.html"
        with open(fname, "w", encoding="utf-8") as fh:
            fh.write(page(title, desc, BASE + fname, body))
        urls.append(BASE + fname)

    # ---------- department pages ----------
    os.makedirs("departments", exist_ok=True)
    dept_links = []
    for code in sorted(dept_courses):
        dname = depts.get(code, code)
        cl = sorted(dept_courses[code], key=lambda k: (len(k[1]), k[1]))
        ins = {}
        for k in cl:
            for r in by_course[k]:
                ins.setdefault(r["insId"], r["name"])
        clines = "\n".join(
            row(f"../courses/{course_slug(*k)}.html", f"{e(k[0])} {e(k[1])} &mdash; {e(course_title[k])}",
                wavg(by_course[k]), f"{len(by_course[k])} instructor{'s' if len(by_course[k]) != 1 else ''}")
            for k in cl)
        ilines = ", ".join(f'<a href="../instructors/{ins_file[i]}">{e(n)}</a>'
                           for i, n in sorted(ins.items(), key=lambda x: x[1]))
        title = f"{dname} ({code}) — Bilkent Course & Instructor Evaluations"
        desc = (f"Student evaluations for all {len(cl)} {code} courses and {len(ins)} instructors in {dname} "
                f"at Bilkent University.")
        body = f"""{crumbs(("../", "All instructors"))}
  <div class="modal" style="margin:0; border-top:5px solid var(--rose);">
    <h1 style="font-family:var(--serif);font-weight:600;font-size:24px;margin:0 0 2px;">{e(dname)} ({e(code)})</h1>
    <div class="modal-sub">Bilkent University &middot; {len(cl)} courses &middot; {len(ins)} instructors</div>
    <h3>Courses</h3>
    <div class="course-list">
{clines}
    </div>
    <h3 style="margin-top:22px;">Instructors</h3>
    <p style="line-height:1.9;">{ilines}</p>
  </div>"""
        fname = f"departments/{slugify(code)}.html"
        with open(fname, "w", encoding="utf-8") as fh:
            fh.write(page(title, desc, BASE + fname, body))
        urls.append(BASE + fname)
        dept_links.append(f'<a href="{fname}">{e(code)} &mdash; {e(dname)}</a>')

    # ---------- index.html browse block ----------
    block = ("<!-- SEO:BROWSE:START (generated by tools/seo_build.py) -->\n"
             '  <nav class="seo-browse" aria-label="Browse by department" style="margin:28px 0 8px;font-size:13px;line-height:1.9;">\n'
             '    <h2 style="font-family:var(--serif);font-size:18px;margin:0 0 6px;">Browse by department</h2>\n    '
             + " &middot;\n    ".join(dept_links)
             + "\n  </nav>\n  <!-- SEO:BROWSE:END -->")
    idx = open("index.html", encoding="utf-8").read()
    pat = re.compile(r"<!-- SEO:BROWSE:START.*?SEO:BROWSE:END -->", re.S)
    if pat.search(idx):
        idx = pat.sub(lambda _: block, idx)
    else:
        idx = idx.replace('  <footer class="site-footer">', "  " + block + '\n\n  <footer class="site-footer">', 1)
    open("index.html", "w", encoding="utf-8").write(idx)

    # ---------- sitemap ----------
    lm = f"<lastmod>{lastmod}</lastmod>" if lastmod else ""
    with open("sitemap.xml", "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u in urls:
            fh.write(f"  <url><loc>{e(u)}</loc>{lm}</url>\n")
        fh.write("</urlset>\n")
    print(f"{len(by_ins)} instructors, {len(by_course)} courses, {len(dept_links)} departments, {len(urls)} URLs")


if __name__ == "__main__":
    main()
