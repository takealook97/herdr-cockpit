# Themes

Three themes for the cockpit layout. Each defines the terminal colors (`background`, `foreground`, `selection`, `cursor`, 16 `ansi`) and every panel color the `theme()` API names: `surface`, `canvas`, `chrome`, `popover`, `raised`, `hover`, `selected`, `border`, `input`, `muted`, `dim`, `accent`, `accent_foreground`, `solid`, `solid_foreground`, `working`, `blocked`, `done`, `idle`, `unknown`.

| Theme | Look |
| --- | --- |
| `styx` | Very dark blue-black, calm, cold cyan accent. |
| `asphodel` | Muted grey-green dark, low glare, sage accent. |
| `elysium` | Light, warm paper white, soft gold accent (dark gold where it must carry text). |

## Pick one

- Theme menu, or the `app.theme {name}` command (for example `app.theme styx`).
- A layout's root `"theme": "styx"`, or `{ "light": "elysium", "dark": "styx" }` to follow the system appearance.
- `settings.json` `theme` fills layouts that set none.

`./scripts/install.sh --dry-run` shows what would be copied. The installer copies only these three files into `${HERDR_APP_HOME:-$HOME/.config/herdr-app}/themes` and refuses to replace a different file with the same name unless you pass `--force`.

## Contrast

WCAG 2.x ratios from the antislop-human checker formula. Targets: foreground 7:1 on chrome, surface, hover, selected and the terminal; muted 4.5:1 and dim 3:1 on chrome and surface; accent 3:1 on chrome with accent_foreground 4.5:1 on accent; working, blocked and done 3:1 on chrome; ANSI 1 to 15 at 4.5:1 on the terminal background. `ansi0` (black) is a decoration color and is only held to 1.5:1 so box drawing stays visible but quiet. `elysium` brights are not lighter than the normals: on a light background a lighter color would lose legibility.

| Theme | Pair | Colors | Ratio | Min | Result |
| --- | --- | --- | --- | --- | --- |
| asphodel | foreground/chrome | #d3dbd3 on #171c19 | 12.20 | 7 | PASS |
| asphodel | muted/chrome | #a2afa5 on #171c19 | 7.57 | 4.5 | PASS |
| asphodel | dim/chrome | #7e8d82 on #171c19 | 4.95 | 3 | PASS |
| asphodel | foreground/surface | #d3dbd3 on #1f2521 | 11.04 | 7 | PASS |
| asphodel | muted/surface | #a2afa5 on #1f2521 | 6.85 | 4.5 | PASS |
| asphodel | dim/surface | #7e8d82 on #1f2521 | 4.48 | 3 | PASS |
| asphodel | foreground/terminal | #d3dbd3 on #1a1f1c | 11.81 | 7 | PASS |
| asphodel | accent_foreground/accent | #121713 on #9fc79a | 9.60 | 4.5 | PASS |
| asphodel | solid_foreground/solid | #1a1f1c on #d3dbd3 | 11.81 | 7 | PASS |
| asphodel | accent/chrome | #9fc79a on #171c19 | 9.13 | 3 | PASS |
| asphodel | foreground/selected | #d3dbd3 on #38443c | 7.20 | 7 | PASS |
| asphodel | foreground/selection | #d3dbd3 on #34423a | 7.47 | 4.5 | PASS |
| asphodel | foreground/hover | #d3dbd3 on #303a34 | 8.34 | 7 | PASS |
| asphodel | working/chrome | #d9b866 on #171c19 | 9.04 | 3 | PASS |
| asphodel | blocked/chrome | #e08a7a on #171c19 | 6.65 | 3 | PASS |
| asphodel | done/chrome | #8fcf9a on #171c19 | 9.50 | 3 | PASS |
| asphodel | ansi0/terminal (decor only) | #38423b on #1a1f1c | 1.60 | 1.5 | PASS |
| asphodel | ansi1/terminal | #d98378 on #1a1f1c | 5.94 | 4.5 | PASS |
| asphodel | ansi2/terminal | #9bc88f on #1a1f1c | 8.79 | 4.5 | PASS |
| asphodel | ansi3/terminal | #d6bd7a on #1a1f1c | 9.09 | 4.5 | PASS |
| asphodel | ansi4/terminal | #85a9c9 on #1a1f1c | 6.78 | 4.5 | PASS |
| asphodel | ansi5/terminal | #b698bd on #1a1f1c | 6.54 | 4.5 | PASS |
| asphodel | ansi6/terminal | #7cbfb4 on #1a1f1c | 7.93 | 4.5 | PASS |
| asphodel | ansi7/terminal | #c3cdc4 on #1a1f1c | 10.23 | 4.5 | PASS |
| asphodel | ansi8/terminal | #7f8d83 on #1a1f1c | 4.81 | 4.5 | PASS |
| asphodel | ansi9/terminal | #e8a094 on #1a1f1c | 7.87 | 4.5 | PASS |
| asphodel | ansi10/terminal | #b4dca8 on #1a1f1c | 10.94 | 4.5 | PASS |
| asphodel | ansi11/terminal | #e6d094 on #1a1f1c | 10.99 | 4.5 | PASS |
| asphodel | ansi12/terminal | #a3c3dc on #1a1f1c | 9.07 | 4.5 | PASS |
| asphodel | ansi13/terminal | #cdb2d3 on #1a1f1c | 8.68 | 4.5 | PASS |
| asphodel | ansi14/terminal | #9ad3c9 on #1a1f1c | 9.97 | 4.5 | PASS |
| asphodel | ansi15/terminal | #e6ece6 on #1a1f1c | 13.93 | 4.5 | PASS |
| elysium | foreground/chrome | #2b2619 on #f1ead8 | 12.55 | 7 | PASS |
| elysium | muted/chrome | #5c5440 on #f1ead8 | 6.26 | 4.5 | PASS |
| elysium | dim/chrome | #7a705a on #f1ead8 | 4.08 | 3 | PASS |
| elysium | foreground/surface | #2b2619 on #f5efe0 | 13.13 | 7 | PASS |
| elysium | muted/surface | #5c5440 on #f5efe0 | 6.54 | 4.5 | PASS |
| elysium | dim/surface | #7a705a on #f5efe0 | 4.26 | 3 | PASS |
| elysium | foreground/terminal | #2b2619 on #faf6ec | 13.96 | 7 | PASS |
| elysium | accent_foreground/accent | #fffaf0 on #8a6a14 | 4.86 | 4.5 | PASS |
| elysium | solid_foreground/solid | #faf6ec on #2b2619 | 13.96 | 7 | PASS |
| elysium | accent/chrome | #8a6a14 on #f1ead8 | 4.21 | 3 | PASS |
| elysium | foreground/selected | #2b2619 on #e3d8bc | 10.63 | 7 | PASS |
| elysium | foreground/selection | #2b2619 on #ecdfae | 11.29 | 4.5 | PASS |
| elysium | foreground/hover | #2b2619 on #e8dfc8 | 11.35 | 7 | PASS |
| elysium | working/chrome | #8a6a14 on #f1ead8 | 4.21 | 3 | PASS |
| elysium | blocked/chrome | #b3392f on #f1ead8 | 4.94 | 3 | PASS |
| elysium | done/chrome | #2f7a4a on #f1ead8 | 4.37 | 3 | PASS |
| elysium | ansi0/terminal (decor only) | #4a4333 on #faf6ec | 9.08 | 1.5 | PASS |
| elysium | ansi1/terminal | #b3392f on #faf6ec | 5.49 | 4.5 | PASS |
| elysium | ansi2/terminal | #3f7a38 on #faf6ec | 4.80 | 4.5 | PASS |
| elysium | ansi3/terminal | #8a6a14 on #faf6ec | 4.69 | 4.5 | PASS |
| elysium | ansi4/terminal | #2f5f9e on #faf6ec | 5.98 | 4.5 | PASS |
| elysium | ansi5/terminal | #8a4a8f on #faf6ec | 5.63 | 4.5 | PASS |
| elysium | ansi6/terminal | #1f7a7a on #faf6ec | 4.72 | 4.5 | PASS |
| elysium | ansi7/terminal | #5f5844 on #faf6ec | 6.56 | 4.5 | PASS |
| elysium | ansi8/terminal | #6b6450 on #faf6ec | 5.46 | 4.5 | PASS |
| elysium | ansi9/terminal | #bd4237 on #faf6ec | 4.87 | 4.5 | PASS |
| elysium | ansi10/terminal | #417b3a on #faf6ec | 4.72 | 4.5 | PASS |
| elysium | ansi11/terminal | #866510 on #faf6ec | 5.01 | 4.5 | PASS |
| elysium | ansi12/terminal | #3d6fb0 on #faf6ec | 4.75 | 4.5 | PASS |
| elysium | ansi13/terminal | #94549a on #faf6ec | 4.87 | 4.5 | PASS |
| elysium | ansi14/terminal | #1d7a7a on #faf6ec | 4.73 | 4.5 | PASS |
| elysium | ansi15/terminal | #3b3526 on #faf6ec | 11.29 | 4.5 | PASS |
| styx | foreground/chrome | #d5def0 on #0a0f1c | 14.15 | 7 | PASS |
| styx | muted/chrome | #9aa8c4 on #0a0f1c | 7.99 | 4.5 | PASS |
| styx | dim/chrome | #7384a6 on #0a0f1c | 5.08 | 3 | PASS |
| styx | foreground/surface | #d5def0 on #101729 | 13.20 | 7 | PASS |
| styx | muted/surface | #9aa8c4 on #101729 | 7.46 | 4.5 | PASS |
| styx | dim/surface | #7384a6 on #101729 | 4.74 | 3 | PASS |
| styx | foreground/terminal | #d5def0 on #0b1020 | 14.01 | 7 | PASS |
| styx | accent_foreground/accent | #06101c on #5fb3d9 | 8.13 | 4.5 | PASS |
| styx | solid_foreground/solid | #0b1020 on #d5def0 | 14.01 | 7 | PASS |
| styx | accent/chrome | #5fb3d9 on #0a0f1c | 8.14 | 3 | PASS |
| styx | foreground/selected | #d5def0 on #22304f | 9.69 | 7 | PASS |
| styx | foreground/selection | #d5def0 on #1f3358 | 9.29 | 4.5 | PASS |
| styx | foreground/hover | #d5def0 on #1d2842 | 10.83 | 7 | PASS |
| styx | working/chrome | #e2b84f on #0a0f1c | 10.20 | 3 | PASS |
| styx | blocked/chrome | #f0707f on #0a0f1c | 6.68 | 3 | PASS |
| styx | done/chrome | #5ccfa0 on #0a0f1c | 9.92 | 3 | PASS |
| styx | ansi0/terminal (decor only) | #3a4766 on #0b1020 | 2.05 | 1.5 | PASS |
| styx | ansi1/terminal | #e06c80 on #0b1020 | 5.97 | 4.5 | PASS |
| styx | ansi2/terminal | #6fcf9f on #0b1020 | 10.01 | 4.5 | PASS |
| styx | ansi3/terminal | #e3c071 on #0b1020 | 10.86 | 4.5 | PASS |
| styx | ansi4/terminal | #6ea4ec on #0b1020 | 7.38 | 4.5 | PASS |
| styx | ansi5/terminal | #b58be0 on #0b1020 | 6.97 | 4.5 | PASS |
| styx | ansi6/terminal | #5ccfe0 on #0b1020 | 10.33 | 4.5 | PASS |
| styx | ansi7/terminal | #c5d0e6 on #0b1020 | 12.21 | 4.5 | PASS |
| styx | ansi8/terminal | #7385a8 on #0b1020 | 5.09 | 4.5 | PASS |
| styx | ansi9/terminal | #f08a9c on #0b1020 | 7.95 | 4.5 | PASS |
| styx | ansi10/terminal | #8fe3b8 on #0b1020 | 12.48 | 4.5 | PASS |
| styx | ansi11/terminal | #f0d68c on #0b1020 | 13.25 | 4.5 | PASS |
| styx | ansi12/terminal | #8fbcf5 on #0b1020 | 9.63 | 4.5 | PASS |
| styx | ansi13/terminal | #cfaaf0 on #0b1020 | 9.61 | 4.5 | PASS |
| styx | ansi14/terminal | #86e0ef on #0b1020 | 12.55 | 4.5 | PASS |
| styx | ansi15/terminal | #e8eef9 on #0b1020 | 16.25 | 4.5 | PASS |
