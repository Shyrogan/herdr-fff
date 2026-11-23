# herdr-fff

Find files in the [Herdr](https://herdr.dev) desktop app with [fff](https://github.com/dmtrKovalenko/fff), the search engine behind fff.nvim.

One key opens a picker over the window. It searches the repository of the focused pane: type a few letters of a path, and the best matches come first, ranked by fff's fuzzy matching and by how often you open each file. `Ctrl-g` switches to the files git reports as changed (modified, added or untracked). `Enter` opens the file in the tab's nvim.

## How it works

herdr-fff has two parts:

- **A Herdr mod** (`mods/herdr-fff/`) draws the picker natively in the app.
- **A binary** (`herdr-fff`) does the searching. The mod runs `herdr-fff search` for each query. The first search starts a small server that keeps each repository's fff index in memory and watches the repository for changes, so later searches answer in a few milliseconds. Client and server talk over a Unix socket, `$XDG_RUNTIME_DIR/herdr-fff.sock`. The server stops after an hour without a search.

If you use fff.nvim, herdr-fff reads a copy of its frecency database (`~/.cache/nvim/fff_nvim`), so the files you open most in nvim rank first here too.

`Enter` opens the file with [herdr-nvim](https://github.com/ChmaraX/herdr-nvim) in the tab's nvim when herdr-nvim is installed. Otherwise it opens the file in nvim, in a new pane to the right.

## Install

### With Nix

The flake's package has the binary in `bin/` and the mod in `share/herdr-fff/mods/herdr-fff/`. With home-manager:

```nix
{inputs, pkgs, ...}: let
  herdr-fff = inputs.herdr-fff.packages.${pkgs.stdenv.hostPlatform.system}.default;
in {
  xdg.configFile = {
    "herdr-app/mods/herdr-fff/main.js".source = "${herdr-fff}/share/herdr-fff/mods/herdr-fff/main.js";
    "herdr-app/mods/herdr-fff/mod.json".source = "${herdr-fff}/share/herdr-fff/mods/herdr-fff/mod.json";
    "herdr-app/mods/herdr-fff/bin/herdr-fff".source = "${herdr-fff}/bin/herdr-fff";
  };
}
```

Link the files one by one rather than the whole folder: Herdr writes its type files into the mod folder.

### From source

```sh
cargo build --release
mkdir -p ~/.config/herdr-app/mods/herdr-fff/bin
cp mods/herdr-fff/* ~/.config/herdr-app/mods/herdr-fff/
cp target/release/herdr-fff ~/.config/herdr-app/mods/herdr-fff/bin/
```

Building needs libgit2 (through the `git2` crate). The mod looks for the binary in `mods/herdr-fff/bin/` first, then on `PATH`.

## Use

Bind a key in `~/.config/herdr-app/keys.json`:

```json
{
  "global": {
    "alt-p": "mod.open:herdr-fff"
  }
}
```

To open on the changed files directly, open the mod from another mod with props:

```js
openOverlay({ mod: "herdr-fff", props: { changed: true } });
```

| Key | Does |
| --- | --- |
| type | search the repository |
| `Tab` `Shift-Tab`, `↑` `↓`, `ctrl-n` `ctrl-p` | move |
| `Enter` | open the file |
| `Ctrl-g` | switch between all files and changed files |
| `Esc` | close |

fff's query syntax works too: `git:modified`, `src/`, `!test/`, or globs like `**/*.rs`.

## From the command line

```sh
herdr-fff search [--changed] DIR [QUERY]   # one search, as a line of JSON
herdr-fff serve                            # run the server in the foreground
```

A search runs in the repository holding `DIR` (the nearest folder with `.git`), or in `DIR` itself outside a repository. It refuses `/` and your home folder, which are too big to index.

## License

MIT
