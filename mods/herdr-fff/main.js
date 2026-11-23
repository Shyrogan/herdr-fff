// herdr-fff: find a file with fff's fuzzy search, in the focused pane's
// repository. Type to search, Tab/Shift-Tab (or ↑/↓, ctrl+n/ctrl+p) to move,
// Enter to open, ctrl+g to switch between every file and the files git
// reports as changed, Esc to close. Click a tab or a file to pick it.
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

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, exec, focused, home, props, closeOverlay, run, notify, theme } from "herdr";

const ROWS = 12;
const ROW_HEIGHT = 28;
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
  untracked: ["U", "ansi2"],
  staged_new: ["A", "ansi2"],
  modified: ["M", "blocked"],
  staged_modified: ["M", "blocked"],
  renamed: ["R", "blocked"],
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

  // Characters of `text` as runs that look the same, matched or not.
  // `offset` is where `text` starts in the hit's path.
  runs(text, offset, matched) {
    const runs = [];
    [...text].forEach((c, i) => {
      const hit = matched.has(offset + i);
      const last = runs[runs.length - 1];
      if (last?.hit === hit) last.text += c;
      else runs.push({ hit, text: c });
    });
    return runs;
  }
  // One match, as a row of herdr's Files panel: a file icon, the file name,
  // its folder dimmed after it, its git status at the end. Matched
  // characters are in the accent color.
  row(t, hit, index, on) {
    const [mark, color] = STATUS[hit.status] ?? [null, null];
    const chars = [...hit.path];
    const slash = hit.path.lastIndexOf("/");
    const nameAt = slash < 0 ? 0 : [...hit.path.slice(0, slash)].length + 1;
    const matched = new Set();
    for (const [s, e] of hit.highlights) for (let i = s; i < e; i++) matched.add(i);
    const name = this.runs(chars.slice(nameAt).join(""), nameAt, matched);
    const dir = nameAt ? this.runs(chars.slice(0, nameAt - 1).join(""), 0, matched) : [];
    const part = (runs, base) =>
      runs.map((r) => div().flex_none().text_color(r.hit ? t.accent : base).child(r.text));
    return h_flex()
      .id(`fff-${index}`)
      .h(ROW_HEIGHT)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        this.selected = index;
        this.open();
      })
      .child(svg("mods/files/file.svg").size(14).flex_none().text_color(t.muted))
      .child(h_flex().flex_none().children(part(name, t.foreground)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().text_size(12).children(part(dir, t.dim)))
      .when(mark, (el) => el.child(div().flex_none().text_size(11).text_color(t[color] ?? t.dim).child(mark)));
  }

  // Files · Changed: the two lists ctrl+g switches between.
  tabs(t) {
    const tab = (label, changed) =>
      div()
        .id(`fff-tab-${label}`)
        .text_size(12)
        .cursor_pointer()
        .text_color(this.changed === changed ? t.foreground : t.dim)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.changed = changed;
          this.schedule(cx);
          cx.notify();
        })
        .child(label);
    return h_flex().flex_none().gap(10).child(tab("Files", false)).child(tab("Changed", true));
  }

  render() {
    const t = theme();
    const r = this.results;
    const hits = r?.hits ?? [];
    // The window of rows around the selection.
    const first = Math.max(0, Math.min(this.selected - Math.floor(ROWS / 2), hits.length - ROWS));
    const shown = hits.slice(first, first + ROWS);
    const repo = (r?.root ?? this.dir).split("/").filter(Boolean).pop() ?? "/";
    // What the list says when it has no rows.
    const empty = r?.error
      ? r.error
      : r === null || r.ready === false
        ? "Indexing…"
        : this.changed
          ? this.query ? "No changed file matches" : `No changes in ${repo}`
          : "No file matches";

    return v_flex()
      .id("herdr-fff")
      .w_full()
      .text_size(13)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        const ctrl = e.modifiers.control;
        if (e.key === "escape") return this.close();
        const back = e.key === "tab" && e.modifiers.shift;
        if (back || e.key === "up" || (ctrl && (e.key === "p" || e.key === "k"))) this.move(-1);
        else if (e.key === "tab" || e.key === "down" || (ctrl && (e.key === "n" || e.key === "j"))) this.move(1);
        else if (ctrl && e.key === "g") {
          this.changed = !this.changed;
          this.schedule(cx);
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      // The search field is the header, as the Files panel's title bar.
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.muted))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
          .child(this.tabs(t)),
      )
      .child(
        v_flex()
          .p(6)
          .when(shown.length > 0, (el) => el.children(shown.map((hit, i) => this.row(t, hit, first + i, first + i === this.selected))))
          .when(!shown.length, (el) =>
            el.child(div().p(8).text_size(12).text_color(r?.error ? t.ansi1 : t.dim).child(empty))),
      )
      .child(
        h_flex()
          .h(28)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(repo))
          .when(hits.length > 0, (el) => el.child(`${hits.length}${hits.length === 100 ? "+" : ""} matches`)),
      );
  }
}
