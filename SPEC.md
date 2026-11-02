# SILA — Connected Patient Flow: Product Specification

Build a polished, fully interactive hackathon prototype called **SILA — Connected Patient Flow**, connecting citizens, ambulance teams, emergency departments, and intensive care units.

The central idea is:

**A patient's journey begins before arrival. Information captured by a citizen or paramedic becomes a structured arrival card for the receiving ER. Hospital staff then coordinate patient movement, beds, staffing, cleaning, equipment, and maintenance. ER and ICU share the same operational picture, with clear responsibilities for every staff role.**

Deliver working software, not screenshots or a dashboard with decorative buttons.

## 1. Deliverable and technical approach

Create a complete, self-contained `index.html` with embedded CSS and JavaScript, suitable for opening locally in a modern browser.

* Use realistic synthetic data only.
* Make the prototype usable without API keys or a backend.
* Persist demo data using localStorage.
* Synchronize changes between open tabs using BroadcastChannel, with a storage-event fallback.
* Include a clearly labeled demo role switcher so judges can experience different staff accounts.
* Include "Reset demo" and "Run guided demo" controls.
* Keep the code organized into data, permissions, state transitions, rendering, and event-handling sections.
* Use inline SVG illustrations and icons so the interface remains attractive without external image dependencies.
* Use real browser capabilities where practical, with working fallbacks when unavailable.
* Explain that the prototype's role checks simulate permissions; production authentication, authorization, and multiuser synchronization require a server.

Do not stop at a plan. Produce the complete implementation. If file creation tools are available, create the file directly.

## 2. Product structure

Create three main entry points:

1. **Citizen / accompanying person**
2. **Ambulance / paramedic**
3. **Hospital staff**

Hospital staff can access ER or ICU according to their account permissions.

Use a fictional hospital network with at least three hospitals. Hospital staff see only their hospital's patient-level information. Citizens see public hospital information and their own submission. Ambulance crews see their assigned cases and destination acknowledgments.

Provide English and Arabic interface switching, including correct RTL layout. At minimum, translate all primary navigation, buttons, status labels, intake questions, and demo guidance.

## 3. Visual direction

Make SILA feel like a coherent healthcare coordination product.

* Use a calm navy, teal, and white palette.
* Reserve red for urgent alerts and major blockers, amber for pending work, and green for verified readiness.
* Use generous spacing, readable typography, rounded cards, and restrained shadows.
* Combine color with text and icons; never rely on color alone.
* Include original inline SVG illustrations of an ambulance, hospital, microphone, bed, nurse, cleaning cart, and maintenance tools.
* Include an attractive welcome screen with two prominent citizen and ambulance cards, plus a hospital staff entry.
* Use small ambulance illustrations on incoming patient cards and a subtle animated ambulance marker on the demo route.
* Provide an operational bed map, incoming patient board, task queues, and timelines.
* Keep decorative illustrations out of the way of important clinical and operational information.
* Use responsive layouts: mobile-first for citizens and ambulance crews, desktop-friendly for hospital operations.
* Provide visible keyboard focus, accessible labels, readable contrast, reduced-motion support, and clear empty/error states.

The interface should feel suitable for a serious hackathon presentation, with realistic content and working interactions.

## 4. Citizen voice-assisted intake

Create a simple journey for someone accompanying a patient.

### Step A: Start a case

Offer:

* "Describe the situation by voice"
* "Type the details"
* "Try a sample case"

Explain that this prototype submits an arrival notice; it does not dispatch an ambulance or guarantee a hospital place.

Provide a visible emergency-services action, with the contact configured for the selected region rather than inventing a universal phone number. Do not make a real call from the demo.

### Step B: Capture information

Provide a conversational intake interface that can collect:

* Patient age or approximate age.
* Main concern in the caller's own words.
* When the problem started, if known.
* Whether the caller reports the patient is awake and breathing.
* Relevant conditions or allergies, if known.
* Number of patients.
* Current location.
* Transport mode.
* Contact details, optional in the demo.
* Additional assistance or accessibility needs.

Do not require a name or complete medical history before allowing submission.

Use browser speech recognition when supported. Include microphone permission handling, start/stop controls, an editable transcript, and a text fallback.

Do not imply that native speech recognition works offline or in every browser.

### Step C: Turn the transcript into a reviewed card

Create a structured preview from the transcript.

For the offline demo, use transparent rule-based extraction and sample scenarios. Label it "Demo extraction" rather than pretending it is a connected AI model.

* Show extracted fields alongside the original transcript.
* Leave missing information as "Unknown."
* Let the user correct every field.
* Require review before submitting.
* Identify the information as citizen-reported and clinically unverified.
* Do not invent vital signs, diagnoses, or triage levels.
* Preserve the original transcript for authorized staff.

### Step D: Show nearby hospitals

Allow browser geolocation after an explicit user action, plus manual location selection.

Show at least three fictional hospitals with:

* Distance and estimated travel time.
* ER availability.
* Relevant services.
* Public capacity indicator.
* Last-updated timestamp.

Clearly label locations, routes, capacity, and travel estimates as simulated.

Use an illustrative map with selectable hospital markers and a connected hospital list. The nearest hospital should be easy to identify, but distance alone must not be presented as a clinical suitability decision.

Do not direct someone past a nearer emergency department solely because another hospital has more beds. Make clear that emergency services and clinical teams determine appropriate routing.

### Step E: Submit an arrival notice

After review, create an arrival card for the selected hospital.

Show:

* Case reference.
* Destination.
* Submitted time.
* Transport mode.
* Estimated arrival time.
* Status: submitted, acknowledged, en route, arrived, canceled, or closed.

A citizen notice must not automatically reserve a bed or count as hospital acceptance.

Allow updates to ETA and cancellation, with a reason and timeline entry.

## 5. Ambulance / paramedic workflow

Create a dedicated interface for ambulance crews.

Include:

* Ambulance identifier and assigned crew.
* Current location and selected destination.
* Patient case reference.
* Chief concern.
* Age or approximate age.
* Relevant history and allergies.
* Manually entered vital signs, units, and timestamps.
* Crew-reported acuity, clearly identified by source.
* Interventions performed.
* Relevant receiving-team requirements entered by the crew.
* Number of patients.
* ETA and transport status.
* Voice notes with editable transcription and manual fallback.

Never automatically diagnose or prescribe treatment.

Before transmission, show an editable structured handover card.

Sending the case must create or update the same case on the destination ER board. Avoid duplicate cases when the crew resends an update.

The ER can acknowledge the handover and request clarification. The ambulance team can respond within the case.

Support:

**Draft → sent → acknowledged → en route → arrived → handover complete**

Allow cancellation and destination changes with reasons and a visible history. When the destination changes, update both hospitals' incoming boards without deleting the audit trail.

A transfer of destination must release any associated reservation through the proper workflow.

## 6. Staff accounts and permissions

Create named demo accounts for distinct roles. Show the active user, role, hospital, and department.

Enforce permissions inside action handlers, not just by hiding buttons.

| Role | Allowed responsibilities |
| --- | --- |
| ER coordinator / charge nurse | Review arrivals, acknowledge notices, coordinate placements, assign nurses, reserve eligible beds, manage operational queues |
| Bedside nurse | Update assigned patient care tasks, record nursing handover, flag cleaning or equipment issues, verify nursing readiness |
| Doctor | Review patients, record assessment summaries, submit admission/discharge/transfer decisions, request ICU transfer, review and acknowledge reports |
| ICU coordinator / charge nurse | Review ICU requests, record operational acceptance after required clinical approval, coordinate ICU beds and staffing |
| Housekeeping | Accept cleaning tasks, start cleaning, mark cleaning complete, report cleaning blockers |
| Maintenance technician | Accept technical tickets, mark work in progress, document repair, mark technical work resolved |
| Biomedical technician | Resolve medical-equipment tickets and record equipment checks |
| Diagnostics staff | Update assigned diagnostic task status, such as scheduled, in progress, report available |
| Administrator | Manage demo users, role assignments, inventory, and operational settings; review audit activity |

Rules:

* A nurse can report a broken monitor but cannot resolve its technical ticket.
* A technician can resolve a technical fault but cannot declare clinical readiness.
* Housekeeping can complete cleaning but cannot admit patients or clear maintenance blockers.
* A doctor can record a discharge decision, but that does not automatically mean the patient has physically left.
* Diagnostics staff can mark a report available; the responsible clinician separately acknowledges review.
* Administrative status alone must not grant clinical sign-off privileges.
* Staff can only update tasks and resources within their authorized scope.
* Any supervisor reassignment or override must be limited, reasoned, and audited. Do not allow overrides that bypass readiness or safety constraints.

Provide a permissions explanation when an action is unavailable.

## 7. Keep these concepts separate

Do not combine all information into one "bed status."

Model separately:

1. **Patient journey:** expected, arrived, triage pending, waiting, assigned, in care, awaiting transfer, departed.
2. **Physical occupancy:** vacant or occupied.
3. **Cleaning:** not required, required, assigned, in progress, complete.
4. **Technical condition:** operational, fault reported, under repair, resolved.
5. **Equipment readiness:** required equipment present and checked, or blocked.
6. **Staffing:** coverage confirmed or staffing unavailable.
7. **Reservation:** unreserved, reserved, expired, or released.
8. **Patient care tasks:** treatments, observations, diagnostics, report review, and handover.
9. **Operational availability:** derived from the above conditions.

"IV treatment in progress" and "EEG report pending" belong to the patient's care tasks. They are not physical bed states.

An occupied bed can have treatment and diagnostic tasks in progress. A vacant room can still be unavailable because of cleaning, equipment, maintenance, or staffing.

Derive readiness from explicit requirements, using a shared function throughout the application.

A bed can become available only when it is vacant, cleaning is complete or not required, blocking technical issues are resolved, required equipment checks are complete, staffing coverage is confirmed, and the nursing readiness check is complete.

Show every active blocker and its owner.

## 8. ER operations dashboard

Include:

* Incoming patients with ETAs.
* Arrived patients awaiting triage.
* Waiting patients.
* Patients currently receiving care.
* Available staffed beds.
* Reserved beds.
* Beds being cleaned.
* Beds blocked by maintenance, equipment, or staffing.
* ICU transfer requests.
* Overdue operational tasks.

Calculate all counts from application state.

### Incoming patient cards

Show:

* Case reference.
* Citizen or ambulance source.
* Reported concern.
* ETA.
* Relevant staff-entered acuity or "Not yet assessed."
* Destination acknowledgment.
* Assigned coordinator.
* Potential care requirements.
* Data freshness indicator.

Allow authorized staff to open the transcript or handover, acknowledge the case, request clarification, and assign a coordinator.

### Bed map

Each ER bed card should show:

* Bed identifier and zone.
* Occupancy.
* Patient alias or case reference for authorized users.
* Assigned nurse.
* Cleaning status.
* Equipment and maintenance indicators.
* Reservation.
* Readiness or blockers.
* Time in the current operational state.

Clicking a card opens details, permitted actions, tasks, and history.

### Placement and arrival

* Reserve only an eligible bed.
* One active reservation per bed.
* One active placement or reservation per patient.
* Show reservation expiry and allow authorized extension or release.
* Arrival does not automatically mean admission to a bed.
* Confirm physical placement explicitly.
* Prevent placement into blocked, occupied, or incompatible beds.
* Validate isolation and equipment requirements against bed capabilities.
* If there is no suitable bed, show a clear waiting or escalation workflow.

Staff enter triage priority. Do not calculate clinical triage from citizen text.

## 9. ICU dashboard and ER-to-ICU transfer

Create an ICU view with room cards, occupancy, staffing, equipment, cleaning, maintenance, incoming requests, and patient care tasks.

Room details can include:

* Isolation capability.
* Ventilator capability.
* Monitor readiness.
* Required equipment checks.
* Assigned nurse.
* Current patient.
* Maintenance and cleaning blockers.
* Pending handover.
* Patient-specific tasks.

Include example care tasks such as:

* IV treatment in progress.
* EEG requested.
* EEG scheduled.
* EEG report available.
* Clinician review pending.
* Investigation pending.
* Handover pending.

These are workflow examples, not treatment recommendations.

### Transfer workflow

Implement:

1. ER doctor requests ICU transfer with a reason and requirements.
2. ICU clinical reviewer records the clinical decision.
3. ICU coordinator confirms operational capacity.
4. A compatible, ready ICU bed is reserved.
5. Sending and receiving teams complete handover tasks.
6. Authorized staff confirm departure from the ER.
7. The ER bed becomes vacant and requires cleaning.
8. The ICU bed stays reserved while transport is in progress.
9. Authorized staff confirm ICU arrival and placement.
10. The ICU bed becomes occupied.

If clinical approval or capacity is missing, keep the request pending with an owner and reason.

Keep the patient's current physical location accurate. Never mark them as occupying both ER and ICU beds simultaneously. Show "In transit" between confirmed departure and arrival.

## 10. Cleaning, maintenance, and equipment workflows

### Cleaning

**Required → assigned → in progress → complete → nursing readiness verification**

Housekeeping can report blockers such as missing supplies or restricted access. Completion must not clear unrelated technical faults.

### Maintenance

A nurse or coordinator reports a fault with category, description, location, severity, and optional demo attachment.

**Open → assigned → in progress → resolved → verification if required**

Only the assigned technical role can resolve the relevant fault.

For faults affecting occupied beds, keep occupancy accurate and show an urgent operational blocker. Require clinical coordination before relocating a patient; never move patients automatically.

### Equipment

Use a separate biomedical queue for monitors, ventilators, pumps, and other medical equipment.

Resolution of one ticket must not clear other unresolved tickets.

Reopening a ticket must restore the relevant blocker.

## 11. Shared task management and communication

Every task needs:

* Unique ID.
* Linked patient, bed, room, or case.
* Task category.
* Required role.
* Assigned owner or team.
* Priority.
* Created time.
* Due time, if applicable.
* Status.
* Completion notes.
* Audit history.

Provide "My tasks" for each role.

Add in-app notifications for incoming handovers, changed ETAs, new ICU requests, completed cleaning, resolved faults, staffing gaps, and overdue work.

Notifications must open the relevant record.

Allow short case or task comments with author and timestamp. Keep comments inside the prototype; do not send external messages.

Require reasons for cancellations, technical closure, destination changes, and operational overrides.

## 12. Data and consistency

Use shared normalized entities such as:

* hospitals
* users
* roles
* patients
* cases
* arrivalNotices
* ambulanceAssignments
* beds
* reservations
* placements
* transferRequests
* staffingAssignments
* tasks
* maintenanceTickets
* equipmentChecks
* comments
* notifications
* auditEvents

Use stable IDs and timestamps. All screens must read and update the same underlying records.

Centralize actions such as:

* submitArrival
* acknowledgeArrival
* updateETA
* reserveBed
* confirmPlacement
* reportFault
* resolveFault
* completeCleaning
* verifyReadiness
* requestTransfer
* approveTransfer
* confirmDeparture
* confirmArrival

Validate permissions and state transitions in these actions.

Before committing a mutation, recheck the current record and reject conflicting changes with a clear message. Include a version field for basic demo conflict detection.

Clearly explain that localStorage cannot provide production-grade transactions or secure multiuser access.

## 13. Realistic demo data

Seed a manageable but convincing scenario:

* Three fictional hospitals.
* One primary hospital with 12 ER beds and 8 ICU beds.
* Named demo staff accounts across all roles.
* Patients in different stages of care.
* Three incoming ambulance cases.
* Two citizen arrival notices.
* A vacant bed awaiting cleaning.
* A bed with a monitor fault.
* An ICU room awaiting a technical repair.
* A room with cleaning complete but nursing verification pending.
* A technically ready bed unavailable because staffing is missing.
* A patient with IV treatment in progress.
* A patient with an EEG report awaiting clinician review.
* An ER-to-ICU request waiting for capacity.

Make all counts consistent with seeded records.

Use fictional patient aliases, not real identities.

## 14. Guided hackathon demonstration

Provide a guided demo with highlighted next actions that can demonstrate this connected story:

1. A citizen speaks or selects a sample voice scenario.
2. SILA creates an editable structured arrival notice.
3. The citizen selects a nearby fictional hospital and submits.
4. The case appears on that hospital's ER board.
5. The coordinator acknowledges it.
6. A separate ambulance case sends a structured handover and ETA.
7. The ER identifies a bed blocked by an equipment fault.
8. The nurse reports the fault.
9. The biomedical technician resolves it.
10. Housekeeping completes required cleaning.
11. The nurse verifies readiness.
12. The coordinator reserves the bed.
13. Staff confirm arrival and placement.
14. The doctor requests ICU transfer.
15. ICU completes clinical approval and capacity coordination.
16. Sending and receiving teams complete handover and confirm movement.
17. The patient appears in ICU and the vacated ER bed enters the cleaning queue.

Offer a shorter presentation path that completes the main story in approximately three minutes. Guided mode must use the same actions and permission checks as normal use.

## 15. Privacy, safety, and honest demo boundaries

* Display a discreet but visible "Hackathon demo — synthetic data" label.
* Do not present the app as a replacement for emergency services.
* Do not diagnose, prescribe, or independently determine transport suitability.
* Keep reported information distinct from clinician-confirmed information.
* Label simulated maps, ETAs, extraction, capacity, and notifications.
* Do not claim real dispatch, live hospital integration, or secure authentication.
* Ask for microphone and location permission only when needed.
* Make clear that browser speech services may process audio through the browser provider.
* Avoid retaining raw audio.
* Keep public hospital capacity separate from private patient information.
* Provide a brief production-readiness note describing the need for secure backend permissions, clinical governance, real integrations, privacy controls, reliable synchronization, and deployment review.

## 16. Acceptance checks

Before delivery, verify that:

* Citizen submission creates a case on the correct hospital's ER board.
* Ambulance updates modify the existing case without duplication.
* Staff actions update connected dashboards and calculated counts.
* A nurse cannot resolve a technical ticket.
* A technician cannot admit a patient or verify clinical readiness.
* Housekeeping completion does not clear maintenance blockers.
* A bed with any unresolved readiness requirement cannot become available.
* Two patients cannot hold the same bed.
* A discharge decision alone does not vacate a bed.
* A pending EEG report does not change physical bed occupancy.
* A canceled or redirected case releases the appropriate reservation.
* ER-to-ICU transfer preserves one accurate physical location.
* Unauthorized actions are rejected inside the mutation logic.
* Refresh restores demo state.
* Open tabs receive updates.
* Reset restores a consistent dataset.
* Voice and location failures have usable manual fallbacks.
* Arabic layout works correctly.
* No essential button is decorative or nonfunctional.

Deliver the complete HTML file, brief run instructions, demo account details, and a concise list of implemented browser features and simulated integrations. State which checks you actually performed.

Prioritize a coherent, reliable end-to-end workflow and attractive presentation over adding disconnected features.

---

## 17. Amendments from the merged workflow (override earlier sections where they differ)

1. **ER→ICU order:** ER doctor requests transfer → ICU intensivist records clinical acceptance → only then are ICU bed-prep tasks created → owners complete them → ICU nurse verifies readiness → bed becomes available → ICU coordinator reserves it → departure from ER ("In transit") → arrival and placement in ICU → ER bed becomes vacant and requires cleaning.
2. **No ICU flag from citizens:** citizen notices can never create an ICU request. Only an ER doctor can.
3. **Transport / porter role:** can confirm pickup (departure) and drop-off (arrival) for transfers assigned to them. Cannot place, reserve, or verify anything.
4. **Step-down flag:** an ICU doctor can mark an ICU patient as ready for ward step-down, with a reason. This creates a pending ward-transfer task and shows "Expected to free soon" on the ICU board. It does not vacate the bed; only a confirmed departure does.
5. **Ready-time forecast:** `forecastReadyTime(bed, state)` returns the estimated ready time, the blocking step, and its owner, based on open blocker tasks and their due times. If any blocker has no due time, it shows "Unknown." Always labeled as an estimate.
6. **Surge mode:** out of scope for the prototype; mention only as a future step.
