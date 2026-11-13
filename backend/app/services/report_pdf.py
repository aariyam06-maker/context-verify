"""Per-job PDF report (downloadable from the result page)."""
from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

RED = colors.HexColor("#c8102e")


def _table(rows, widths):
    t = Table(rows, colWidths=widths)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f2f2f2")),
                           ("FONTSIZE", (0, 0), (-1, -1), 9), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    return t


def _detect_block(st, r: dict, title: str):
    out = [Paragraph(title, st["Heading2"]),
           _table([["Metric", "Value"], ["Verdict", r.get("verdictLabel", "-")], ["AI-generation probability", f"{r.get('aiProbability', 0):.1f}%"],
                   ["AI content share of timeline", f"{r.get('aiContentShare', 0):.1f}%"], ["Confidence", f"{r.get('confidenceBand', '-')} ({r.get('confidence', 0):.2f})"],
                   ["Frames analysed", str(r.get("media", {}).get("framesAnalysed", "-"))], ["Resolution", f"{r.get('media', {}).get('width')}x{r.get('media', {}).get('height')}"]], [190, 300]),
           Spacer(1, 6)]
    if r.get("evidence"):
        rows = [["Forensic signal", "Observed", "Typical real", "Typical AI", "Points to"]]
        for e in r["evidence"]:
            rows.append([e["title"], f"{e['value']:.3g}", f"{e['typicalReal']:.3g}", f"{e['typicalAI']:.3g}", e["pushesTowards"]])
        out += [Paragraph("Strongest forensic evidence", st["Heading3"]), _table(rows, [170, 70, 70, 70, 80]), Spacer(1, 6)]
    if r.get("gemini") and r["gemini"].get("probability") is not None:
        out.append(Paragraph(f"Gemini second opinion ({r['gemini']['model']}): {r['gemini']['probability']:.0%} AI. " + "; ".join(r["gemini"].get("reasons", [])), st["BodyText"]))
    return out


def build_report_pdf(path: Path, job: dict, result: dict) -> None:
    st = getSampleStyleSheet()
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=40, rightMargin=40, topMargin=40, bottomMargin=40)
    story = [Paragraph("ContextTrace - Analysis Report", st["Title"]),
             Paragraph(f"Job {job['_id']} | mode: {'AI detection' if job['mode'] == 'detect' else 'Evidence tamper check'}", st["Normal"]), Spacer(1, 10)]
    if job["mode"] == "detect":
        story += _detect_block(st, result, f"Video: {job.get('videoA')}")
    else:
        story += [Paragraph("Verdict", st["Heading2"]), Paragraph(result.get("summary", ""), st["BodyText"]), Spacer(1, 6)]
        vids = result.get("videos", {})
        rows = [["", vids.get("a", {}).get("name", "A"), vids.get("b", {}).get("name", "B")],
                ["Role", "ORIGINAL" if result.get("original") == "a" else "TAMPERED" if result.get("tampered") == "a" else "-",
                 "ORIGINAL" if result.get("original") == "b" else "TAMPERED" if result.get("tampered") == "b" else "-"],
                ["Originality probability", *[f"{vids.get(k, {}).get('originality'):.1f}%" if vids.get(k, {}).get("originality") is not None else "-" for k in ("a", "b")]],
                ["AI-generation probability", *[f"{vids.get(k, {}).get('ai', {}).get('aiProbability', 0):.1f}%" for k in ("a", "b")]],
                ["AI content share", *[f"{vids.get(k, {}).get('ai', {}).get('aiContentShare', 0):.1f}%" for k in ("a", "b")]]]
        story += [_table(rows, [150, 170, 170]), Spacer(1, 8)]
        if result.get("events"):
            story.append(Paragraph("Located tampering events", st["Heading2"]))
            ev = [["#", "Event", "Where", "Detail"]]
            for i, e in enumerate(result["events"], 1):
                where = f"{e.get('start', '')}-{e.get('end', '')}s" if e.get("start") is not None else "-"
                ev.append([str(i), e["title"], where, Paragraph(e["description"], st["BodyText"])])
            story.append(_table(ev, [20, 120, 70, 280]))
        for k in ("a", "b"):
            if vids.get(k, {}).get("ai"):
                story += _detect_block(st, vids[k]["ai"], f"AI analysis - {vids[k]['name']}")
    m = result.get("model") or {}
    story += [Spacer(1, 10), Paragraph("Method & limitations", st["Heading2"]),
              Paragraph(f"Model {m.get('version', '-')}. Probabilities are calibrated estimates from a classifier trained on 935 videos from 12 public datasets; "
                        "accuracy on never-seen sources is reported in ContextTrace_Project_Report.pdf. Results are forensic indicators, not legal proof.", st["BodyText"])]
    doc.build(story)
