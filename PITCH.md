# SILA — 3-minute pitch

**Problem (one sentence):** When an emergency patient is on the way, the hospital learns too late who is coming, and the bed they need is held up by cleaning, a broken monitor or a missing sign-off that nobody can see in one place.
**Solution (one sentence):** SILA connects the caller, the ambulance and every hospital team around one patient, so the ER is warned early and a bed moves from "blocked" to "ready" to "occupied" through one shared, rule-checked flow.

> المشكلة: حين يكون مريض طارئ في الطريق، يعلم المستشفى متأخرًا بمن هو قادم، والسرير الذي يحتاجه معطّل بسبب تنظيف أو جهاز مراقبة معطّل أو موافقة ناقصة لا يراها أحد في مكان واحد.
> الحل: تربط SILA المتصل وطاقم الإسعاف وكل فرق المستشفى حول مريض واحد، فتُنبَّه الطوارئ مبكرًا ويتحوّل السرير من «معطّل» إلى «جاهز» إلى «مشغول» عبر تدفّق واحد مشترك تحكمه القواعد.

**Setup:** two browser windows side by side. **Left** = the guided demo ("Run guided demo" → *3-minute pitch* → reset ✓). **Right** = a second tab signed in as the ER coordinator on the ER board (the demo's start dialog has a link for it). See `DEMO-CHECKLIST.md`.

| # | Guided-demo step (panel title) | Seconds | Say this | Do this |
|---|---|---|---|---|
| — | *(before pressing Start)* | 15 | "Every day, ERs prepare for patients they know nothing about, and beds sit empty but unusable. SILA fixes the hand-offs in between." | Show the welcome page. |
| 1 | A citizen describes the emergency | 12 | "A daughter is with her father. She can speak or type — here, a sample. Simple rules pull out age, symptoms, allergies. Nothing is diagnosed." | Click the highlighted sample. |
| 2 | Review, choose the nearest hospital, send | 15 | "She checks the fields, SILA ranks hospitals by simulated distance — never by who has beds — and she sends." **★ Live-sync moment:** "Watch the right screen." | Click **Send arrival notice**, then point at the right screen: the card appears with no refresh. |
| 3 | The ER coordinator acknowledges | 10 | "The coordinator acknowledges. Her phone shows it instantly. Acknowledging is not a bed promise." | Click **Acknowledge**. |
| 4 | An ambulance sends a structured handover | 15 | "Meanwhile an ambulance sends vitals with units and times, its own acuity — labelled crew-reported — and an ETA. Staff triage stays empty until the ER assesses." | Click **Send handover**; point at "Crew-reported: High · Not yet assessed". |
| 5 | A nurse reports a monitor fault | 15 | "Bed ER-04 is free, but the nurse finds the monitor dead. She reports it — the bed now shows exactly who owns each blocker and a ready-time estimate." **★ Wrong-role moment:** "Can she close the repair herself? No — and SILA says why." | Submit the fault; point at the greyed **Resolve** button: *"Only a biomedical technician can resolve equipment tickets."* |
| 6 | Biomedical engineering fixes it | 10 | "Biomed fixes it and records a passed check. Other blockers stay visible." | Click **Resolve** (as Biomed), let the demo record the check. |
| 7 | Housekeeping completes cleaning | 8 | "Cleaning done — that clears cleaning, nothing else." | Click **Mark cleaning complete**. |
| 8 | The nurse verifies readiness | 8 | "Only a nurse can give clinical sign-off. Now it's ready." | Click **Verify nursing readiness**. |
| 9 | Reserve, arrive, triage, place | 15 | "The coordinator reserves it, the patient arrives, the nurse records triage herself, and places him. One patient, one bed, one location." | Do it for me (or click through). |
| 10 | ER doctor requests ICU; the intensivist accepts | 12 | "He's getting worse. Only the ER doctor can ask for ICU; only the intensivist can accept. Accepting does not magically create a bed." | Do it for me. |
| 11 | The coordinator confirms the step-down bed | 15 | "An ICU patient is stable enough for the ward. Her room is freed, cleaned, the ventilator checked, verified — and confirmed for our patient." | Do it for me; point at the ICU board. |
| 12 | Handover, transport and ICU arrival | 12 | "Both nurses sign handover, the porter moves him — in transit he's in no bed — and ICU confirms placement." | Do it for me. |
| 13 | The patient is in ICU; ER-04 is in the cleaning queue | 10 | "And the ER bed he left is already in housekeeping's queue for the next patient. One connected flow, every step checked, in English and Arabic." | Point at the queue; optionally switch to **العربية** for 3 seconds. |
| — | Close | 8 | "SILA: the right bed, ready, before the patient arrives." | Exit the demo. |

**Total ≈ 180 s.** If running long, use "Do it for me" from step 6 onwards and drop the Arabic switch.

**Key lines in Arabic** (for an Arabic-speaking panel):
- Step 1: «شخص برفقة مريض يصف ما يحدث بالصوت أو الكتابة. تستخرج قواعد بسيطة العمر والأعراض والحساسية — دون أي تشخيص.»
- Step 2: «تُرتَّب المستشفيات حسب المسافة فقط، لا حسب الأسرّة المتاحة… انظروا إلى الشاشة الأخرى: ظهرت الحالة دون تحديث.»
- Step 5: «هل يستطيع الممرض إغلاق بلاغ الإصلاح بنفسه؟ لا — والنظام يوضّح السبب.»
- Step 13: «سرير الطوارئ الذي أُخلي أصبح في قائمة التنظيف للمريض التالي. تدفّق واحد مترابط، وكل خطوة تخضع للقواعد.»
- Close: «SILA: السرير المناسب، جاهزًا، قبل وصول المريض.»

---

## Likely judge questions — short, honest answers

1. **What about patient privacy?** The demo uses synthetic data only and stores it in this browser; no audio is ever stored and the app makes no network requests. In production: hospital-hosted backend, encryption, role-based access, full audit, and compliance with Saudi data-protection law (PDPL) and hospital policy.
2. **Why doesn't it call or dispatch an ambulance?** Dispatch belongs to emergency services (997). SILA shows the number but never calls it and never replaces it — it tells the *receiving hospital* what is coming.
3. **Is it clinically safe?** SILA never diagnoses, triages or recommends treatment. Citizen and crew information is labelled unverified; staff triage is entered by staff; vital signs are only checked for physically possible values. A real deployment needs clinical governance and safety review.
4. **What is simulated?** Maps, distances and ETAs, field extraction, public capacity, notifications and sign-in. Real: browser speech, geolocation, storage and live sync between tabs.
5. **How would it plug into real hospital systems?** Through standard interfaces — HL7 FHIR resources (Encounter, Location, Task, ServiceRequest), ADT/bed-management feeds, the ambulance CAD system, and hospital single sign-on. Each SILA action maps to one auditable event, which makes that integration straightforward.
6. **Does it scale beyond one browser?** Not as built — state lives in one browser. The rule engine is pure functions designed to move to a server with a transactional database and real-time push; that is the main production step.
7. **What if two people act on the same bed at once?** Every record is versioned; the second person gets "this bed changed while you were looking". Same-instant clashes are detected and reported; true atomicity needs the server.
8. **Who pays?** Hospitals and health clusters, through shorter ER boarding and bed-turnaround times — not patients or citizens.
9. **How do you know it works?** 80 automated tests on the rules, plus a release audit in a real browser (dead-button sweep, injection tests, damaged-data recovery, two-tab conflicts). The guided demo runs on the same actions as the buttons.
10. **What would you build next?** A pilot with one ER on real bed data, clinician review of the Arabic, integrations above, and **surge mode** — coordinating overflow across hospitals during mass-casualty events (deliberately out of scope here).

---

## Backup plan

| If this fails | Do this |
|---|---|
| Microphone | Nothing to do — the pitch uses a sample case; typing always works. |
| Wi-Fi | Nothing to do — `dist/index.html` runs fully offline from disk. |
| Second screen / projector | Run both tabs in one window side by side; or skip the live-sync line and show the card on the same screen. |
| Laptop | Second laptop or USB stick with `dist/index.html` (open in any Chromium browser) and the backup video. |
| Demo state gets confused | **Reset demo** in the header, or the start dialog's reset option, then restart the pitch. |
| A guided step refuses | Read the panel's message aloud ("the rules caught it"), press **Skip**, carry on. |
| Everything | Play the 3-minute backup video and narrate over it. |
