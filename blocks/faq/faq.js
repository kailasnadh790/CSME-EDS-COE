import { createTag } from '../../scripts/shared.js';
import { toClassName } from '../../scripts/aem.js';
import { extendSchema } from '../../scripts/schema.js';

const FAQ_INDEX_PATH = '/faq-index.json';

async function fetchFaqs() {
  const resp = await fetch(FAQ_INDEX_PATH);
  if (!resp.ok) return [];
  const json = await resp.json();
  return json?.data || [];
}

function toggleItem(button) {
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  const panel = button.nextElementSibling;
  panel.hidden = expanded;
}

function buildFaqItem(faq) {
  const item = createTag('div', { class: 'faq-item' });

  const button = createTag('button', {
    class: 'faq-question',
    'aria-expanded': 'false',
    type: 'button',
  }, faq.question);

  const panel = createTag('div', {
    class: 'faq-answer',
    role: 'region',
    hidden: true,
  });
  panel.append(createTag('p', {}, faq.answer));

  button.addEventListener('click', () => toggleItem(button));

  item.append(button, panel);
  return item;
}

function buildAccordion(faqs) {
  const list = createTag('div', { class: 'faq-list' });
  faqs.forEach((faq) => list.append(buildFaqItem(faq)));
  return list;
}

function selectTab(tabs, panels, index) {
  tabs.forEach((tab, i) => {
    const isSelected = i === index;
    tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    tab.setAttribute('tabindex', isSelected ? '0' : '-1');
    tab.classList.toggle('is-active', isSelected);
    panels[i].hidden = !isSelected;
  });
}

function buildTabs(block, grouped) {
  const categories = Object.keys(grouped);

  const tablist = createTag('div', {
    class: 'faq-tablist',
    role: 'tablist',
    'aria-label': 'FAQ categories',
  });
  const panelsWrap = createTag('div', { class: 'faq-panels' });

  const tabs = [];
  const panels = [];

  categories.forEach((category, index) => {
    const slug = toClassName(category);
    const tabId = `faq-tab-${slug}`;
    const panelId = `faq-panel-${slug}`;
    const isFirst = index === 0;

    const tab = createTag('button', {
      class: `faq-tab${isFirst ? ' is-active' : ''}`,
      id: tabId,
      type: 'button',
      role: 'tab',
      'aria-controls': panelId,
      'aria-selected': isFirst ? 'true' : 'false',
      tabindex: isFirst ? '0' : '-1',
    }, category);

    const panel = createTag('div', {
      class: 'faq-tabpanel',
      id: panelId,
      role: 'tabpanel',
      'aria-labelledby': tabId,
      hidden: isFirst ? undefined : true,
    });
    panel.append(buildAccordion(grouped[category]));

    tab.addEventListener('click', () => selectTab(tabs, panels, index));
    tab.addEventListener('keydown', (e) => {
      let target = null;
      if (e.key === 'ArrowRight') target = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = tabs.length - 1;
      if (target === null) return;
      e.preventDefault();
      selectTab(tabs, panels, target);
      tabs[target].focus();
    });

    tabs.push(tab);
    panels.push(panel);
    tablist.append(tab);
    panelsWrap.append(panel);
  });

  block.append(tablist, panelsWrap);
}

export default async function decorate(block) {
  const categories = [...block.children].map(
    (row) => row.textContent.trim(),
  ).filter(Boolean);

  block.textContent = '';

  const allFaqs = await fetchFaqs();
  if (!allFaqs.length) {
    block.append(createTag('p', { class: 'faq-empty' }, 'No FAQs available.'));
    return;
  }

  const filtered = categories.length
    ? allFaqs.filter((faq) => categories.includes(faq.category))
    : allFaqs;

  if (!filtered.length) {
    block.append(createTag('p', { class: 'faq-empty' }, 'No FAQs found for the selected categories.'));
    return;
  }

  const grouped = {};
  filtered.forEach((faq) => {
    if (!grouped[faq.category]) grouped[faq.category] = [];
    grouped[faq.category].push(faq);
  });

  const categoryKeys = Object.keys(grouped);
  if (categoryKeys.length > 1) {
    buildTabs(block, grouped);
  } else {
    block.append(buildAccordion(grouped[categoryKeys[0]]));
  }

  extendSchema('WebPage', {
    '@type': 'FAQPage',
    mainEntity: filtered.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  });
}
