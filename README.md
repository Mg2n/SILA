# SILA — Connected Patient Flow

SILA is a hackathon prototype that connects the people around one emergency patient: a citizen or ambulance crew tells the hospital who is coming, the ER sees it live, and staff turn a bed from "blocked" to "ready" through cleaning, repairs and nursing sign-off — then move the patient to ICU with one accurate location at every step. Every change goes through a single rule engine that checks who may do what, so the cleaner cannot sign off a bed, a nurse cannot close a technical repair, and nothing is ever "decorative". It runs entirely in the browser, in English and Arabic, with synthetic data only.

> SILA is not an emergency service. It never calls for help, dispatches ambulances, diagnoses, triages or prescribes.

---

## Run it

| What | How |
|---|---|
| Open the app | Double-click **`dist/index.html`** (works from disk, offline, no server). Chrome or Edge recommended. |
| Rebuild after editing `src/` | `node build.js` → writes `dist/index.html` (app) and `dist/tests.html` (browser test page). Needs a recent Node (verified with Node 25); no packages to install. |
| Run the tests | `node src/run-tests-node.js` (80 tests) — or open `dist/tests.html` in a browser. |
| Start over | **Reset demo** in the header, or the guided demo's "Reset to clean demo data". |
| Develop with live modules | Serve the folder over HTTP (e.g. `python3 -m http.server`) and open `src/index.html`. |

## Demo accounts

Sign in with the **demo role switcher** in the header (simulated — there are no passwords). Citizens need no account; the device itself owns its notices.

| Name | Role | Hospital | Department / unit | Try this |
|---|---|---|---|---|
| Mariam Al-Harbi | ER coordinator / charge nurse | Wadi Noor | ER | Acknowledge incoming notices, reserve beds, assign a porter |
| Samuel Adeyemi | ER coordinator / charge nurse | Wadi Noor | ER | Second coordinator — use him in another tab to show live sync and conflicts |
| Daniel Okafor, Huda Saleh | Bedside nurse | Wadi Noor | ER | Report a fault, verify bed readiness, record triage, confirm placement |
| Dr. Faisal Rahman | Doctor | Wadi Noor | ER | Request an ICU transfer, record discharge / admission, order an investigation |
| Leena Haddad | ICU coordinator / charge nurse | Wadi Noor | ICU | Confirm ICU capacity, reserve the ICU bed, confirm a step-down departure |
| Grace Mensah, Omar Nasser, Aisha Karim | Bedside nurse | Wadi Noor | ICU | Verify ICU beds, receive handover, confirm ICU placement |
| Dr. Sara Lindqvist | Doctor (intensivist) | Wadi Noor | ICU | Accept or decline a transfer; flag a patient for ward step-down |
| Ahmed Yusuf | Housekeeping | Wadi Noor | — | Cleaning queue: accept, start, complete |
| Khalid Mansour | Maintenance technician | Wadi Noor | — | Technical faults (e.g. the ICU-06 power outlet) |
| Priya Nair | Biomedical technician | Wadi Noor | — | Equipment tickets (ER-07 monitor) and equipment checks |
| Noura Fahad | Diagnostics staff | Wadi Noor | — | Schedule an EEG and mark the report available |
| Samir Aziz | Transport / porter | Wadi Noor | — | Confirm pickup and drop-off of an ICU transfer — nothing else |
| Ravi Menon | Administrator | Wadi Noor | — | Read-only users table and audit log; every clinical button is refused |
| Yara Khoury | ER coordinator | Rimal | ER | Sees cases redirected to Rimal |
| Tariq Saeed, Hamad Al-Otaibi | Ambulance crew | — | Unit WN-A12 | Send a structured handover with vitals; update it; mark en route / arrived |
| Lina Farouk, Jamal Idris | Ambulance crew | — | Unit WN-A07 | A crew sees only its own unit's cases |
| *(no login)* | Citizen | — | this device | "I'm with a patient": voice or typed description → nearest hospital → send |

Three fictional hospitals: **Wadi Noor General Hospital** (12 ER beds, 8 ICU rooms — the main scenario), **Rimal Medical Center** and **Qasr Bay Hospital** (receive redirected cases).

## Real in the browser vs simulated

| Real (uses the browser) | Simulated (labelled "Simulated" in the app) |
|---|---|
| Speech recognition (Web Speech API) where the browser offers it — typed input always works | City map, distances, travel times and ETAs (fictional demo city) |
| Geolocation, only when you press "Use my location" — district list always works | Field extraction from speech/text (simple rules, not AI) |
| Storage in this browser (`localStorage`) — survives refresh | Public hospital capacity indicators |
| Live sync between open tabs (`BroadcastChannel`, `storage` events as fallback) | Notifications (shown inside SILA only; nothing is sent) |
| Arabic/English with right-to-left layout, Gregorian dates, Western digits | Sign-in and roles (a demo role switcher — not authentication) |

No audio is ever stored, and the app makes **no network requests** (verified — see checks below).

## Architecture

```
            ┌───────────────────────────── browser tab ─────────────────────────────┐
 user ──▶   │  UI (src/ui)  ──run(action)──▶  store (src/store.js)  ──▶  engine (src/actions.js)
 click      │   renders from state             persists + syncs          permission check (permissions.js)
            │   ◀──────── new state ─────────  localStorage ◀──────────  version check → validate → mutate
            │                                  BroadcastChannel          → audit → follow-ups → invariants
            └──────────────────────────────────────┬───────────────────────────────────┘
                                                   │ same state, live
                                          other open tabs
```

- **Engine** (`src/actions.js`, `permissions.js`, `readiness.js`, `selectors.js`, `data.js`, `vitals.js`): pure JavaScript. `dispatch(action, payload, user)` runs permission → stale-version check → validation → mutation on a copy → one audit event → follow-up tasks/notifications → consistency invariants, and only then commits. `preflight()` gives the UI the same verdict and reason, so disabled buttons explain themselves. Messages are codes (`{ code, params }`) rendered in the viewer's language.
- **Store** (`src/store.js`): one `localStorage` key, versioned schema, cross-tab sync, a commit check that refuses to overwrite another tab's newer write, and recovery from damaged saved data.
- **UI** (`src/ui/`): plain ES modules, no framework. Full re-render on every change, with focus, scroll and typed text preserved. Guided demo (`src/demo-script.js` + `src/ui/demo.js`) drives the same actions as the buttons.
- **Build** (`build.js`): a dependency-free bundler that inlines every module and the stylesheet into one self-contained `dist/index.html`.

## Permissions are simulated

Who may do what is enforced inside the engine (every action, every time — the UI cannot bypass it), but the *identity* is whatever the demo role switcher says. A real deployment needs a server that authenticates people and owns state, permissions and concurrency.

## Known limitations

- **Single-browser data.** State lives in one browser's `localStorage`; it is not shared between devices and is not a secure or transactional store. Two tabs committing in the *same instant* cannot be made atomic without a server: SILA refuses the later write when it can see it, and otherwise tells the losing tab "your last change was not kept" and shows the saved data.
- **Not verified in Safari or Firefox.** Checked in Chrome (Chrome for Testing 156) and the Claude desktop browser (Chromium). Firefox has no speech recognition; the typed path is the fallback there by design, but it was not run.
- **Arabic** was written for this prototype and should be reviewed by a native-speaking clinician before real use. Text people type is never translated.
- **Extraction** is rule-based and English/Arabic only; it is a demonstration, not an AI model.
- **Staff screens** are designed for desktop; they reflow to phone width but are dense there.
- **Surge mode** (mass-casualty / overflow coordination) is out of scope — a future step.

## Production readiness

A production system would need secure backend authentication and permissions, clinical governance and safety review, real integrations (ambulance dispatch, hospital ADT/bed management and EHR systems), privacy controls and data-protection compliance, reliable and audited synchronisation, and a deployment and security review.

## Checks performed (Task 7 release review)

Engine and store: **80/80 tests pass** (`node src/run-tests-node.js`, also in `dist/tests.html`). Browser checks were run in real Chrome (Chrome for Testing 156, fresh profile) against `dist/index.html` opened from disk.

| Check | Result |
|---|---|
| Every SPEC §16 acceptance item and every §17 amendment | Pass — mapped to named tests and browser steps in the Task 7 report |
| Clean start from `file://` with no site data | Pass — seeds itself, no console errors, DOMContentLoaded ≈ 0.1–0.2 s |
| Dead-button sweep (28 page/role states, 448 clicks) | Pass — every control navigates, opens something, dispatches or is disabled with a visible reason |
| Network requests during a full guided demo | **None** |
| Typed `<img onerror>`, `<script>`, 2,000-character text in concern, crew notes, comments, fault description | Shown as plain text everywhere (EN and AR); nothing executes. Fixed: long unbroken text no longer widens the page |
| Damaged saved data (bad JSON, missing fields, old schema) | Recovers with a clear message and a working reset. Fixed: hollow-but-valid JSON used to be accepted; recovery used to be silent |
| Fast-forwarded clock | Reservation expiry, overdue counts, "Updated X ago" and the ready-time forecast all move correctly |
| Two tabs on one bed | Realistic case: one succeeds, the other gets the clear stale-version message. Fixed: a same-instant double submit used to lose one write silently |
| Guided demo started on altered data, exited mid-way | Explains refusals, offers Skip, app fully usable afterwards |
| Location prompt never answered | Fixed: the app now gives up after 15 s and points to the district list |
| Size and speed | `dist/index.html` 786 KB (197 KB gzipped); first render ≈ 110 ms; typical action 8–20 ms |
