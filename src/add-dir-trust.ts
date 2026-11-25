// The `--add-dir` trust dialog (parity round 26, item 238).
//
// Since CLI 2.1.326 a folder passed with `--add-dir` that claude does not trust yet opens a dialog
// before the main screen: "Adding a new directory: <dir> … No, exit · Yes, add it". Measured live on
// claude 2.1.330 (2026-11-24): the default is "No, exit"; Enter and Esc both end the process (Esc
// prints "start again with the same flags but without --add-dir <dir>"); typing `2` adds the folder
// and the session goes on. Unanswered, the dialog swallows the first prompt and the turn waits for
// the watchdog.
//
// The dialog appears during `session/new`, before the client knows the session id, so it cannot be
// asked then. This module only WATCHES the PTY and remembers which folder the open dialog names; the
// agent asks the client at the first prompt and answers through {@link answerTrustDialog}.

/** Text the CLI prints at the top of the dialog (2.1.330). */
export const TRUST_DIALOG_MARKER = "Adding a new directory:";
/** Keystroke that picks "Yes, add it" (the second option; measured on 2.1.330). */
export const TRUST_YES_KEY = "2";
/** Keystroke that cancels the dialog, which ends the claude process (measured on 2.1.330). */
export const TRUST_NO_KEY = "\x1b";
/** Footer text of claude's main screen: once seen, no dialog is open. */
export const MAIN_SCREEN_MARKERS = ["? for shortcuts", "shift+tab to cycle"];
/** How long the first prompt waits for claude's startup screen before it is sent anyway. */
export const DEFAULT_TRUST_SETTLE_MS = 8000;

/** The PTY surface this module needs (structurally satisfied by node-pty's IPty). */
export interface TrustPty {
  onData(listener: (data: string) => void): { dispose(): void };
  write(data: string): void;
}

/** Strip ANSI control sequences and collapse whitespace, so markers match across redraws. */
export function screenText(raw: string): string {
  // These patterns match terminal escape sequences (ESC/BEL), never printable text, so
  // no-control-regex is a false positive here (the model-catalog.ts precedent).
  /* eslint-disable no-control-regex */
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b\][^\x07]*\x07/g, " ")
    .replace(/\x1b[()][0-9A-B]/g, " ")
    .replace(/\x1b[=>]/g, " ")
    .replace(/\s+/g, " ");
  /* eslint-enable no-control-regex */
}

/** The folder `text` names after the dialog marker, matched against the folders the session added.
 *  The CLI may print a home folder as `~/…`; the longest match wins, so `/a/b` beats `/a`. */
export function dialogDirectory(
  text: string,
  dirs: readonly string[],
  home: string,
): string | undefined {
  const at = text.lastIndexOf(TRUST_DIALOG_MARKER);
  if (at === -1) return undefined;
  const tail = text.slice(at + TRUST_DIALOG_MARKER.length).replace(/\s+/g, "");
  let best: string | undefined;
  for (const dir of dirs) {
    const shown = home && dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
    const candidates = [dir, shown].map((d) => d.replace(/\s+/g, ""));
    if (candidates.some((c) => tail.startsWith(c)) && (!best || dir.length > best.length)) {
      best = dir;
    }
  }
  return best;
}

/**
 * Watches one claude PTY from spawn for the trust dialog. `pending()` names the folder of an open
 * dialog; `settled()` resolves once claude reached its main screen, opened a dialog, exited, or
 * `settleMs` passed. The tap is removed as soon as the main screen shows with no dialog open.
 */
export class AddDirTrustWatcher {
  private buffer = "";
  private openDir: string | undefined;
  private mainScreen = false;
  private subscription: { dispose(): void } | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly pty: TrustPty,
    private readonly dirs: readonly string[],
    private readonly home: string,
  ) {
    this.subscription = pty.onData((data) => this.feed(data));
  }

  private feed(data: string): void {
    this.buffer = (this.buffer + screenText(data)).slice(-8192);
    const dir = dialogDirectory(this.buffer, this.dirs, this.home);
    if (dir) {
      this.openDir = dir;
      this.mainScreen = false;
    } else if (MAIN_SCREEN_MARKERS.some((m) => this.buffer.includes(m))) {
      this.mainScreen = true;
      this.openDir = undefined;
      this.dispose();
    }
    if (this.openDir || this.mainScreen) this.wake?.();
  }

  /** The folder an open dialog names, if one is open. */
  pending(): string | undefined {
    return this.openDir;
  }

  /** Whether claude reached its main screen with no dialog open. */
  done(): boolean {
    return this.mainScreen;
  }

  /** Resolves once a dialog is open, the main screen showed, or `settleMs` passed. */
  settled(settleMs: number, schedule: (fn: () => void, ms: number) => void): Promise<void> {
    if (this.openDir || this.mainScreen) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.wake = undefined;
        resolve();
      };
      this.wake = finish;
      schedule(finish, settleMs);
    });
  }

  /** Answer the open dialog: `2` keeps the folder, Esc refuses it (and ends claude). */
  answer(trust: boolean): void {
    this.pty.write(trust ? TRUST_YES_KEY : TRUST_NO_KEY);
    // The screen redraws after the answer; forget what was read so the same dialog is not
    // matched twice and a dialog for the next folder is recognised on its own.
    this.buffer = "";
    this.openDir = undefined;
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
  }
}
