"""Secret scanning: finds credential material that must never be committed (PEM private keys, raw 32-byte hex/base64 key
assignments, cloud keys, seed-phrase-looking lines, Fernet keys assigned to config names). Used by CI (`python -m
app.governance.secretscan`) and by a test over the repository, so a leaked secret fails the build.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

PATTERNS = {
    "pem_private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----"),
    "aws_access_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "github_token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "slack_token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    "hex_private_key_assignment": re.compile(r"(?i)(?:private[_-]?key|priv[_-]?key|secret[_-]?key)\s*[:=]\s*[\"']?(?:0x)?[0-9a-f]{64}\b"),
    "fernet_key_assignment": re.compile(r"(?i)(?:vault|governance)[_-]?key\s*[:=]\s*[\"'][A-Za-z0-9_-]{43}=[\"']"),
    "seed_phrase_assignment": re.compile(r"(?i)(?:mnemonic|seed[_ ]?phrase)\s*[:=]\s*[\"'](?:[a-z]{3,8} ){11,23}[a-z]{3,8}[\"']"),
}
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".claude", ".wrangler", "dist"}
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pyc", ".db", ".sqlite", ".zip", ".gz", ".pdf"}
MARK = "scan:allow"        # a line carrying this marker is an intentional, documented test vector


def scan_text(text: str, name: str = "<text>") -> list[dict]:
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if MARK in line:
            continue
        for rule, rx in PATTERNS.items():
            if rx.search(line):
                out.append({"file": name, "line": i, "rule": rule})
    return out


def scan_tree(root: str) -> list[dict]:
    found = []
    for p in Path(root).rglob("*"):
        if not p.is_file() or p.suffix.lower() in SKIP_SUFFIX or any(part in SKIP_DIRS for part in p.parts):
            continue
        try:
            if p.stat().st_size > 2_000_000:
                continue
            found += scan_text(p.read_text(errors="ignore"), str(p.relative_to(root)))
        except OSError:
            continue
    return found


if __name__ == "__main__":
    hits = scan_tree(sys.argv[1] if len(sys.argv) > 1 else ".")
    for h in hits:
        print(f"{h['file']}:{h['line']}: {h['rule']}")
    sys.exit(1 if hits else 0)
