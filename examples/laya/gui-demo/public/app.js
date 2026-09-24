// Laya Ticket Triage Dashboard -- vanilla JS, no build step, no framework.
// Talks to the server's JSON API (server.ts): POST /api/triage,
// GET /api/tickets, DELETE /api/tickets.

const URGENCY_LEVELS = ['low', 'medium', 'high', 'critical'];
const CATEGORY_ORDER = ['billing', 'technical', 'account', 'other'];

// Mirrors style.css's :root custom properties. Reading them back via
// getComputedStyle(document.documentElement) is fragile (depends on the
// stylesheet having finished parsing before this script runs) and was the
// actual cause of every queue dot rendering the same color -- a plain,
// hardcoded map has no such timing dependency.
const URGENCY_COLORS = {
  low: '#22c55e',
  medium: '#eab308',
  high: '#f97316',
  critical: '#ef4444',
};

const SAMPLE_TICKETS = [
  "I was charged twice for my subscription this month and I can't reach anyone. This is the third time this has happened and I want a refund immediately.",
  'How do I change the display name on my profile? I looked in settings but could not find the option.',
  "The app crashes every time I try to export a report. I've lost two hours of work today because of this and I have a client deadline in an hour.",
  'Just wanted to say the new dashboard redesign looks great, nice work!',
];

const textarea = document.getElementById('ticket-text');
const triageBtn = document.getElementById('triage-btn');
const statusEl = document.getElementById('status');
const resultPanel = document.getElementById('result-panel');
const resultEl = document.getElementById('result');
const latencyEl = document.getElementById('latency');
const rawToggleBtn = document.getElementById('raw-toggle-btn');
const rawView = document.getElementById('raw-view');
const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const clearBtn = document.getElementById('clear-btn');

rawToggleBtn.addEventListener('click', () => {
  rawView.hidden = !rawView.hidden;
  rawToggleBtn.textContent = rawView.hidden ? 'View raw request/response' : 'Hide raw request/response';
});

document.querySelectorAll('.example-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const index = Number(btn.dataset.example);
    textarea.value = SAMPLE_TICKETS[index];
  });
});

triageBtn.addEventListener('click', () => {
  void triage();
});

clearBtn.addEventListener('click', () => {
  void clearQueue();
});

async function triage() {
  const text = textarea.value.trim();
  if (!text) {
    setStatus('Enter some ticket text first.', true);
    return;
  }

  triageBtn.disabled = true;
  setStatus('Triaging...', false);

  try {
    const res = await fetch('/api/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    setStatus('', false);
    renderResult(data);
    await loadQueue();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    triageBtn.disabled = false;
  }
}

async function loadQueue() {
  const res = await fetch('/api/tickets');
  const tickets = await res.json();
  renderQueue(tickets);
}

async function clearQueue() {
  await fetch('/api/tickets', { method: 'DELETE' });
  resultPanel.hidden = true;
  await loadQueue();
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function pct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

function urgencyClass(level) {
  return `urgency-${level}`;
}

// urgency.value / ticket.urgencyScore is a probability-weighted expected
// value, not a guaranteed-in-range integer -- clamp before indexing
// URGENCY_LEVELS so an edge-case score can't silently mislabel via the
// array returning undefined.
function urgencyLevelFor(score) {
  const index = Math.max(0, Math.min(URGENCY_LEVELS.length - 1, Math.round(score)));
  return URGENCY_LEVELS[index];
}

function bar(name, p, extraClass) {
  const row = document.createElement('div');
  row.className = `bar-track ${extraClass || ''}`;
  row.innerHTML = `
    <span class="bar-name">${name}</span>
    <span class="bar-outer"><span class="bar-inner" style="width:${(p * 100).toFixed(1)}%"></span></span>
    <span class="bar-pct">${pct(p)}</span>
  `;
  return row;
}

function renderResult(ticket) {
  resultPanel.hidden = false;
  resultEl.innerHTML = '';

  latencyEl.textContent =
    typeof ticket.latencyMs === 'number' ? `${ticket.latencyMs.toFixed(0)}ms` : '';

  rawView.hidden = true;
  rawToggleBtn.textContent = 'View raw request/response';
  rawView.textContent = JSON.stringify(
    { request: ticket.request, rawResponse: ticket.rawResponse },
    null,
    2
  );

  const { category, urgency, needsHumanEscalation } = ticket.answers;

  // Category
  if (category) {
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `<div class="answer-label">Category (confidence ${pct(category.confidence)})</div>
      <span class="badge">${category.value}</span>`;
    resultEl.appendChild(row);

    const barsWrap = document.createElement('div');
    for (const name of CATEGORY_ORDER) {
      const p = category.probabilities[name] ?? 0;
      barsWrap.appendChild(bar(name, p));
    }
    resultEl.appendChild(barsWrap);
  }

  // Urgency -- value is a probability-weighted expected value over
  // [low, medium, high, critical], not necessarily an integer index.
  if (urgency) {
    const nearestLevel = urgencyLevelFor(urgency.value);
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `<div class="answer-label">Urgency (score ${urgency.value.toFixed(2)}, confidence ${pct(urgency.confidence)})</div>
      <span class="badge">~${nearestLevel}</span>`;
    resultEl.appendChild(row);

    const barsWrap = document.createElement('div');
    URGENCY_LEVELS.forEach((level, i) => {
      const p = urgency.probabilities[i] ?? 0;
      barsWrap.appendChild(bar(level, p, urgencyClass(level)));
    });
    resultEl.appendChild(barsWrap);
  }

  // Escalation
  if (needsHumanEscalation) {
    const confidence =
      needsHumanEscalation.confidence !== undefined ? pct(needsHumanEscalation.confidence) : 'n/a';
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `<div class="answer-label">Needs human escalation? (confidence ${confidence})</div>`;
    row.appendChild(bar('likely', needsHumanEscalation.value));
    resultEl.appendChild(row);
  }
}

function renderQueue(tickets) {
  queueCount.textContent = tickets.length ? `(${tickets.length})` : '';
  queueList.innerHTML = '';

  if (tickets.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No tickets triaged yet.';
    queueList.appendChild(empty);
    return;
  }

  // Already sorted newest-first by the server; re-sort by urgency
  // descending so the most urgent tickets surface at the top of the queue.
  const sorted = [...tickets].sort((a, b) => b.urgencyScore - a.urgencyScore);

  for (const ticket of sorted) {
    const li = document.createElement('li');
    li.className = 'queue-item';

    const level = urgencyLevelFor(ticket.urgencyScore);
    const dot = document.createElement('span');
    dot.className = `queue-urgency-dot ${urgencyClass(level)}`;
    dot.style.background = URGENCY_COLORS[level];

    const text = document.createElement('span');
    text.className = 'queue-item-text';
    text.textContent = ticket.text;

    const meta = document.createElement('span');
    meta.className = 'queue-item-meta';
    const category = ticket.answers.category ? ticket.answers.category.value : '';
    const latency = typeof ticket.latencyMs === 'number' ? `${ticket.latencyMs.toFixed(0)}ms` : '';
    meta.textContent = [category, latency].filter(Boolean).join(' · ');

    li.appendChild(dot);
    li.appendChild(text);
    li.appendChild(meta);
    li.addEventListener('click', () => renderResult(ticket));

    queueList.appendChild(li);
  }
}

// Initial load
void loadQueue();
