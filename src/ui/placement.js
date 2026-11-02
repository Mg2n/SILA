// Placement flow: reserve (with expiry) → extend/release with reason → confirm placement.
// Each bed or patient option is checked by the engine; unusable ones are disabled and say why.

import { compatibilityError } from '../readiness.js';
import { t, tm } from '../i18n.js';
import { erBeds, selectIncoming, selectAwaitingTriage, selectWaiting, bedBoardStatus } from '../selectors.js';
import { h, nextUid } from './dom.js';
import { icon } from './icons.js';
import { openDialog, field, run, state, now, check, canSeePatient } from './core.js';
import { forecastLine, pill } from './components.js';

const REQS = ['isolation', 'ventilator'];
const reqText = (requirements) => {
  const list = REQS.filter((k) => requirements?.[k]).map((k) => t(`req.${k}`));
  return t('placement.requirements', { list: list.length ? list.join(', ') : t('incoming.noRequirements') });
};

function radioList(legend, name, options) {
  return h('fieldset', { class: 'choices' }, h('legend', { text: legend }), options.map((o) => {
    const id = nextUid(name);
    const whyId = `${id}-why`;
    return h('div', { class: 'choice' },
      h('input', { type: 'radio', id, name, value: o.value, disabled: !o.ok, required: true, 'aria-describedby': o.ok ? null : whyId }),
      h('label', { for: id }, h('span', {}, o.label), o.badge ?? null,
        o.ok ? null : h('span', { class: 'why', id: whyId, text: ` — ${tm(o.reason)}` })));
  }));
}

const minutesField = () => field({ label: t('placement.minutes'), name: 'minutes', type: 'select', value: '30',
  options: [15, 30, 45, 60].map((n) => ({ value: String(n), label: t('minutes.option', { n }) })) });

export function openReserveForCase(c) {
  const s = state();
  const beds = erBeds(s, c.destinationHospitalId);
  const options = beds.map((b) => {
    const v = check('reserveBed', { bedId: b.id, caseId: c.id });
    return { value: b.id, ok: v.ok, reason: v.reason, label: `${b.label} · ${b.zone}`, seen: b.version,
      badge: pill(bedBoardStatus(b, s, now()).level) };
  });
  const usable = options.filter((o) => o.ok);

  if (!usable.length) {
    // Waiting / escalation state: nothing suitable now; show beds being prepared that could take this patient.
    const preparing = beds.filter((b) => b.occupancy.status === 'vacant' && !compatibilityError(b, c.requirements))
      .map((b) => ({ b, st: bedBoardStatus(b, s, now()) })).filter(({ st }) => st.level !== 'ready');
    return openDialog({
      title: t('placement.title', { ref: c.ref }),
      intro: h('div', { class: 'notice danger', role: 'status' }, icon('alert'), h('div', {},
        h('strong', { text: t('placement.noSuitable') }), h('p', { text: t('placement.noSuitableBody') }), h('p', { class: 'small', text: reqText(c.requirements) }))),
      fields: () => [
        h('h3', { text: t('placement.preparing') }),
        preparing.length
          ? h('ul', { class: 'rows' }, preparing.map(({ b, st }) => h('li', { class: 'row' }, pill(st.level), h('div', { class: 'grow' }, h('strong', { text: b.label }), forecastLine(st.forecast)))))
          : h('p', { class: 'empty', text: t('placement.noneComing') }),
        h('details', {}, h('summary', { text: t('placement.chooseBed') }),
          h('ul', { class: 'small' }, options.map((o) => h('li', { text: `${o.label} — ${tm(o.reason)}` })))),
        field({ label: t('placement.escalate'), name: 'text', type: 'textarea', required: true, maxlength: 500 }),
      ],
      submitLabel: t('placement.escalateSubmit'),
      onSubmit: (d) => run('addComment', { targetType: 'case', targetId: c.id, text: d.text }, { quiet: true }),
    });
  }

  return openDialog({
    title: t('placement.title', { ref: c.ref }),
    intro: h('p', { class: 'muted', text: reqText(c.requirements) }),
    fields: () => [radioList(t('placement.chooseBed'), 'bedId', options), minutesField()],
    submitLabel: t('placement.reserve'),
    onSubmit: (d) => {
      const chosen = options.find((o) => o.value === d.bedId);
      if (!chosen) return { ok: false, code: 'invalid', error: t('placement.chooseBed') };
      return run('reserveBed', { bedId: d.bedId, caseId: c.id, minutes: Number(d.minutes) }, { seen: chosen.seen, quiet: true });
    },
  });
}

export function openReserveForBed(bed) {
  const s = state();
  const seen = bed.version;
  const cases = [...selectAwaitingTriage(s, bed.hospitalId), ...selectWaiting(s, bed.hospitalId), ...selectIncoming(s, bed.hospitalId)];
  const showPatient = canSeePatient(bed.hospitalId);
  const options = cases.map((c) => {
    const v = check('reserveBed', { bedId: bed.id, caseId: c.id });
    const who = showPatient ? s.patients[c.patientId].alias : t('common.dash');
    return { value: c.id, ok: v.ok, reason: v.reason, label: t('placement.patientOption', { ref: c.ref, who, status: t(`journey.${c.journey}`) }) };
  });
  const usable = options.some((o) => o.ok);
  return openDialog({
    title: t('placement.forBedTitle', { bed: bed.label }),
    intro: usable ? null : h('p', { class: 'notice warn' }, icon('alert', { size: 16 }), h('span', { text: t('placement.noPatients') })),
    fields: () => [options.length ? radioList(t('placement.choosePatient'), 'caseId', options) : null, minutesField()],
    submitLabel: t('placement.reserve'),
    submitDisabled: !usable,
    onSubmit: (d) => {
      if (!d.caseId) return { ok: false, code: 'invalid', error: t('placement.choosePatient') };
      return run('reserveBed', { bedId: bed.id, caseId: d.caseId, minutes: Number(d.minutes) }, { seen, quiet: true });
    },
  });
}
