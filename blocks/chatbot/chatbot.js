import { createTag } from '../../scripts/shared.js';

/**
 * Site chatbot block.
 *
 * Renders a floating launcher button and a chat panel that answers visitor
 * questions using only this site's content. Questions are sent to the chatbot
 * Cloudflare Worker, which performs retrieval over the site query-index and
 * calls the LLM server-side (no API keys in client code).
 *
 * The endpoint is resolved from the block's first cell (an authored link or
 * text URL); on localhost it falls back to the local `wrangler dev` port.
 */

const LOCAL_ENDPOINT = 'http://localhost:8787';
const PROD_PATH = '/chatbot';

function resolveEndpoint(block) {
  // Authored override: a link or text in the first cell.
  const authored = block?.querySelector('a')?.href
    || block?.textContent?.trim();
  if (authored && /^https?:\/\//.test(authored)) return authored;

  const { hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return LOCAL_ENDPOINT;
  return PROD_PATH;
}

function scrollToEnd(el) {
  el.scrollTop = el.scrollHeight;
}

/** Minimal, safe rendering of the assistant answer: escape then linkify [Source N]. */
function renderAnswer(container, text, sources) {
  container.textContent = text;
  if (sources?.length) {
    const list = createTag('ul', { class: 'chatbot-sources' });
    sources.slice(0, 4).forEach((s) => {
      const li = createTag('li');
      li.append(createTag('a', { href: s.url || s.path, target: '_blank', rel: 'noopener' }, s.title || s.path));
      list.append(li);
    });
    container.append(list);
  }
}

function addMessage(log, role, text, sources) {
  const msg = createTag('div', { class: `chatbot-msg chatbot-msg-${role}` });
  const bubble = createTag('div', { class: 'chatbot-bubble' });
  if (role === 'assistant') {
    renderAnswer(bubble, text, sources);
  } else {
    bubble.textContent = text;
  }
  msg.append(bubble);
  log.append(msg);
  scrollToEnd(log);
  return bubble;
}

function buildPanel() {
  const panel = createTag('div', {
    class: 'chatbot-panel',
    role: 'dialog',
    'aria-label': 'Site assistant',
    'aria-modal': 'false',
    hidden: true,
  });

  const header = createTag('div', { class: 'chatbot-header' });
  header.append(createTag('span', { class: 'chatbot-title' }, 'Ask about this site'));
  const closeBtn = createTag('button', {
    class: 'chatbot-close', type: 'button', 'aria-label': 'Close chat',
  }, '×');
  header.append(closeBtn);

  const log = createTag('div', {
    class: 'chatbot-log', role: 'log', 'aria-live': 'polite', 'aria-atomic': 'false',
  });

  const form = createTag('form', { class: 'chatbot-form' });
  const input = createTag('input', {
    class: 'chatbot-input',
    type: 'text',
    name: 'message',
    placeholder: 'Ask a question…',
    autocomplete: 'off',
    'aria-label': 'Your question',
    maxlength: '1000',
  });
  const send = createTag('button', { class: 'chatbot-send', type: 'submit' }, 'Send');
  form.append(input, send);

  panel.append(header, log, form);
  return {
    panel, header, closeBtn, log, form, input, send,
  };
}

export default async function decorate(block) {
  // Prevent duplicate widgets if the block is placed more than once / injected site-wide.
  if (document.querySelector('.chatbot-widget')) {
    block.remove();
    return;
  }

  const endpoint = resolveEndpoint(block);
  block.textContent = '';

  const widget = createTag('div', { class: 'chatbot-widget' });
  const launcher = createTag('button', {
    class: 'chatbot-launcher',
    type: 'button',
    'aria-expanded': 'false',
    'aria-label': 'Open site assistant',
  }, 'Ask AI');

  const {
    panel, closeBtn, log, form, input, send,
  } = buildPanel();

  widget.append(launcher, panel);
  block.append(widget);

  const history = [];
  let greeted = false;

  function openPanel() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    if (!greeted) {
      addMessage(log, 'assistant', 'Hi! Ask me anything about this site and I\'ll answer from its content.');
      greeted = true;
    }
    input.focus();
  }

  function closePanel() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  launcher.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
  closeBtn.addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    addMessage(log, 'user', question);
    history.push({ role: 'user', content: question });
    input.value = '';
    input.disabled = true;
    send.disabled = true;

    const pending = addMessage(log, 'assistant', '…');
    pending.parentElement.classList.add('is-loading');

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, history: history.slice(0, -1) }),
      });
      const data = await resp.json().catch(() => ({}));
      pending.parentElement.classList.remove('is-loading');
      if (!resp.ok || !data.answer) {
        pending.textContent = data.error || 'Sorry, I could not answer that right now.';
      } else {
        pending.textContent = '';
        renderAnswer(pending, data.answer, data.sources);
        history.push({ role: 'assistant', content: data.answer });
      }
    } catch {
      pending.parentElement.classList.remove('is-loading');
      pending.textContent = 'Sorry, something went wrong. Please try again.';
    } finally {
      input.disabled = false;
      send.disabled = false;
      input.focus();
      scrollToEnd(log);
    }
  });
}
