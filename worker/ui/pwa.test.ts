import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { PWA_ICON, PWA_JS, PWA_MANIFEST, PWA_SERVICE_WORKER, withPwa } from "./pwa.ts";

test("PWA manifest is installable and defines the ETI standalone app", () => {
  const manifest = JSON.parse(PWA_MANIFEST);
  assert.equal(manifest.name, "ETI — Elite Trading Intelligence");
  assert.equal(manifest.short_name, "ETI");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.theme_color, "#080d16");
  assert.ok(manifest.icons.some((icon: any) => icon.src === "/app-icon.svg" && icon.purpose.includes("maskable")));
});
test("PWA browser and service-worker scripts parse without external dependencies", () => {
  const browser = PWA_JS.replace(/^<script[^>]*>/, "").replace(/<[/]script>$/, "");
  assert.doesNotThrow(() => new vm.Script(browser));
  assert.doesNotThrow(() => new vm.Script(PWA_SERVICE_WORKER));
});
test("PWA shell supports install prompts, iOS home-screen guidance, offline navigation and push event display", () => {
  assert.match(PWA_JS, /beforeinstallprompt/);
  assert.match(PWA_JS, /Add to Home Screen/);
  assert.match(PWA_JS, /serviceWorker\.register/);
  assert.match(PWA_SERVICE_WORKER, /request\.mode==="navigate"/);
  assert.match(PWA_SERVICE_WORKER, /url\.pathname\.startsWith\("\/api\/"\)\)return/);
  assert.match(PWA_SERVICE_WORKER, /addEventListener\("push"/);
  assert.match(PWA_SERVICE_WORKER, /showNotification/);
});
test("PWA layer injects mobile styles and install metadata without changing non-app pages", () => {
  const page = "<html><head></head><body><main>ETI</main></body></html>";
  const result = withPwa(page);
  assert.match(result, /rel="manifest"/);
  assert.match(result, /apple-mobile-web-app-capable/);
  assert.match(result, /eti-install-app/);
  assert.match(result, /safe-area-inset/);
  assert.equal(withPwa("<html><body>missing head</body></html>"), "<html><body>missing head</body></html>");
  assert.match(PWA_ICON, /<svg[^>]+viewBox="0 0 512 512"/);
});
