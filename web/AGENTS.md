# Prototype Instructions

Drive → Tags uses a horizontal, wrapping row of named tag filters with colored circle icons and All. Selecting a tag filters the existing file list/grid; All shows all tagged items, not untagged files. Search and sorting still apply. Use actual registered tags, never hard-coded demo categories in production.

Production UI must never imply unfinished operations work. Keep unavailable actions disabled with a reason; use live capability checks for external applications. Settings is its own top-level tab for devices, connections and storage, not a Drive sidebar item. Dashboard is information and immediate actions only; connection editing and hub preferences belong in Settings. Device hiding is reversible and must not conceal active connections; removing a connection must preserve files and verified history. Test startup with existing saved routes as well as empty catalogs: the same route ID must never appear twice, and each device pair has at most one enabled route per content category. Visually inspect every changed flow, including spacing, sorting controls and the teal toolbar menu.

Screenshots belong under Photos → Collections. Resolve the operating system's Pictures location (this user's is `~/Εικόνες/Screenshots`), never assume an English folder name. Show external screenshots in place without implying that they were imported or backed up. Keep per-file action icons alongside readable text. New contains scan, QR, tags, import and photo-library export; file templates belong in the Drive toolbar menu and come from its `.templates` folder.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Device visibility is Hide / Show again, with Visible and Hidden lists together inside Device management. Use “Remove device”, not “Delete device”, for removing the app configuration while retaining files. A separate removal-with-data-deletion action must state the exact data scope and require explicit confirmation; never infer whole-disk deletion.

Connection cards include Keep last year. The Copy/keep-originals explanation is small plain helper text beneath the controls, not a redundant button.

Sync scheduling belongs in Settings with once/daily/weekly/monthly recurrence and a chosen local date/time. On-time runs can copy automatically; missed/offline runs stay pending until the user presses Start. Phone intake may finish on the laptop while the final disk is absent, but keep phone originals. Surface persistent pending notices on the dashboard and notify on meaningful changes. Do not silently resume overdue work on reconnection or automatically bypass Move cleanup confirmation.

Connection maps use one straight directional line from the right side of the source card to the left side of the destination card. Show a clear arrowhead and an on-line info button with content type, Copy/Move, and either manual status or the schedule frequency, time and time zone. Do not show unused connection handles.

Cache belongs only on incoming connection cards whose receiver is a computer (Laptop, PC or Server). Direct outgoing computer-to-disk cards have no intermediate Cache. Availability must come from the backend, not a frontend assumption about phone brands or device labels. Put its limit under Advanced: percentage only, default 80%, measured against total disk usage including other files. No GB limit input. Pause new cache intake and notify at the limit; keep existing files when disabled.

Keep a backend/API/frontend parity inventory when moving native features into the web UI. Distinguish working native features missing an API bridge from backend operations that are still unsupported.
