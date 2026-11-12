/**
 * Command Centre navigation links to the Daily Intelligence Report (/daily) and the ETI Pro dashboard (/pro).
 * Replaces the disabled "Reports soon" roadmap item by exact-marker replacement, like views.ts. Unlike views.ts it never throws:
 * if the marker disappears from page.ts the page is served unchanged and reportLinksApplied() tells the tests.
 */
export const NAV_REPORTS_OLD = `<a class="item soon" aria-disabled="true" title="Not built yet">Reports <em>soon</em></a>`;
export const NAV_REPORTS_NEW = `<a class="item" href="/daily">Reports: Daily Intelligence</a>\n <a class="item" href="/pro">ETI Pro Dashboard</a>`;

export function withReportLinks(html: string): string {
  return html.includes(NAV_REPORTS_OLD) ? html.replace(NAV_REPORTS_OLD, () => NAV_REPORTS_NEW) : html;
}
export const reportLinksApplied = (html: string) => html.includes('href="/daily"') && html.includes('href="/pro"') && !html.includes("Reports <em>soon</em>");
