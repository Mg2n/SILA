// "About this prototype": what SILA is, what is real vs simulated, privacy, the production-readiness note (SPEC §15)
// and the emergency-services disclaimer. Public page, English and Arabic.

import { REGION } from '../config.js';
import { t } from '../i18n.js';
import { h, append } from './dom.js';
import { icon } from './icons.js';

const list = (keys) => h('ul', { class: 'about-list' }, keys.map((k) => h('li', {}, icon('check', { size: 16 }), h('span', { text: t(k) }))));

export function renderAbout(main) {
  append(main, [
    h('h1', { text: t('about.title') }),
    h('section', { class: 'panel', 'aria-labelledby': 'about-what' },
      h('h2', { id: 'about-what', text: t('about.what.title') }),
      h('p', { text: t('about.what.body') })),
    h('section', { class: 'panel', 'aria-labelledby': 'about-real' },
      h('h2', { id: 'about-real', text: t('about.real.title') }),
      list(['about.real.speech', 'about.real.geo', 'about.real.storage', 'about.real.sync'])),
    h('section', { class: 'panel', 'aria-labelledby': 'about-sim' },
      h('h2', { id: 'about-sim' }, t('about.sim.title'), ' ', h('span', { class: 'chip', text: t('hospitals.simulated') })),
      list(['about.sim.maps', 'about.sim.etas', 'about.sim.extraction', 'about.sim.capacity', 'about.sim.notifications', 'about.sim.auth'])),
    h('section', { class: 'panel', 'aria-labelledby': 'about-privacy' },
      h('h2', { id: 'about-privacy', text: t('about.privacy.title') }),
      list(['about.privacy.audio', 'about.privacy.provider', 'about.privacy.synthetic', 'about.privacy.location'])),
    h('section', { class: 'panel', 'aria-labelledby': 'about-prod' },
      h('h2', { id: 'about-prod', text: t('about.prod.title') }),
      h('p', { text: t('about.prod.body') })),
    h('section', { class: 'emergency', 'aria-labelledby': 'about-emergency' },
      icon('phone', { size: 26 }),
      h('div', {}, h('h2', { id: 'about-emergency', text: t('about.emergency.title') }),
        h('p', { text: t('about.emergency.body', { number: REGION.number }) }))),
    h('a', { class: 'btn big', href: '#/welcome', 'data-focus-key': 'about-back' }, t('about.back')),
  ]);
}
