from __future__ import annotations

import hashlib
import json
import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
RUNTIME_JS = ["app.js", "productivity.js", "push-config.js", "service-worker.js"]
RUNTIME_CSS = ["ui-foundation.css", "productivity.css", "ui-rebuild.css"]


class DocumentInventory(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.handlers: list[tuple[str, str]] = []
        self.local_refs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if values.get("id"):
            self.ids.append(values["id"] or "")
        for name, value in attrs:
            if name.startswith("on") and value:
                self.handlers.append((name, value))
        ref = values.get("src") or values.get("href")
        if ref and not ref.startswith(("#", "data:", "mailto:", "tel:", "javascript:")):
            parsed = urlparse(ref)
            if not parsed.scheme and not parsed.netloc:
                self.local_refs.append(parsed.path)


checks: list[dict[str, object]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    row = {"name": name, "passed": bool(condition), "detail": detail}
    checks.append(row)
    print(("PASS" if condition else "FAIL"), name, detail)


html = (ROOT / "index.html").read_text(encoding="utf-8")
scripts = {name: (ROOT / name).read_text(encoding="utf-8") for name in RUNTIME_JS}
all_js = "\n".join(scripts.values())

for name in RUNTIME_JS:
    result = subprocess.run(
        ["node", "--check", str(ROOT / name)], capture_output=True, text=True, check=False
    )
    check(f"JavaScript syntax: {name}", result.returncode == 0, result.stderr.strip())

inventory = DocumentInventory()
inventory.feed(html)
duplicate_ids = sorted({item for item in inventory.ids if inventory.ids.count(item) > 1})
check("Unique HTML identifiers", not duplicate_ids, f"duplicates={duplicate_ids}")

missing_local_refs = sorted(
    ref for ref in set(inventory.local_refs) if ref and not (ROOT / ref).is_file()
)
check("Referenced local assets exist", not missing_local_refs, f"missing={missing_local_refs}")

dom_refs = set(re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]\s*\)", all_js))
missing_dom_refs = sorted(dom_refs - set(inventory.ids))
check("Static DOM references resolve", not missing_dom_refs, f"missing={missing_dom_refs}")

defined_functions = set(
    re.findall(r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", all_js)
)
defined_functions.update(
    re.findall(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(", all_js)
)
handler_calls: set[str] = set()
for _, expression in inventory.handlers:
    handler_calls.update(re.findall(r"(?:^|[;\s])([A-Za-z_$][\w$]*)\s*\(", expression))
ignored_handler_calls = {"if", "return", "event", "this", "Number", "String"}
missing_handlers = sorted(handler_calls - defined_functions - ignored_handler_calls)
check("Inline event handlers resolve", not missing_handlers, f"missing={missing_handlers}")

try:
    import tinycss2  # type: ignore

    for name in RUNTIME_CSS:
        rules = tinycss2.parse_stylesheet(
            (ROOT / name).read_text(encoding="utf-8"),
            skip_whitespace=True,
            skip_comments=True,
        )
        errors = [rule for rule in rules if getattr(rule, "type", None) == "error"]
        check(f"CSS parse: {name}", not errors, f"errors={len(errors)}")
except ModuleNotFoundError:
    # Dependency-free structural fallback for restricted release environments.
    for name in RUNTIME_CSS:
        source = (ROOT / name).read_text(encoding="utf-8")
        stripped = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
        depth = 0
        minimum_depth = 0
        quote: str | None = None
        escaped = False
        for char in stripped:
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
                continue
            if char in ("'", '"'):
                quote = char
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                minimum_depth = min(minimum_depth, depth)
        check(
            f"CSS structure: {name}",
            depth == 0 and minimum_depth == 0 and quote is None,
            f"brace_depth={depth}, minimum={minimum_depth}, open_quote={quote}",
        )

manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
check("Manifest has app identity", bool(manifest.get("name") and manifest.get("short_name")))
check(
    "Manifest starts inside the app",
    manifest.get("start_url") in (".", "./", "/", "index.html", "./index.html"),
)
missing_icons = sorted(
    icon.get("src", "")
    for icon in manifest.get("icons", [])
    if not icon.get("src") or not (ROOT / icon["src"]).is_file()
)
check("Manifest icons exist", bool(manifest.get("icons")) and not missing_icons, f"missing={missing_icons}")

service_worker = scripts["service-worker.js"]
check("Service worker has a remediation cache", "moaqib-remediation-6-1-0" in service_worker)
check(
    "Notification navigation is same-origin guarded",
    bool(re.search(r"\b\w+\.origin\s*===\s*self\.location\.origin", service_worker)),
)

app_js = scripts["app.js"]
productivity_js = scripts["productivity.js"]
check("Application version is 6.1.0 remediation", "APP_VERSION = '6.1.0-remediation'" in app_js)
check("Supabase client is exactly pinned", "@supabase/supabase-js@2.112.3" in html)
check("Chart client is exactly pinned", "chart.js@4.4.7/dist/chart.umd.min.js" in productivity_js)
check(
    "Runtime is Web/PWA only",
    not re.search(r"Capacitor|Firebase|MOAQIB_NATIVE_PUSH|nativePushBridge|nativeShellMode", all_js, re.I),
)
for phase_id in [
    "btn-reopen-transaction", "reversePaymentModal", "cloudConflictModal",
    "trash-list", "audit-list",
]:
    check(f"Phase-two UI contract: {phase_id}", phase_id in inventory.ids)
check(
    "Cloud writes compare the expected revision",
    ".eq('owner_id', user.id)" in app_js
    and ".eq('id', 1)" in app_js
    and ".eq('revision', cloudRevision)" in app_js,
)
check("Cloud conflicts stop silent overwrite", "handleCloudConflict(user.id, snapshot" in app_js)
check("Missing revision produces a migration gate", "schema-upgrade-required" in app_js and "SUPABASE_SECURITY_SETUP.sql" in app_js)
check("Critical saves have an audit helper", "function saveDataWithAudit(" in app_js and "db.auditLog.push(entry)" in app_js)
check("Transaction deletion is recoverable", "db.trash.transactions = [...previousTrash, deletedRecord]" in app_js)
check("Reversed payments are excluded from totals", "p?.status === 'reversed' ? sum" in app_js)
check("Payment receipts use stable references", "function buildPaymentReceiptRef(" in app_js and "receiptPayment.receiptRef" in app_js)

dangerous_patterns = {
    "eval(": "eval(",
    "document.write(": "document.write(",
    "localStorage.clear(": "localStorage.clear(",
}
for label, token in dangerous_patterns.items():
    occurrences = html.count(token) + sum(source.count(token) for source in scripts.values())
    check(f"Dangerous primitive absent: {label}", occurrences == 0, f"count={occurrences}")

sql = (ROOT / "SUPABASE_SECURITY_SETUP.sql").read_text(encoding="utf-8")
for label, token in {
    "RLS enabled": "enable row level security",
    "RLS forced": "force row level security",
    "Anonymous access revoked": "revoke all on table public.app_data from public, anon, authenticated",
    "Authenticated access explicit": "grant select, insert, update, delete on table public.app_data to authenticated",
    "Snapshot id matches client bigint contract": "id bigint not null default 1",
    "Incompatible legacy types abort": "incompatible app_data columns",
    "Legacy global id uniqueness aborts": "legacy uniqueness on id alone",
    "Owner check uses auth.uid": "auth.uid()) = owner_id",
    "Update has WITH CHECK": "for update\nto authenticated\nusing ((select auth.uid()) = owner_id)\nwith check ((select auth.uid()) = owner_id)",
    "Optimistic concurrency revision exists": "revision bigint not null default 0",
    "Revision cannot be negative": "check (revision >= 0)",
    "Single snapshot id is enforced": "check (id = 1)",
    "Legacy policies are fully replaced": "select policyname\n        from pg_policies",
    "Named legacy objects are verified": "has an unexpected definition",
    "Server enforces revision increments": "new.revision <> old.revision + 1",
    "Revision guard covers insert and update": "before insert or update on public.app_data",
}.items():
    check(f"Supabase SQL: {label}", token in sql.lower())

smoke_files = sorted(ROOT.glob("*_smoke.js"))
smoke_results: list[dict[str, object]] = []
for smoke in smoke_files:
    result = subprocess.run(
        ["node", smoke.name], cwd=ROOT, capture_output=True, text=True, check=False, timeout=45
    )
    smoke_results.append(
        {
            "file": smoke.name,
            "passed": result.returncode == 0,
            "output": (result.stdout + result.stderr).strip(),
        }
    )
    check(f"Functional smoke: {smoke.name}", result.returncode == 0)

hash_files = ["index.html", *RUNTIME_JS, *RUNTIME_CSS, "manifest.webmanifest", "SUPABASE_SECURITY_SETUP.sql"]
hashes = {
    name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    for name in hash_files
}

result = {
    "release": "6.1.0-remediation",
    "passed": sum(1 for item in checks if item["passed"]),
    "failed": sum(1 for item in checks if not item["passed"]),
    "total": len(checks),
    "checks": checks,
    "smoke_tests": smoke_results,
    "sha256": hashes,
}
(ROOT / "remediation_release_audit_result.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print("TOTAL", result["passed"], "/", result["total"])
raise SystemExit(0 if result["failed"] == 0 else 1)
