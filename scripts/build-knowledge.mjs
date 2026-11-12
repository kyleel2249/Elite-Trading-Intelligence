// Builds worker/knowledge.generated.json from the Python registry (app/knowledge).
// Never fails the build: without Python it keeps an existing file or writes an empty stub,
// and the Worker then reports source "built-in-fallback" instead of failing silently.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "worker", "knowledge.generated.json");
const script = join(root, "scripts", "export_knowledge.py");
const candidates = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];

let ok = false;
for (const [cmd, ...pre] of candidates) {
  const r = spawnSync(cmd, [...pre, script], { cwd: root, encoding: "utf8" });
  if (r.status === 0) { process.stdout.write(r.stdout); ok = true; break; }
}
if (!ok) {
  if (existsSync(out)) console.warn("[knowledge] Python unavailable; keeping existing worker/knowledge.generated.json");
  else {
    writeFileSync(out, JSON.stringify({ generatedAt: null, source: "unavailable", profiles: [], strategies: [] }));
    console.warn("[knowledge] Python unavailable; wrote an empty stub. The API will use built-in profiles.");
  }
}
process.exit(0);
