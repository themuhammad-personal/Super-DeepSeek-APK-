#!/usr/bin/env python3
"""Turn Android Lint XML and Kotlin compiler warnings into a few GitHub
annotations (the checks API shows them without downloading logs).

GitHub keeps at most 10 annotations of one level per step, so issues are
packed several to an annotation.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PER_ANNOTATION = 25
MAX_ANNOTATIONS = 9


def rel(path: str) -> str:
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except Exception:
        return path


def lint_issues(xml_path: Path):
    out = []
    if not xml_path.is_file():
        return out
    for issue in ET.parse(xml_path).getroot().iter("issue"):
        loc = issue.find("location")
        where = ""
        if loc is not None:
            where = f"{rel(loc.get('file', ''))}:{loc.get('line', '?')}"
        out.append(f"[{issue.get('severity')}] {issue.get('id')} {where} — {issue.get('message')}")
    return out


def kotlin_warnings(log_path: Path):
    out, seen = [], set()
    if not log_path.is_file():
        return out
    pat = re.compile(r"^w: (?:file://)?(\S+?):(\d+):\d+ (.*)$")
    for line in log_path.read_text(errors="replace").splitlines():
        m = pat.match(line.strip())
        if not m:
            continue
        item = f"[kotlin] {rel(m.group(1))}:{m.group(2)} — {m.group(3)}"
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def emit(title, items):
    if not items:
        print(f"::notice title={title}::none")
        return
    chunks = [items[i:i + PER_ANNOTATION] for i in range(0, len(items), PER_ANNOTATION)][:MAX_ANNOTATIONS]
    for n, chunk in enumerate(chunks, 1):
        body = "\n".join(chunk).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::warning title={title} {n}/{len(chunks)} ({len(items)} total)::{body}")


if __name__ == "__main__":
    lint_xml = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "android/app/build/reports/lint-results-debug.xml"
    log = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/gradle-lint.log")
    if not lint_xml.is_file():
        found = sorted((ROOT / "android").glob("**/build/**/lint-results*.xml"))
        if found:
            lint_xml = found[0]
        else:
            print("::notice title=Android Lint::no XML report found")
    issues = lint_issues(lint_xml) + kotlin_warnings(log)
    emit("Android Lint + Kotlin warnings", issues)
