// Laya Ticket Triage Dashboard -- vanilla JS, no build step, no framework.
// Talks to the server's JSON API (server.ts): POST /api/triage,
// POST /api/triage/batch, POST /api/triage/compare, GET/PUT /api/questions,
// POST /api/questions/reset, GET /api/backends, GET/DELETE /api/tickets.
//
// Questions are fully dynamic (server.ts's QuestionMap, not a fixed
// category/urgency/escalation shape) -- so answer rendering below is
// schema-driven throughout: bar order comes from the ticket's own
// `request.questions` (the exact question set active when it was
// triaged), and bar/dot colors are computed from a 0..1 fraction rather
// than looked up by a fixed level name like "high"/"critical".

const SAMPLE_TICKETS = [
  "I was charged twice for my subscription this month and I can't reach anyone. This is the third time this has happened and I want a refund immediately.",
  'How do I change the display name on my profile? I looked in settings but could not find the option.',
  "The app crashes every time I try to export a report. I've lost two hours of work today because of this and I have a client deadline in an hour.",
  'Just wanted to say the new dashboard redesign looks great, nice work!',
];

// ============================================================================
// Color gradient (replaces the old fixed --low/--medium/--high/--critical
// lookup -- a dynamic question set has no fixed set of level names to key
// colors by, only a 0..1 "how high" fraction).
// ============================================================================

const GRADIENT_STOPS = [
  [0, [34, 197, 94]], // green
  [0.33, [234, 179, 8]], // yellow
  [0.66, [249, 115, 22]], // orange
  [1, [239, 68, 68]], // red
];

function colorForFraction(frac) {
  if (frac === null || frac === undefined) {
    return '#475569'; // neutral gray -- no priority question / no numeric answer
  }
  const f = Math.max(0, Math.min(1, frac));
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    const [f0, c0] = GRADIENT_STOPS[i];
    const [f1, c1] = GRADIENT_STOPS[i + 1];
    if (f >= f0 && f <= f1) {
      const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0);
      const rgb = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * t));
      return `rgb(${rgb.join(',')})`;
    }
  }
  return `rgb(${GRADIENT_STOPS[GRADIENT_STOPS.length - 1][1].join(',')})`;
}

// ============================================================================
// Elements
// ============================================================================

const singleModeEl = document.getElementById('single-mode');
const batchModeEl = document.getElementById('batch-mode');
const modeButtons = document.querySelectorAll('.mode-btn');
const stateFieldsInputsEl = document.getElementById('state-fields-inputs');
const examplesRow = document.getElementById('examples-row');
const batchText = document.getElementById('batch-text');
const batchUnavailable = document.getElementById('batch-unavailable');
const compareToggleLabel = document.getElementById('compare-toggle-label');
const compareCheckbox = document.getElementById('compare-checkbox');
const triageBtn = document.getElementById('triage-btn');
const statusEl = document.getElementById('status');

const resultPanel = document.getElementById('result-panel');
const resultColumns = document.getElementById('result-columns');

const stateFieldsToggleBtn = document.getElementById('state-fields-toggle-btn');
const stateFieldsForm = document.getElementById('state-fields-form');
const stateFieldsList = document.getElementById('state-fields-list');
const addStateFieldBtn = document.getElementById('add-state-field-btn');
const stateFieldsResetBtn = document.getElementById('state-fields-reset-btn');
const stateFieldsStatus = document.getElementById('state-fields-status');

const questionsToggleBtn = document.getElementById('questions-toggle-btn');
const questionsForm = document.getElementById('questions-form');
const questionsList = document.getElementById('questions-list');
const addQuestionBtn = document.getElementById('add-question-btn');
const prioritySelect = document.getElementById('priority-select');
const questionsResetBtn = document.getElementById('questions-reset-btn');
const questionsStatus = document.getElementById('questions-status');

const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const clearBtn = document.getElementById('clear-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');

let currentMode = 'single';
let latestTickets = [];
// The currently active state fields (from the server, not the editor draft)
// and the live <input>/<textarea> elements the ticket form renders for
// them -- kept separate from the editor's own draft state, same reasoning
// as the questions editor: the form the user is about to submit should
// reflect what's actually active, not an in-progress edit.
let activeStateFields = {};
let stateFieldInputs = {};

// ============================================================================
// Mode toggle
// ============================================================================

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    currentMode = btn.dataset.mode;
    modeButtons.forEach((b) => b.classList.toggle('active', b === btn));
    singleModeEl.hidden = currentMode !== 'single';
    batchModeEl.hidden = currentMode !== 'batch';
    triageBtn.textContent = currentMode === 'batch' ? 'Triage All' : 'Triage Ticket';
    compareToggleLabel.hidden = currentMode !== 'single';
  });
});

function firstTextFieldInput() {
  const name = Object.keys(activeStateFields).find((n) => activeStateFields[n].type === 'text');
  return name ? stateFieldInputs[name] : undefined;
}

document.querySelectorAll('.example-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const index = Number(btn.dataset.example);
    const input = firstTextFieldInput();
    if (input) {
      input.value = SAMPLE_TICKETS[index];
    }
  });
});

// ============================================================================
// Backends (compare-mode availability)
// ============================================================================

async function loadBackends() {
  const res = await fetch('/api/backends');
  const { typesafe } = await res.json();
  compareCheckbox.disabled = !typesafe;
  compareToggleLabel.title = typesafe ? '' : 'Requires TYPESAFE_API_KEY to be set on the server';
  compareToggleLabel.classList.toggle('disabled', !typesafe);
}

// ============================================================================
// Shared id counter for both the state-field editor and the question
// editor below -- editing needs stable row identity (add/remove) that's
// independent of the (possibly-being-edited, possibly-duplicate-mid-edit)
// field/question name.
// ============================================================================

let editorNextId = 1;
function newId() {
  return editorNextId++;
}

// ============================================================================
// State field editor -- what the ticket input form is made of (mirrors
// the question editor below). Also autosaves; see scheduleStateFieldsAutoSave.
// ============================================================================

let editorStateFields = [];

function stateFieldsToEditorState(stateFields) {
  return Object.entries(stateFields).map(([name, f]) => ({
    id: newId(),
    name,
    label: f.label,
    type: f.type,
  }));
}

function editorStateToStateFields() {
  const result = {};
  for (const f of editorStateFields) {
    const name = f.name.trim();
    if (!name || !f.label.trim()) continue; // Blank rows are dropped client-side; the server still rejects an empty result.
    result[name] = { label: f.label, type: f.type };
  }
  return result;
}

function renderStateFieldsEditor() {
  stateFieldsList.innerHTML = '';

  editorStateFields.forEach((f, index) => {
    const card = document.createElement('div');
    card.className = 'question-card';

    const header = document.createElement('div');
    header.className = 'question-card-header';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'question-name-input';
    nameInput.placeholder = 'name (e.g. accountAgeDays)';
    nameInput.value = f.name;
    nameInput.addEventListener('input', () => {
      f.name = nameInput.value;
      scheduleStateFieldsAutoSave();
    });

    const typeSelect = document.createElement('select');
    ['text', 'number', 'boolean'].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      opt.selected = t === f.type;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', () => {
      f.type = typeSelect.value;
      scheduleStateFieldsAutoSave();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      editorStateFields.splice(index, 1);
      renderStateFieldsEditor();
      scheduleStateFieldsAutoSave();
    });

    header.appendChild(nameInput);
    header.appendChild(typeSelect);
    header.appendChild(removeBtn);
    card.appendChild(header);

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'question-instructions-input';
    labelInput.placeholder = 'Display label (e.g. Account Age (days))';
    labelInput.value = f.label;
    labelInput.addEventListener('input', () => {
      f.label = labelInput.value;
      scheduleStateFieldsAutoSave();
    });
    card.appendChild(labelInput);

    stateFieldsList.appendChild(card);
  });
}

stateFieldsToggleBtn.addEventListener('click', () => {
  stateFieldsForm.hidden = !stateFieldsForm.hidden;
  stateFieldsToggleBtn.textContent = stateFieldsForm.hidden ? 'Edit' : 'Hide';
});

addStateFieldBtn.addEventListener('click', () => {
  editorStateFields.push({ id: newId(), name: '', label: '', type: 'text' });
  renderStateFieldsEditor();
  scheduleStateFieldsAutoSave();
});

async function loadStateFields() {
  const res = await fetch('/api/state-fields');
  const { stateFields } = await res.json();
  editorStateFields = stateFieldsToEditorState(stateFields);
  renderStateFieldsEditor();
  applyActiveStateFields(stateFields);
}

let stateFieldsAutoSaveTimer;

function scheduleStateFieldsAutoSave() {
  clearTimeout(stateFieldsAutoSaveTimer);
  stateFieldsAutoSaveTimer = setTimeout(() => {
    void saveStateFields();
  }, 500);
}

async function saveStateFields() {
  const stateFields = editorStateToStateFields();
  if (Object.keys(stateFields).length === 0) {
    return;
  }
  stateFieldsStatus.textContent = 'Saving...';
  stateFieldsStatus.classList.remove('error');
  try {
    const res = await fetch('/api/state-fields', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateFields }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    applyActiveStateFields(data.stateFields);
    stateFieldsStatus.textContent = 'Saved.';
  } catch (error) {
    stateFieldsStatus.textContent = error.message;
    stateFieldsStatus.classList.add('error');
  }
}

stateFieldsResetBtn.addEventListener('click', async () => {
  clearTimeout(stateFieldsAutoSaveTimer);
  const res = await fetch('/api/state-fields/reset', { method: 'POST' });
  const { stateFields } = await res.json();
  editorStateFields = stateFieldsToEditorState(stateFields);
  renderStateFieldsEditor();
  applyActiveStateFields(stateFields);
  stateFieldsStatus.textContent = 'Reset to defaults.';
  stateFieldsStatus.classList.remove('error');
});

// ----------------------------------------------------------------------------
// The actual ticket input form (#state-fields-inputs) is rebuilt whenever
// the active field set changes -- this is separate from the editor form
// above, and IS safe to rebuild on every save (unlike the editor, it's not
// something the user is mid-way through typing into when a save completes;
// it's the target of the next Triage click).
// ----------------------------------------------------------------------------

function applyActiveStateFields(stateFields) {
  activeStateFields = stateFields;
  renderTicketInputs();
  updateBatchAvailability();
}

function renderTicketInputs() {
  const previousValues = gatherStateValues();
  stateFieldsInputsEl.innerHTML = '';
  stateFieldInputs = {};

  for (const [name, field] of Object.entries(activeStateFields)) {
    const wrap = document.createElement('label');
    wrap.className = 'state-field-input-label';
    wrap.textContent = field.label;

    let input;
    if (field.type === 'text') {
      input = document.createElement('textarea');
      input.rows = 4;
      input.placeholder = `${field.label}...`;
    } else if (field.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
    } else {
      input = document.createElement('input');
      input.type = 'checkbox';
      wrap.classList.add('checkbox-label');
    }

    // Preserve values across a field-set reload when the field itself is unchanged.
    if (Object.prototype.hasOwnProperty.call(previousValues, name)) {
      if (field.type === 'boolean') {
        input.checked = Boolean(previousValues[name]);
      } else {
        input.value = previousValues[name];
      }
    }

    stateFieldInputs[name] = input;
    wrap.appendChild(input);
    stateFieldsInputsEl.appendChild(wrap);
  }

  examplesRow.hidden = !firstTextFieldInput();
}

function gatherStateValues() {
  const values = {};
  for (const [name, field] of Object.entries(activeStateFields)) {
    const input = stateFieldInputs[name];
    if (!input) continue;
    if (field.type === 'boolean') {
      values[name] = input.checked;
    } else if (field.type === 'number') {
      values[name] = input.value === '' ? '' : input.valueAsNumber;
    } else {
      values[name] = input.value;
    }
  }
  return values;
}

function updateBatchAvailability() {
  const names = Object.keys(activeStateFields);
  const available = names.length === 1 && activeStateFields[names[0]].type === 'text';
  const batchModeBtn = Array.from(modeButtons).find((b) => b.dataset.mode === 'batch');
  batchModeBtn.disabled = !available;
  batchModeBtn.title = available ? '' : 'Batch mode needs exactly one state field, of type Text';
  batchText.hidden = !available;
  batchUnavailable.hidden = available;
  if (!available && currentMode === 'batch') {
    // The field set changed out from under an active batch session -- fall
    // back to single mode rather than leaving a dead, unsubmittable form up.
    Array.from(modeButtons)
      .find((b) => b.dataset.mode === 'single')
      .click();
  }
}

// ============================================================================
// Question editor -- a dynamic form builder, not fixed fields. State is
// an array (editorQuestions) rather than the wire object, since editing
// needs stable identity for rows (add/remove) independent of the
// (possibly-being-edited, possibly-duplicate-mid-edit) question name.
// ============================================================================

let editorQuestions = [];

function questionsToEditorState(questions) {
  return Object.entries(questions).map(([name, q]) => {
    if (q.type === 'choice') {
      return {
        id: newId(),
        name,
        type: 'choice',
        instructions: q.instructions,
        options: Object.entries(q.criteria).map(([key, description]) => ({
          id: newId(),
          key,
          description,
        })),
        levels: [],
      };
    }
    if (q.type === 'score') {
      return {
        id: newId(),
        name,
        type: 'score',
        instructions: q.instructions,
        options: [],
        levels: q.criteria.map((label) => ({ id: newId(), label })),
      };
    }
    return { id: newId(), name, type: 'noul', instructions: q.instructions, options: [], levels: [] };
  });
}

function editorStateToQuestions() {
  const result = {};
  for (const q of editorQuestions) {
    const name = q.name.trim();
    if (!name) continue; // Blank rows are dropped client-side; the server still rejects an empty result.
    if (q.type === 'choice') {
      const criteria = {};
      for (const opt of q.options) {
        if (opt.key.trim()) {
          criteria[opt.key.trim()] = opt.description;
        }
      }
      result[name] = { type: 'choice', instructions: q.instructions, criteria };
    } else if (q.type === 'score') {
      result[name] = { type: 'score', instructions: q.instructions, criteria: q.levels.map((l) => l.label) };
    } else {
      result[name] = { type: 'noul', instructions: q.instructions };
    }
  }
  return result;
}

function refreshPrioritySelect() {
  const previousValue = prioritySelect.value;
  prioritySelect.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(none)';
  prioritySelect.appendChild(noneOpt);
  for (const q of editorQuestions) {
    if ((q.type === 'score' || q.type === 'noul') && q.name.trim()) {
      const opt = document.createElement('option');
      opt.value = q.name.trim();
      opt.textContent = `${q.name.trim()} (${q.type})`;
      prioritySelect.appendChild(opt);
    }
  }
  const stillValid = Array.from(prioritySelect.options).some((o) => o.value === previousValue);
  prioritySelect.value = stillValid ? previousValue : '';
}

function renderQuestionEditor() {
  questionsList.innerHTML = '';

  editorQuestions.forEach((q, qIndex) => {
    const card = document.createElement('div');
    card.className = 'question-card';

    const header = document.createElement('div');
    header.className = 'question-card-header';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'question-name-input';
    nameInput.placeholder = 'name (e.g. urgency)';
    nameInput.value = q.name;
    nameInput.addEventListener('input', () => {
      q.name = nameInput.value;
      refreshPrioritySelect();
      scheduleAutoSave();
    });

    const typeSelect = document.createElement('select');
    ['choice', 'score', 'noul'].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      opt.selected = t === q.type;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', () => {
      q.type = typeSelect.value;
      if (q.type === 'choice' && q.options.length === 0) {
        q.options = [
          { id: newId(), key: '', description: '' },
          { id: newId(), key: '', description: '' },
        ];
      }
      if (q.type === 'score' && q.levels.length === 0) {
        q.levels = [
          { id: newId(), label: '' },
          { id: newId(), label: '' },
        ];
      }
      renderQuestionEditor();
      scheduleAutoSave();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      editorQuestions.splice(qIndex, 1);
      renderQuestionEditor();
      scheduleAutoSave();
    });

    header.appendChild(nameInput);
    header.appendChild(typeSelect);
    header.appendChild(removeBtn);
    card.appendChild(header);

    const instructionsInput = document.createElement('input');
    instructionsInput.type = 'text';
    instructionsInput.className = 'question-instructions-input';
    instructionsInput.placeholder = 'Prompt / instructions';
    instructionsInput.value = q.instructions;
    instructionsInput.addEventListener('input', () => {
      q.instructions = instructionsInput.value;
      scheduleAutoSave();
    });
    card.appendChild(instructionsInput);

    if (q.type === 'choice') {
      card.appendChild(renderOptionsEditor(q));
    } else if (q.type === 'score') {
      card.appendChild(renderLevelsEditor(q));
    }

    questionsList.appendChild(card);
  });

  refreshPrioritySelect();
}

function renderOptionsEditor(question) {
  const wrap = document.createElement('div');
  wrap.className = 'options-wrap';

  question.options.forEach((opt, oIndex) => {
    const row = document.createElement('div');
    row.className = 'option-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'key (e.g. billing)';
    keyInput.value = opt.key;
    keyInput.addEventListener('input', () => {
      opt.key = keyInput.value;
      scheduleAutoSave();
    });

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.placeholder = 'description';
    descInput.value = opt.description;
    descInput.addEventListener('input', () => {
      opt.description = descInput.value;
      scheduleAutoSave();
    });

    const removeOptBtn = document.createElement('button');
    removeOptBtn.type = 'button';
    removeOptBtn.className = 'remove-btn small';
    removeOptBtn.textContent = '×';
    removeOptBtn.addEventListener('click', () => {
      question.options.splice(oIndex, 1);
      renderQuestionEditor();
      scheduleAutoSave();
    });

    row.appendChild(keyInput);
    row.appendChild(descInput);
    row.appendChild(removeOptBtn);
    wrap.appendChild(row);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'secondary-btn small';
  addBtn.textContent = '+ Add option';
  addBtn.addEventListener('click', () => {
    question.options.push({ id: newId(), key: '', description: '' });
    renderQuestionEditor();
    scheduleAutoSave();
  });
  wrap.appendChild(addBtn);

  return wrap;
}

function renderLevelsEditor(question) {
  const wrap = document.createElement('div');
  wrap.className = 'levels-wrap';

  question.levels.forEach((lvl, lIndex) => {
    const row = document.createElement('div');
    row.className = 'level-row';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = `level ${lIndex + 1} (low -> high)`;
    labelInput.value = lvl.label;
    labelInput.addEventListener('input', () => {
      lvl.label = labelInput.value;
      scheduleAutoSave();
    });

    const removeLvlBtn = document.createElement('button');
    removeLvlBtn.type = 'button';
    removeLvlBtn.className = 'remove-btn small';
    removeLvlBtn.textContent = '×';
    removeLvlBtn.addEventListener('click', () => {
      question.levels.splice(lIndex, 1);
      renderQuestionEditor();
      scheduleAutoSave();
    });

    row.appendChild(labelInput);
    row.appendChild(removeLvlBtn);
    wrap.appendChild(row);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'secondary-btn small';
  addBtn.textContent = '+ Add level';
  addBtn.addEventListener('click', () => {
    question.levels.push({ id: newId(), label: '' });
    renderQuestionEditor();
    scheduleAutoSave();
  });
  wrap.appendChild(addBtn);

  return wrap;
}

questionsToggleBtn.addEventListener('click', () => {
  questionsForm.hidden = !questionsForm.hidden;
  questionsToggleBtn.textContent = questionsForm.hidden ? 'Edit' : 'Hide';
});

addQuestionBtn.addEventListener('click', () => {
  editorQuestions.push({ id: newId(), name: '', type: 'noul', instructions: '', options: [], levels: [] });
  renderQuestionEditor();
  scheduleAutoSave();
});

prioritySelect.addEventListener('change', () => {
  scheduleAutoSave();
});

async function loadQuestions() {
  const res = await fetch('/api/questions');
  const { questions, priorityQuestion } = await res.json();
  editorQuestions = questionsToEditorState(questions);
  renderQuestionEditor();
  prioritySelect.value = priorityQuestion || '';
}

// ----------------------------------------------------------------------------
// Auto-save: debounced so a keystroke doesn't fire a request per character,
// but any structural change (add/remove a question or option/level, switch
// a type, change the priority question) still goes through the same path.
// Deliberately does NOT re-render the editor from the server's response on
// success -- doing so would overwrite an in-progress edit (e.g. a
// just-added, not-yet-named question) the moment the debounce fires. The
// editor's local state stays the source of truth for the form; the
// server's response only confirms what's now active for the next triage
// call. A response with zero valid (named) questions is skipped entirely
// rather than sent -- that's a normal mid-edit state (e.g. right after
// "+ Add question", before typing a name), not an error to surface.
// ----------------------------------------------------------------------------

let autoSaveTimer;

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    void saveQuestions();
  }, 500);
}

async function saveQuestions() {
  const questions = editorStateToQuestions();
  if (Object.keys(questions).length === 0) {
    return;
  }
  const priorityQuestion = prioritySelect.value || null;
  questionsStatus.textContent = 'Saving...';
  questionsStatus.classList.remove('error');
  try {
    const res = await fetch('/api/questions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions, priorityQuestion }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    questionsStatus.textContent = 'Saved.';
  } catch (error) {
    questionsStatus.textContent = error.message;
    questionsStatus.classList.add('error');
  }
}

questionsResetBtn.addEventListener('click', async () => {
  clearTimeout(autoSaveTimer);
  const res = await fetch('/api/questions/reset', { method: 'POST' });
  const { questions, priorityQuestion } = await res.json();
  editorQuestions = questionsToEditorState(questions);
  renderQuestionEditor();
  prioritySelect.value = priorityQuestion || '';
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
  const values = gatherStateValues();
  if (Object.values(values).every((v) => v === '' || v === null || v === undefined)) {
    setStatus('Fill in at least one field first.', true);
    return;
  }

  triageBtn.disabled = true;
  setStatus('Triaging...', false);

  try {
    const compare = compareCheckbox.checked && !compareCheckbox.disabled;
    const res = await fetch(compare ? '/api/triage/compare' : '/api/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
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
      body: JSON.stringify({ lines }),
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
  // Columns are derived from whatever state fields and questions actually
  // appear across the exported tickets -- there's no fixed schema to
  // hardcode column names against anymore.
  const stateNames = new Set();
  const questionNames = new Set();
  latestTickets.forEach((t) => {
    Object.keys(t.request.state || {}).forEach((name) => stateNames.add(name));
    Object.keys(t.answers).forEach((name) => questionNames.add(name));
  });
  const stateColumns = Array.from(stateNames);
  const questionColumns = Array.from(questionNames);

  const columns = [
    'id',
    'backend',
    'timestamp',
    ...stateColumns,
    'priorityValue',
    'latencyMs',
    ...questionColumns.flatMap((n) => [n, `${n}.confidence`]),
  ];
  const rows = latestTickets.map((t) => {
    const base = [t.id, t.backend, new Date(t.timestamp).toISOString()];
    const state = stateColumns.map((n) => (t.request.state || {})[n] ?? '');
    const tail = [t.priorityValue ?? '', t.latencyMs];
    const perQuestion = questionColumns.flatMap((n) => {
      const a = t.answers[n];
      return [a ? a.value : '', a && a.confidence !== undefined ? a.confidence : ''];
    });
    return [...base, ...state, ...tail, ...perQuestion].map(csvField).join(',');
  });
  download('triage-tickets.csv', [columns.join(','), ...rows].join('\n'), 'text/csv');
});

// ============================================================================
// Formatting helpers
// ============================================================================

function pct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

function bar(name, p, color) {
  const row = document.createElement('div');
  row.className = 'bar-track';
  const innerStyle = `width:${(p * 100).toFixed(1)}%${color ? `;background:${color}` : ''}`;
  row.innerHTML = `
    <span class="bar-name">${name}</span>
    <span class="bar-outer"><span class="bar-inner" style="${innerStyle}"></span></span>
    <span class="bar-pct">${pct(p)}</span>
  `;
  return row;
}

// ============================================================================
// Result rendering (supports 1 column for a single call, 2 for compare).
// Schema-driven: answer order/labels come from `ticket.request.questions`,
// the exact question set that was active when this ticket was triaged --
// not from any fixed constant, since a later question-set edit shouldn't
// change how an already-triaged ticket renders.
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
  renderAnswers(body, ticket.answers, ticket.request ? ticket.request.questions : undefined);
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

function renderAnswers(container, answers, questions) {
  for (const [name, answer] of Object.entries(answers)) {
    const question = questions ? questions[name] : undefined;

    if (answer.type === 'choice') {
      const optionKeys =
        question && question.type === 'choice' ? Object.keys(question.criteria) : Object.keys(answer.probabilities);

      const row = document.createElement('div');
      row.className = 'answer-row';
      row.innerHTML = `<div class="answer-label">${name} (confidence ${pct(answer.confidence)})</div>
        <span class="badge">${answer.value}</span>`;
      container.appendChild(row);

      const barsWrap = document.createElement('div');
      for (const key of optionKeys) {
        barsWrap.appendChild(bar(key, answer.probabilities[key] ?? 0));
      }
      container.appendChild(barsWrap);
      continue;
    }

    if (answer.type === 'score') {
      const levels =
        question && question.type === 'score'
          ? question.criteria
          : answer.probabilities.map((_, i) => String(i));
      const nearestIndex = Math.max(0, Math.min(levels.length - 1, Math.round(answer.value)));
      const nearestLabel = levels[nearestIndex] ?? String(answer.value);

      const row = document.createElement('div');
      row.className = 'answer-row';
      row.innerHTML = `<div class="answer-label">${name} (score ${answer.value.toFixed(2)}, confidence ${pct(answer.confidence)})</div>
        <span class="badge">~${nearestLabel}</span>`;
      container.appendChild(row);

      const barsWrap = document.createElement('div');
      levels.forEach((label, i) => {
        const p = answer.probabilities[i] ?? 0;
        const frac = levels.length > 1 ? i / (levels.length - 1) : 0;
        barsWrap.appendChild(bar(label, p, colorForFraction(frac)));
      });
      container.appendChild(barsWrap);
      continue;
    }

    // noul
    const confidence = answer.confidence !== undefined ? pct(answer.confidence) : 'n/a';
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `<div class="answer-label">${name} (confidence ${confidence})</div>`;
    row.appendChild(bar('likely', answer.value, colorForFraction(answer.value)));
    container.appendChild(row);
  }
}

// ============================================================================
// Queue
// ============================================================================

function summarize(ticket) {
  const first = Object.entries(ticket.answers)[0];
  if (!first) return '';
  const [name, answer] = first;
  if (answer.type === 'score') return `${name}: ${answer.value.toFixed(1)}`;
  return `${name}: ${answer.value}`;
}

// State is a dynamic, possibly-multi-field record now -- there's no single
// "text" field to display, so join every value into one summary line.
function summarizeState(state) {
  return Object.values(state || {})
    .map((v) => String(v))
    .join(' · ');
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

  // Already sorted newest-first by the server; re-sort by priority value
  // descending, with tickets that have no priority value (no priority
  // question configured, or the priority question wasn't part of this
  // ticket's question set) kept at the bottom rather than treated as
  // lowest-priority.
  const sorted = [...tickets].sort((a, b) => {
    if (a.priorityValue === null && b.priorityValue === null) return 0;
    if (a.priorityValue === null) return 1;
    if (b.priorityValue === null) return -1;
    return b.priorityValue - a.priorityValue;
  });

  for (const ticket of sorted) {
    const li = document.createElement('li');
    li.className = 'queue-item';

    const dot = document.createElement('span');
    dot.className = 'queue-priority-dot';
    dot.style.background = colorForFraction(ticket.priorityValue);

    const text = document.createElement('span');
    text.className = 'queue-item-text';
    text.textContent = summarizeState(ticket.request.state);

    const meta = document.createElement('span');
    meta.className = 'queue-item-meta';
    const backendTag = ticket.backend === 'typesafe' ? 'Jev' : '';
    const latency = typeof ticket.latencyMs === 'number' ? `${ticket.latencyMs.toFixed(0)}ms` : '';
    meta.textContent = [summarize(ticket), backendTag, latency].filter(Boolean).join(' · ');

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
void loadStateFields();
void loadQuestions();
void loadQueue();
