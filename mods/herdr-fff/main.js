// herdr-fff: find a file with fff's fuzzy search, in the focused pane's
// repository. Type to search, ↑/↓ (or ctrl+n/ctrl+p) to move, Enter to open,
// Tab to switch between every file and the files git reports as changed,
// Esc to close.
//
// Open it with `mod.open:herdr-fff` in keys.json, or from another mod with
// openOverlay({ mod: "herdr-fff", props: { changed: true } }) to start on
// the changed files.
//
// Searches go to the herdr-fff binary (`herdr-fff search`), which keeps
// each repository's index in a server of its own. The binary is
// mods/herdr-fff/bin/herdr-fff when present, else herdr-fff on PATH.
// Enter opens the file in the tab's nvim with herdr-nvim when it is
// installed, else in nvim in a new pane on the right.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, exec, focused, home, props, closeOverlay, run, notify, theme } from "herdr";

const ROWS = 14;
const ROW_HEIGHT = 30;
// How long typing pauses before a search runs.
const DEBOUNCE_MS = 30;
// How often the results are asked for again while the first scan runs.
const SCANNING_MS = 250;

const localBin = () => `${appHome()}/mods/herdr-fff/bin/herdr-fff`;
const herdrNvim = () => `${appHome()}/mods/herdr-nvim/bin/herdr-nvim`;

// The binary that answered last: this mod's own copy, else herdr-fff on PATH.
let bin = null;

async function search(dir, query, changed) {
  const args = ["search", ...(changed ? ["--changed"] : []), dir, query];
  for (const candidate of bin ? [bin] : [localBin(), "herdr-fff"]) {
    let r;
    try {
      r = await exec(candidate, args);
    } catch {
      continue; // not there: try the next one
    }
    if (!bin && r.code !== 0 && /not found|no such file/i.test(r.stderr)) continue;
    bin = candidate;
    if (r.code !== 0) return { error: r.stderr.trim() || `herdr-fff exited with ${r.code}` };
    return JSON.parse(r.stdout);
  }
  return { error: "herdr-fff isn't installed: put it on PATH or in mods/herdr-fff/bin/" };
}

const STATUS = {
  untracked: ["?", "ansi2"],
  staged_new: ["A", "ansi2"],
  modified: ["M", "ansi3"],
  staged_modified: ["M", "ansi3"],
  renamed: ["R", "ansi3"],
  deleted: ["D", "ansi1"],
  staged_deleted: ["D", "ansi1"],
  ignored: ["!", "dim"],
};

export default class Finder extends View {
  init(_props, cx) {
    // Where it was opened: the folder searched and the tab a file opens in.
    const at = focused();
    this.at = at;
    this.dir = at?.cwd ?? home();
    this.changed = !!props()?.changed;
    this.query = "";
    this.results = null;
    this.selected = 0;
    this.seq = 0;

    this.input = InputState.new({ placeholder: "Find a file…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.schedule(cx);
    });
    this.input.on("submit", () => this.open());
    this.input.focus();
    // The overlay takes focus after init; take it back.
    cx.timer.after(100, () => this.input.focus());
    this.schedule(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  schedule(cx) {
    const seq = ++this.seq;
    cx.timer.after(DEBOUNCE_MS, (cx) => {
      if (seq === this.seq) this.refresh(cx, seq);
    });
  }

  refresh(cx, seq) {
    cx.spawn(async (cx) => {
      const results = await search(this.dir, this.query, this.changed);
      // A newer search was asked for meanwhile: this one is stale.
      if (seq !== this.seq) return;
      const before = this.results?.hits?.[this.selected]?.path;
      this.results = results;
      const kept = results.hits?.findIndex((h) => h.path === before) ?? -1;
      this.selected = kept >= 0 ? kept : 0;
      cx.notify();
      if (results.ready === false) {
        cx.timer.after(SCANNING_MS, (cx) => {
          if (seq === this.seq) this.refresh(cx, seq);
        });
      }
    });
  }

  move(by) {
    const n = this.results?.hits?.length ?? 0;
    if (n) this.selected = (this.selected + by + n) % n;
  }

  async open() {
    const hit = this.results?.hits?.[this.selected];
    if (!hit) return;
    const file = `${this.results.root}/${hit.path}`;
    this.close();
    if (this.at) {
      try {
        const r = await exec(herdrNvim(), ["open", "--tab", this.at.tab, "--space", this.at.space, file]);
        if (r.code === 0) return;
      } catch {
        // No herdr-nvim: fall through.
      }
    }
    run("terminal.open", { argv: ["nvim", file], folder: this.results.root, place: "right" });
  }

  row(t, hit, on) {
    const [mark, color] = STATUS[hit.status] ?? [" ", "dim"];
    const chars = [...hit.path];
    const nameAt = hit.path.lastIndexOf("/") + 1;
    const matched = new Set();
    for (const [s, e] of hit.highlights) for (let i = s; i < e; i++) matched.add(i);
    // Runs of characters that look the same: folder or name, matched or not.
    const runs = [];
    chars.forEach((c, i) => {
      const kind = `${i < nameAt ? "dir" : "name"}:${matched.has(i)}`;
      const last = runs[runs.length - 1];
      if (last?.kind === kind) last.text += c;
      else runs.push({ kind, text: c });
    });
    return h_flex()
      .h(ROW_HEIGHT)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .rounded(7)
      .when(on, (el) => el.bg(t.hover))
      .child(div().w(12).flex_none().font_family("monospace").text_color(t[color] ?? t.dim).child(mark))
      .child(
        h_flex().flex_1().min_w(0).overflow_hidden().children(
          runs.map((r) => {
            const [part, hit] = r.kind.split(":");
            return div()
              .flex_none()
              .text_color(hit === "true" ? t.accent : part === "dir" ? t.dim : t.foreground)
              .when(hit === "true" || part === "name", (d) => d.font_semibold())
              .child(r.text);
          }),
        ),
      );
  }

  render() {
    const t = theme();
    const hits = this.results?.hits ?? [];
    // The window of rows around the selection.
    const first = Math.max(0, Math.min(this.selected - Math.floor(ROWS / 2), hits.length - ROWS));
    const shown = hits.slice(first, first + ROWS);
    const status = this.results?.error
      ? this.results.error
      : this.results === null || this.results.ready === false
        ? "indexing…"
        : `${hits.length}${hits.length === 100 ? "+" : ""} files`;

    return v_flex()
      .id("herdr-fff")
      .size_full()
      .min_h(0)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const ctrl = e.modifiers.control;
        if (e.key === "escape") return this.close();
        if (e.key === "down" || (ctrl && (e.key === "n" || e.key === "j"))) this.move(1);
        else if (e.key === "up" || (ctrl && (e.key === "p" || e.key === "k"))) this.move(-1);
        else if (e.key === "tab") {
          this.changed = !this.changed;
          this.schedule(cx);
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(this.changed ? "Changed files" : "Files"))
          .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.results?.root ?? this.dir))
          .child(div().text_size(11).text_color(this.results?.error ? t.ansi1 : t.dim).child(status)),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(v_flex().flex_1().min_h(0).children(shown.map((hit, i) => this.row(t, hit, first + i === this.selected))))
      .child(div().text_size(11).text_color(t.dim).child("⏎ open   ↑↓ move   ⇥ files / changed   esc close"));
  }
}
