# Screenshots the README expects

> **Most of these are now captured by a script.** Run `node scripts/readme-shots.mjs` from
> `companion/` and it writes the whole `assets/readme/app-*.png` set, including the tester and
> the stick-tuning shots.
>
> **It needs a bridge plugged in and a controller connected.** The script synthesises controller
> *input* so the pages show live values, but bridge status comes from real hardware — with
> nothing plugged in, every page renders "Bridge not detected" and the shots are worthless as a
> showcase. The script does not check for this; look at what it produced before committing it.
>
> The two shots below are the exception: both want a specific multi-device arrangement that no
> script can conjure.

The main README references two app screenshots that need to be dropped into
this folder before publishing (the third visual, the architecture diagram, is
already here as an SVG). Save each PNG with the exact filename below.

You already captured perfect versions of both during the 2-Pico testing:

## `bridge-selector.png`
The **System page** with the sidebar **DEVICES** dropdown open or showing an
active named bridge — e.g. the shot reading **“Jay’s Controller (active)”** /
**“David’s Controller (active)”** with the controller art and firmware panel
visible. Shows: named bridges + the active selection.

## `device-list.png`
The sidebar **DEVICES** section showing a bridge plus the read-only
**“DualSense Edge — USB direct”** line — the shot that proves a
directly-connected USB controller is listed separately from the bridge and
never confused with it.

## Tips for clean shots
- Crop to the app window (no desktop/taskbar).
- Use the dark theme (default) so they match the diagram.
- PNG, roughly 1200–1600 px wide is plenty for README display.

Once both files are here, the README images render on GitHub with no further
changes.
