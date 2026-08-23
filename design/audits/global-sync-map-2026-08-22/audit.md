# Global sync map design audit

## Scope and user goal

Review of the proposed Files and Photos settings maps. The goal is to configure
the whole device network in one place without remembering separate per-device
send and receive settings.

## Step 1 — Photos map: promising, needs clearer route controls

The shared canvas, device list, selected-device inspector, and Files/Photos split
make the system visible. The arrows communicate direction well. The loose `+`
diamonds do not reveal whether they add a device, storage location, or route.
The Send/Receive/Move/Copy checkboxes mix direction with transfer behavior and
can create contradictory selections. Put the policy on the arrow and summarize
it as a sentence, such as `Phone Photos → Server Gallery: Move after verified
copy`.

## Step 2 — Files map: healthy empty state, but it needs guidance

The sparse canvas is appropriate before routes are created. Replace anonymous
diamonds with one labelled `Add device` action and visible connection handles on
each device. When the first device is placed, show a short prompt: `Drag another
device here, then connect them.` Keep Files and Photos as filters over one global
map rather than separate configurations.

## Highest-impact recommendations

1. Store and share one versioned global map across all paired devices.
2. Put direction and behavior on routes; keep device settings for identity and
   local folder locations.
3. Show device states directly on nodes: Online, Offline, Needs permission, or
   Changes waiting.
4. Make removal a Settings-only, confirmed `Remove from sync network` action;
   archive its history and never delete its files.
5. Provide undo for map edits and an impact preview before changing active
   routes.

## Accessibility and evidence limits

Do not rely on arrow direction or colour alone; every route needs a readable
label. Nodes and connection points need keyboard operation, visible focus, and
large targets. Drag-and-drop must have an equivalent `Connect devices` dialog.
These screenshots do not show focus behavior, contrast, resizing, error states,
or screen-reader output, so those require testing in the interactive prototype.
