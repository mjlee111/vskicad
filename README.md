<p align="center"><img src="media/icon.png" alt="KiCad Preview logo" width="128"></p>

# KiCad Preview for Visual Studio Code

Preview KiCad schematics and PCBs, in 2D and 3D, inside Visual Studio Code.

![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.85-007ACC)
![KiCad](https://img.shields.io/badge/KiCad-10.x-314CB0)
![OS](https://img.shields.io/badge/OS-Windows%20%7C%20Ubuntu-lightgrey)
![Language](https://img.shields.io/badge/language-TypeScript-3178C6)
![License](https://img.shields.io/badge/license-MIT-green)

Author: Myeongjin Lee (menggu1234@naver.com)

## Overview

KiCad Preview opens `.kicad_sch` and `.kicad_pcb` files as read-only previews. It does not draw KiCad files itself. It calls `kicad-cli` from your KiCad installation, so every preview matches what KiCad produces. KiCad 10.x must be installed on the machine that runs the extension.

What you can do:

- View every sheet of a hierarchical schematic, with pan and zoom.
- View PCB layers in 2D, toggle each layer, and flip to the bottom side.
- Orbit the assembled board in 3D, with component models, shadows and ambient occlusion.
- Render a high-quality image of the current 3D view with KiCad's raytracer.
- See changes as soon as you save in KiCad.

```
 .kicad_sch / .kicad_pcb ──▶ extension ──▶ kicad-cli (your KiCad install)
                                              │  SVG (2D), GLB (3D), PNG (snapshot)
                                              ▼
                               preview tab in VS Code (2D / 3D)
```

### Supports

| Platform | Status | Notes |
|---|---|---|
| Ubuntu 24.04, KiCad 10.0.5 (PPA) | ![tested](https://img.shields.io/badge/-tested-brightgreen) | Development platform. Core integration tests and viewer checks run here. |
| Windows 10/11, KiCad 10.x | ![not tested](https://img.shields.io/badge/-not%20tested-yellow) | Supported by design. Only the `kicad-cli` detection logic has been tested. |
| Ubuntu, KiCad from Flatpak | ![not tested](https://img.shields.io/badge/-not%20tested-yellow) | Detected automatically. The Flatpak sandbox may block writes to the output folder. |
| VS Code Remote (SSH, WSL) | ![not tested](https://img.shields.io/badge/-not%20tested-yellow) | The extension runs on the remote host, so KiCad must be installed there. |
| KiCad 9.x or older | ![not supported](https://img.shields.io/badge/-not%20supported-red) | The extension warns and tries anyway. Results are not verified. |
| macOS | ![not supported](https://img.shields.io/badge/-not%20supported-red) | Not in scope. There is no automatic `kicad-cli` detection. |

## Contents

- [KiCad Preview for Visual Studio Code](#kicad-preview-for-visual-studio-code)
  - [Overview](#overview)
    - [Supports](#supports)
  - [Contents](#contents)
  - [Quick Start](#quick-start)
  - [1. Package Layout](#1-package-layout)
  - [2. Installation](#2-installation)
    - [2.1 Requirements](#21-requirements)
    - [2.2 Install KiCad (once per machine)](#22-install-kicad-once-per-machine)
    - [2.3 Install the extension (once per machine)](#23-install-the-extension-once-per-machine)
    - [2.4 Check](#24-check)
    - [2.5 Uninstall](#25-uninstall)
  - [3. Usage](#3-usage)
    - [3.1 Opening files](#31-opening-files)
    - [3.2 Schematic and PCB 2D view](#32-schematic-and-pcb-2d-view)
    - [3.3 PCB 3D view](#33-pcb-3d-view)
    - [3.4 Snapshot](#34-snapshot)
  - [4. Configuration](#4-configuration)
    - [4.1 Settings](#41-settings)
    - [4.2 kicad-cli detection](#42-kicad-cli-detection)
  - [5. Files and Data](#5-files-and-data)
  - [6. Troubleshooting](#6-troubleshooting)
  - [7. Performance](#7-performance)
  - [8. Known Limitations](#8-known-limitations)
  - [9. License](#9-license)
  - [10. Third-Party Notices](#10-third-party-notices)

## Quick Start

```bash
$ kicad-cli version                                # must print 10.x
$ code --install-extension vskicad-0.1.0.vsix
$ code my-board.kicad_pcb                          # opens the preview
```

```
10.0.5
```

Click **3D** in the preview toolbar for the 3D view. If the preview says that `kicad-cli` was not found, set its path as shown in §4.2.

## 1. Package Layout

The delivery is one file, `vskicad-0.1.0.vsix`. It contains:

```
vskicad-0.1.0.vsix
└── extension/
    ├── package.json         manifest: commands, editors, settings
    ├── README.md            this document
    ├── LICENSE.txt          MIT license (§9)
    ├── dist/extension.js    extension host code, runs kicad-cli
    ├── dist/webview.js      preview UI, includes three.js (§10)
    ├── media/icon.png       extension icon
    └── media/preview.css    preview UI styles
```

The extension has no runtime dependencies other than VS Code and KiCad.

## 2. Installation

### 2.1 Requirements

| Item | Requirement |
|---|---|
| VS Code | 1.85 or later |
| KiCad | 10.x, including `kicad-cli` |
| KiCad 3D models | Needed for component models in the 3D view |
| GPU | WebGL 2 in VS Code, which current GPUs and drivers provide |
| Network | Not used |

### 2.2 Install KiCad (once per machine)

**Ubuntu**

```bash
$ sudo add-apt-repository ppa:kicad/kicad-10.0-releases
$ sudo apt update
$ sudo apt install kicad kicad-packages3d
```

`kicad-cli` is part of the `kicad` package and installs to `/usr/bin/kicad-cli`.

**Windows**

Install KiCad 10 from the official installer at kicad.org. Keep the default location. The extension looks for `C:\Program Files\KiCad\<version>\bin\kicad-cli.exe`.

### 2.3 Install the extension (once per machine)

```bash
$ code --install-extension vskicad-0.1.0.vsix
```

Alternatively, open the Extensions view, choose **...** > **Install from VSIX...**, and select the file.

To update to a new build with the same version number, add `--force`:

```bash
$ code --install-extension vskicad-0.1.0.vsix --force
```

### 2.4 Check

Run **KiCad: Show kicad-cli Info** from the Command Palette. It shows the `kicad-cli` in use:

```
kicad-cli 10.0.5 (PATH): /usr/bin/kicad-cli
```

The **KiCad Preview** output channel logs the same detection:

```
kicad-cli 10.0.5 found via PATH: /usr/bin/kicad-cli
```

### 2.5 Uninstall

```bash
$ code --uninstall-extension menggu1234.vskicad
```

To remove leftover temporary files as well, delete the extension's storage folder (§5).

## 3. Usage

### 3.1 Opening files

- Opening a `.kicad_sch` or `.kicad_pcb` file shows the preview by default.
- To see the file as text, run **View: Reopen Editor With...** and choose **Text Editor**.
- From a text editor, use the preview button in the editor title bar, or **KiCad: Open Preview to the Side**.
- In the Explorer, right-click a KiCad file and choose **KiCad: Open Preview**.
- The preview updates when the file changes on disk. For a schematic, this includes every `.kicad_sch` file under the same folder. For a PCB, it includes only the board file.
- **Refresh** (toolbar or editor title bar) exports again and ignores the cache.

### 3.2 Schematic and PCB 2D view

| Action | Input |
|---|---|
| Zoom | Mouse wheel (around the cursor), `+` / `-` |
| Pan | Drag with the left or middle button |
| Fit to window | Double-click, `F`, or **Fit** |
| Change sheet | Drop-down in the toolbar (hierarchical schematics) |
| Show or hide layers | **Layers** panel check boxes, **All** / **None** |
| Bottom-side view | **Bottom** (mirrors the board and reverses the layer order) |

Copper, silkscreen and `Edge.Cuts` are visible at first. Mask and Fab layers are hidden and load when you first enable them, because Fab layers can be tens of MB on large boards.

### 3.3 PCB 3D view

Click **3D** in the toolbar, or run **KiCad: Show PCB 3D View**. The 3D model is exported the first time you open the tab. This can take tens of seconds on large boards (§7).

| Action | Input |
|---|---|
| Rotate | Left drag |
| Pan | Right drag |
| Zoom | Mouse wheel |
| Preset views | **Iso**, **Top**, **Bottom**, **Front**. Double-click returns to Iso. |
| Show or hide components | **Components** check box |
| Choose exported elements | **3D Options** (opens the settings in §4.1) |
| High-quality image | **Snapshot** (§3.4) |

Board layers are drawn opaque, as in KiCad's own renderer. Copper under the soldermask is therefore not visible. The status bar shows the number of component models and, if any, how many models KiCad could not find (§6).

### 3.4 Snapshot

**Snapshot** renders the current 3D view with KiCad's raytracer (`kicad-cli pcb render`), with floor, shadows and post-processing.

- A progress notification appears. Click **Cancel** there to stop the render.
- The image opens in a new tab beside the preview. Choose **Save As...** in the notification to keep it. The default name is `<board>-3d.png` in the board's folder.
- Images that you do not save are deleted after 24 hours.
- The rotation and zoom of your view are carried over. Panning is not: KiCad always renders around the board center.
- The image is requested 1920 pixels wide at the aspect ratio of the 3D view. `kicad-cli` 10.0.5 returns a slightly smaller image, for example 1904 x 784.
- Components, silkscreen and colors in the snapshot follow KiCad's own 3D viewer settings, not the `vskicad.3d.*` settings.

## 4. Configuration

### 4.1 Settings

Open **Settings** and search for `vskicad`.

| Setting | Default | Meaning |
|---|---|---|
| `vskicad.cliPath` | empty | Full path to `kicad-cli` (`kicad-cli.exe` on Windows). Empty means automatic detection (§4.2). |
| `vskicad.autoRefresh` | `true` | Export again when the KiCad file changes on disk |
| `vskicad.timeoutSeconds` | `180` | Time limit for one export, in seconds |
| `vskicad.schematic.theme` | empty | KiCad color theme for schematics. Empty uses the schematic editor setting. |
| `vskicad.pcb.layers` | `[]` | Layers for the 2D PCB view, for example `["F.Cu", "B.Cu", "Edge.Cuts"]`. Empty means all copper layers plus `F/B.SilkS`, `F/B.Mask`, `F/B.Fab` and `Edge.Cuts`. Layers that the board does not define are skipped. |
| `vskicad.pcb.theme` | empty | KiCad color theme for the 2D PCB view. Empty uses the PCB editor setting. |
| `vskicad.pcb.drillShape` | `actual` | Drill holes in the 2D PCB view: `none`, `small` or `actual` |
| `vskicad.3d.substituteModels` | `true` | Use STEP or IGS models in place of VRML models with the same name |
| `vskicad.3d.includeTracks` | `false` | Include tracks and vias in the 3D view |
| `vskicad.3d.includePads` | `false` | Include pads in the 3D view |
| `vskicad.3d.includeZones` | `false` | Include copper zones in the 3D view |
| `vskicad.3d.includeSilkscreen` | `false` | Include silkscreen in the 3D view |
| `vskicad.3d.includeSoldermask` | `false` | Include soldermask in the 3D view |

The `vskicad.3d.include*` settings make the 3D export much slower and larger. On a small demo board, enabling all of them raised the export time from 0.45 s to 3.2 s and the file size from 0.56 MB to 10.4 MB.

Changing a setting updates open previews, even when `vskicad.autoRefresh` is off.

### 4.2 kicad-cli detection

When `vskicad.cliPath` is empty, the extension tries the following locations in order and uses the first one that runs.

| Platform | Order |
|---|---|
| Windows | 1. `kicad-cli.exe` on `PATH`<br>2. `%ProgramFiles%\KiCad\<version>\bin\kicad-cli.exe`, highest version first<br>3. The same layout under `%ProgramFiles(x86)%` and `%LOCALAPPDATA%\Programs` |
| Ubuntu | 1. `kicad-cli` on `PATH`<br>2. `/usr/bin/kicad-cli`, `/usr/local/bin/kicad-cli`<br>3. Flatpak: `flatpak run --command=kicad-cli org.kicad.KiCad` |

When `vskicad.cliPath` is set, only that path is used. In `settings.json`, write Windows paths with double backslashes:

```jsonc
// Windows
"vskicad.cliPath": "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe"
// Ubuntu
"vskicad.cliPath": "/usr/bin/kicad-cli"
```

The path must point to the executable. A `.bat` or `.cmd` wrapper does not work, because the extension starts `kicad-cli` directly, without a shell.

## 5. Files and Data

- The extension never writes to your KiCad files. It only reads them.
- Exports are written to the extension's storage folder. Each preview tab has its own subfolder, which is deleted when the tab closes.
- Folders left behind by a crashed window, and unsaved snapshots, are deleted after 24 hours the next time the extension starts.
- The extension makes no network requests.

| Platform | Storage folder |
|---|---|
| Windows | `%APPDATA%\Code\User\globalStorage\menggu1234.vskicad\` |
| Ubuntu | `~/.config/Code/User/globalStorage/menggu1234.vskicad/` |

Inside it, `previews/` holds the SVG and GLB exports and `snapshots/` holds snapshot images.

## 6. Troubleshooting

Messages appear in a notification, in the preview, or in the **KiCad Preview** output channel. **Show Log** in the preview opens the output channel.

| Message | Cause | Fix |
|---|---|---|
| `kicad-cli was not found. Install KiCad 10.x or set 'vskicad.cliPath'.` | KiCad is not installed, or is installed in a location not listed in §4.2 | Install KiCad (§2.2) or set `vskicad.cliPath` (§4.2) |
| `Configured kicad-cli could not be run: <path>` | `vskicad.cliPath` points to a missing file, a wrapper script, or a non-executable file | Point it to `kicad-cli` or `kicad-cli.exe` itself, or clear it to use detection |
| `KiCad Preview is verified with KiCad 10.x only. Found kicad-cli <version>; previews may fail.` | An older or newer KiCad was found | Install KiCad 10.x, or set `vskicad.cliPath` to a 10.x `kicad-cli` |
| `<n> 3D model(s) not found (see log)` in the 3D status bar | The board refers to models through a path variable that KiCad does not define, such as `${KICAD6_3DMODEL_DIR}` or a custom variable | Define the variable in KiCad under **Preferences > Configure Paths**, then click **Refresh**. Setting a shell environment variable with the same name has no effect on `kicad-cli` 10.0.5. |
| `Only files on disk can be previewed (scheme '<scheme>').` | The file comes from a virtual source, such as a Git comparison view | Open the file from the Explorer |
| `Timed out after <n> s.` | The export took longer than `vskicad.timeoutSeconds` | Raise `vskicad.timeoutSeconds`, or disable `vskicad.3d.include*` settings |
| `No exportable layers found in the board file.` | `vskicad.pcb.layers` names layers that the board does not define | Use untranslated layer names such as `F.Cu`, or set the list to `[]` |
| `kicad-cli exited with code <n>.` | KiCad could not load or export the file | Open the file in KiCad to check it, and read the output channel for KiCad's message |
| `KiCad snapshot failed: <reason>` | The raytraced render failed or timed out | See the output channel. Raise `vskicad.timeoutSeconds` for large boards. |

Missing component models do not stop the preview. The board itself is still shown.

## 7. Performance

Measured on Ubuntu 24.04, KiCad 10.0.5, AMD Ryzen 9 9900X with integrated graphics. Frame times were measured with the preview UI in Chrome, not inside VS Code.

| Board | Operation | Result |
|---|---|---|
| KiCad demo `complex_hierarchy` | 2D PCB export | 0.2 s |
| KiCad demo `complex_hierarchy` | 3D export, default settings | 0.45 s |
| KiCad demo `jetson-agx-thor-baseboard`, 1125 footprints, 81 MB file | 2D PCB export, 17 layers | 4.1 s |
| Same board | 2D pan and zoom | 17 ms per frame |
| KiCad demo `vme-wren`, 1476 component models | 3D export | 17.7 s |
| Same board | 3D rotation | 16.7 ms per frame |
| 84-component board | Snapshot, 1400 x 620 | 1.5 s |

## 8. Known Limitations

- Only files on a local or remote disk can be previewed. Virtual documents are not supported.
- The PCB preview reacts to changes of the board file only. Use **Refresh** after changing 3D models or libraries.
- 2D coordinates are not shown. The 2D view is cropped to the board area.
- The snapshot rotation and zoom mapping was established with `kicad-cli` 10.0.5 and may differ in other versions.
- Flatpak KiCad, Windows and VS Code Remote have not been tested (see Supports).

## 9. License

Copyright (c) 2026 Myeongjin Lee.

Released under the MIT License. The full text is in [LICENSE](LICENSE). You may use, copy, modify and redistribute the software, provided the copyright and license notices, including those in §10, stay in place. The software is provided "as is", without warranty of any kind.

KiCad is a separate product of the KiCad project and is not part of this software. This extension is not affiliated with or endorsed by the KiCad project.

## 10. Third-Party Notices

`dist/webview.js` includes the following open-source component.

**three.js** (https://threejs.org), MIT License

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
