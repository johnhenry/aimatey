// Laya Ticket Triage Dashboard -- vanilla JS, no build step, no framework.
// Talks to the server's JSON API (server.ts): POST /api/triage,
// POST /api/triage/batch, POST /api/triage/compare, GET/PUT /api/questions,
// POST /api/questions/reset, GET /api/backends, GET/DELETE /api/tickets.

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

// ============================================================================
// Elements
// ============================================================================

const singleModeEl = document.getElementById('single-mode');
const batchModeEl = document.getElementById('batch-mode');
const modeButtons = document.querySelectorAll('.mode-btn');
const ticketText = document.getElementById('ticket-text');
const batchText = document.getElementById('batch-text');
const compareToggleLabel = document.getElementById('compare-toggle-label');
const compareCheckbox = document.getElementById('compare-checkbox');
const triageBtn = document.getElementById('triage-btn');
const statusEl = document.getElementById('status');

const resultPanel = document.getElementById('result-panel');
const resultColumns = document.getElementById('result-columns');

const questionsToggleBtn = document.getElementById('questions-toggle-btn');
const questionsForm = document.getElementById('questions-form');
const questionsSaveBtn = document.getElementById('questions-save-btn');
const questionsResetBtn = document.getElementById('questions-reset-btn');
const questionsStatus = document.getElementById('questions-status');
const qCategoryInstructions = document.getElementById('q-category-instructions');
const qCriteria = {
  billing: document.getElementById('q-criteria-billing'),
  technical: document.getElementById('q-criteria-technical'),
  account: document.getElementById('q-criteria-account'),
  other: document.getElementById('q-criteria-other'),
};
const qUrgencyInstructions = document.getElementById('q-urgency-instructions');
const qEscalationInstructions = document.getElementById('q-escalation-instructions');

const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const clearBtn = document.getElementById('clear-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');

let currentMode = 'single';
let latestTickets = [];

// ============================================================================
// Mode toggle
// ============================================================================

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    modeButtons.forEach((b) => b.classList.toggle('active', b === btn));
    singleModeEl.hidden = currentMode !== 'single';
    batchModeEl.hidden = currentMode !== 'batch';
    triageBtn.textContent = currentMode === 'batch' ? 'Triage All' : 'Triage Ticket';
    compareToggleLabel.hidden = currentMode !== 'single';
  });
});

document.querySelectorAll('.example-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const index = Number(btn.dataset.example);
    ticketText.value = SAMPLE_TICKETS[index];
  });
});

// ============================================================================
// Backends (compare-mode availability)
// ============================================================================

async function loadBackends() {
  const res = await fetch('/api/backends');
  const { typesafe } = await res.json();
  compareCheckbox.disabled = !typesafe;
  compareToggleLabel.title = typesafe
    ? ''
    : 'Requires TYPESAFE_API_KEY to be set on the server';
  compareToggleLabel.classList.toggle('disabled', !typesafe);
}

// ============================================================================
// Questions (editable prompts/criteria)
// ============================================================================

questionsToggleBtn.addEventListener('click', () => {
  questionsForm.hidden = !questionsForm.hidden;
  questionsToggleBtn.textContent = questionsForm.hidden ? 'Edit' : 'Hide';
});

function fillQuestionsForm(questions) {
  qCategoryInstructions.value = questions.category.instructions;
  for (const key of Object.keys(qCriteria)) {
    qCriteria[key].value = questions.category.criteria[key];
  }
  qUrgencyInstructions.value = questions.urgency.instructions;
  qEscalationInstructions.value = questions.needsHumanEscalation.instructions;
}

function readQuestionsForm() {
  return {
    category: {
      instructions: qCategoryInstructions.value,
      criteria: {
        billing: qCriteria.billing.value,
        technical: qCriteria.technical.value,
        account: qCriteria.account.value,
        other: qCriteria.other.value,
      },
    },
    urgency: { instructions: qUrgencyInstructions.value },
    needsHumanEscalation: { instructions: qEscalationInstructions.value },
  };
}

async function loadQuestions() {
  const res = await fetch('/api/questions');
  fillQuestionsForm(await res.json());
}

questionsSaveBtn.addEventListener('click', async () => {
  questionsStatus.textContent = 'Saving...';
  questionsStatus.classList.remove('error');
  try {
    const res = await fetch('/api/questions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readQuestionsForm()),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    fillQuestionsForm(data);
    questionsStatus.textContent = 'Saved. New tickets will use these questions.';
  } catch (error) {
    questionsStatus.textContent = error.message;
    questionsStatus.classList.add('error');
  }
});

questionsResetBtn.addEventListener('click', async () => {
  const res = await fetch('/api/questions/reset', { method: 'POST' });
  fillQuestionsForm(await res.json());
  questionsStatus.textContent = 'Reset to defaults.';
  questionsStatus.classList.remove('error');
});

// ============================================================================
// Triage
// ============================================================================

triageBtn.addEventListener('click', () => {
  void (currentMode === 'batch' ? triageBatch() : triageSingle());
});

async function triageSingle() {
  const text = ticketText.value.trim();
  if (!text) {
    setStatus('Enter some ticket text first.', true);
    return;
  }

  triageBtn.disabled = true;
  setStatus('Triaging...', false);

  try {
    const compare = compareCheckbox.checked && !compareCheckbox.disabled;
    const res = await fetch(compare ? '/api/triage/compare' : '/api/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    setStatus('', false);

    if (compare) {
      renderResultColumns([
        { label: 'Laya', ticket: data.laya },
        { label: 'TypeSafe (Jev)', ticket: data.typesafe, error: data.typesafeError },
      ]);
    } else {
      renderResultColumns([{ label: 'Laya', ticket: data }]);
    }
    await loadQueue();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    triageBtn.disabled = false;
  }
}

async function triageBatch() {
  const lines = batchText.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    setStatus('Enter at least one ticket (one per line).', true);
    return;
  }

  triageBtn.disabled = true;
  setStatus(`Triaging ${lines.length} ticket${lines.length === 1 ? '' : 's'}...`, false);

  try {
    const res = await fetch('/api/triage/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: lines }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    setStatus(`Triaged ${data.results.length} ticket${data.results.length === 1 ? '' : 's'}.`, false);
    await loadQueue();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    triageBtn.disabled = false;
  }
}

async function loadQueue() {
  const res = await fetch('/api/tickets');
  latestTickets = await res.json();
  renderQueue(latestTickets);
}

clearBtn.addEventListener('click', () => {
  void clearQueue();
});

async function clearQueue() {
  await fetch('/api/tickets', { method: 'DELETE' });
  resultPanel.hidden = true;
  await loadQueue();
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

// ============================================================================
// Export
// ============================================================================

function download(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

exportJsonBtn.addEventListener('click', () => {
  download('triage-tickets.json', JSON.stringify(latestTickets, null, 2), 'application/json');
});

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

exportCsvBtn.addEventListener('click', () => {
  const columns = [
    'id',
    'backend',
    'timestamp',
    'text',
    'category',
    'categoryConfidence',
    'urgencyLevel',
    'urgencyScore',
    'urgencyConfidence',
    'escalationLikely',
    'escalationConfidence',
    'latencyMs',
  ];
  const rows = latestTickets.map((t) => {
    const category = t.answers.category;
    const urgency = t.answers.urgency;
    const escalation = t.answers.needsHumanEscalation;
    return [
      t.id,
      t.backend,
      new Date(t.timestamp).toISOString(),
      t.text,
      category ? category.value : '',
      category ? category.confidence : '',
      urgency ? urgencyLevelFor(urgency.value) : '',
      urgency ? urgency.value : '',
      urgency ? urgency.confidence : '',
      escalation ? escalation.value : '',
      escalation && escalation.confidence !== undefined ? escalation.confidence : '',
      t.latencyMs,
    ]
      .map(csvField)
      .join(',');
  });
  download('triage-tickets.csv', [columns.join(','), ...rows].join('\n'), 'text/csv');
});

// ============================================================================
// Formatting helpers
// ============================================================================

function pct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

function urgencyClass(level) {
  return `urgency-${level}`;
}

// urgency.value is a probability-weighted expected value, not a
// guaranteed-in-range integer -- clamp before indexing URGENCY_LEVELS so
// an edge-case score can't silently mislabel via the array returning
// undefined.
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

// ============================================================================
// Result rendering (supports 1 column for a single call, 2 for compare)
// ============================================================================

function renderResultColumns(entries) {
  resultPanel.hidden = false;
  resultColumns.innerHTML = '';
  resultColumns.classList.toggle('two-up', entries.length > 1);

  for (const entry of entries) {
    resultColumns.appendChild(renderResultColumn(entry));
  }
}

function renderResultColumn({ label, ticket, error }) {
  const column = document.createElement('div');
  column.className = 'result-column';

  const header = document.createElement('div');
  header.className = 'result-header';
  const title = document.createElement('h3');
  title.textContent = label;
  header.appendChild(title);
  if (ticket && typeof ticket.latencyMs === 'number') {
    const latency = document.createElement('span');
    latency.className = 'latency-badge';
    latency.textContent = `${ticket.latencyMs.toFixed(0)}ms`;
    header.appendChild(latency);
  }
  column.appendChild(header);

  if (!ticket) {
    const message = document.createElement('p');
    message.className = 'empty-state';
    message.textContent = error || 'No result.';
    column.appendChild(message);
    return column;
  }

  const body = document.createElement('div');
  renderAnswers(body, ticket.answers);
  column.appendChild(body);

  const rawToggle = document.createElement('button');
  rawToggle.type = 'button';
  rawToggle.className = 'raw-toggle';
  rawToggle.textContent = 'View raw request/response';
  const rawView = document.createElement('pre');
  rawView.className = 'raw-view';
  rawView.hidden = true;
  rawView.textContent = JSON.stringify({ request: ticket.request, rawResponse: ticket.rawResponse }, null, 2);
  rawToggle.addEventListener('click', () => {
    rawView.hidden = !rawView.hidden;
    rawToggle.textContent = rawView.hidden ? 'View raw request/response' : 'Hide raw request/response';
  });
  column.appendChild(rawToggle);
  column.appendChild(rawView);

  return column;
}

function renderAnswers(container, answers) {
  const { category, urgency, needsHumanEscalation } = answers;

  if (category) {
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `<div class="answer-label">Category (confidence ${pct(category.confidence)})</div>
      <span class="badge">${category.value}</span>`;
    container.appendChild(row);

    const barsWrap = document.createElement('div');
    for (const name of CATEGORY_ORDER) {
      const p = category.probabilities[name] ?? 0;
      barsWrap.appendChild(bar(name, p));
    }
    container.appendChild(barsWrap);
  }

  if (urgency) {
    const nearestLevel = urgencyLevelFor(urgency.value);
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `<div class="answer-label">Urgency (score ${urgency.value.toFixed(2)}, confidence ${pct(urgency.confidence)})</div>
      <span class="badge">~${nearestLevel}</span>`;
    container.appendChild(row);

    const barsWrap = document.createElement('div');
    URGENCY_LEVELS.forEach((level, i) => {
      const p = urgency.probabilities[i] ?? 0;
      barsWrap.appendChild(bar(level, p, urgencyClass(level)));
    });
    container.appendChild(barsWrap);
  }

  if (needsHumanEscalation) {
    const confidence =
      needsHumanEscalation.confidence !== undefined ? pct(needsHumanEscalation.confidence) : 'n/a';
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `<div class="answer-label">Needs human escalation? (confidence ${confidence})</div>`;
    row.appendChild(bar('likely', needsHumanEscalation.value));
    container.appendChild(row);
  }
}

// ============================================================================
// Queue
// ============================================================================

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
    const backendTag = ticket.backend === 'typesafe' ? 'Jev' : '';
    meta.textContent = [category, backendTag, latency].filter(Boolean).join(' · ');

    li.appendChild(dot);
    li.appendChild(text);
    li.appendChild(meta);
    li.addEventListener('click', () => {
      renderResultColumns([{ label: ticket.backend === 'typesafe' ? 'TypeSafe (Jev)' : 'Laya', ticket }]);
    });

    queueList.appendChild(li);
  }
}

// ============================================================================
// Initial load
// ============================================================================

void loadBackends();
void loadQuestions();
void loadQueue();
