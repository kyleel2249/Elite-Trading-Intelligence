import { commandPageFull } from "./views.ts";
import { addJournal } from "./journal-view.ts";

/** The complete command centre: base page + portfolio/scanner/session (views.ts) + journal/analytics (journal-view.ts). */
export function commandPageComplete(): string {
  return addJournal(commandPageFull());
}
