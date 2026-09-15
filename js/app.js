// app.js — full UI wiring for the 홈트 & 러닝 트래커.
// Renders the auto-rotating '오늘 훈련' view, fast mobile per-set logging,
// goal-vs-actual + pace evaluation, progression suggestions, and the '기록'
// history view (editable/deletable). '추이' is a placeholder for FEAT-003.
//
// PURE logic lives in progression.js / data.js. Persistence lives in storage.js.
// This module only does DOM wiring and formatting.

import { getSplit, getSplits, getRun, getExercise, SPLIT_IDS } from './data.js';
import {
  saveSession,
  getAllSessions,
  getSessionsForExercise,
  getNextSplitId,
  deleteSession,
  updateSession,
} from './storage.js';
import {
  goalVsActual,
  evaluatePace,
  suggestProgression,
  rirGuidance,
  SUGGESTION_TYPE,
  PACE_RESULT,
} from './progression.js';
import { lineChartSvg, barChartSvg, trendDirection, EMPTY_STATE_TEXT } from './charts.js';

// --- Small formatting / DOM helpers -----------------------------------------

// Escape user-derived text before injecting into innerHTML.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// seconds/km -> "m:ss"
function formatPace(secPerKm) {
  if (typeof secPerKm !== 'number' || !isFinite(secPerKm) || secPerKm <= 0) return '—';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// "m:ss" or "m:s" or bare seconds -> seconds/km (or null when unparseable)
function parsePace(minStr, secStr) {
  const min = Number(minStr);
  const sec = Number(secStr);
  if (!Number.isFinite(min) && !Number.isFinite(sec)) return null;
  const m = Number.isFinite(min) ? min : 0;
  const s = Number.isFinite(sec) ? sec : 0;
  if (m === 0 && s === 0) return null;
  return m * 60 + s;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function splitName(splitId) {
  const split = getSplit(splitId);
  return split ? split.name : '알 수 없음';
}

// Build a target-range label for a strength exercise.
function targetLabel(ex) {
  const perLeg = ex.perLeg ? ' (다리당)' : '';
  return `목표 ${ex.repMin}~${ex.repMax}회 x ${ex.sets}세트${perLeg}`;
}

function statusClass(status) {
  if (status === 'within') return 'status-ok';
  if (status === 'below') return 'status-warn';
  if (status === 'above') return 'status-warn';
  return 'muted';
}

function statusLabel(status) {
  if (status === 'within') return '목표 범위';
  if (status === 'below') return '목표 미만';
  if (status === 'above') return '목표 초과';
  return '';
}

function paceStatusClass(result) {
  if (result === PACE_RESULT.WITHIN) return 'status-ok';
  return 'status-warn';
}

// --- View switching ----------------------------------------------------------

function switchView(viewId) {
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== viewId;
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === viewId);
  });
}

function initNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

// =============================================================================
// 오늘 훈련 (Today) view
// =============================================================================

// Collect the last two sessions' set-entries for an exercise (oldest→newest),
// used to drive suggestProgression.
function lastTwoEntriesFor(exerciseId) {
  const all = getSessionsForExercise(exerciseId); // stored oldest→newest
  return all.slice(-2).map((s) => s.entries);
}

// Render a suggestion banner (weight/rep increase) or the hold note.
function suggestionMarkup(ex) {
  const lastTwo = lastTwoEntriesFor(ex.id);
  const res = suggestProgression(ex, lastTwo);
  if (res.type === SUGGESTION_TYPE.INCREASE_WEIGHT) {
    return `<p class="suggestion suggestion--go">⬆ 다음 회차: 소폭 증량 +${esc(res.deltaKg)}kg 또는 +1~2회<br /><span class="muted">${esc(res.reason)}</span></p>`;
  }
  if (res.type === SUGGESTION_TYPE.INCREASE_REPS) {
    return `<p class="suggestion suggestion--go">⬆ 다음 회차: 세트당 +${esc(res.deltaReps)}회<br /><span class="muted">${esc(res.reason)}</span></p>`;
  }
  return `<p class="suggestion muted">${esc(res.reason)}</p>`;
}

// One set row for a strength exercise.
function setRowMarkup(ex, index, weight, reps) {
  return `
    <div class="set-row" data-set-index="${index}">
      <span class="set-no">${index + 1}세트</span>
      <label class="field">
        <span class="field-label">kg</span>
        <input type="number" inputmode="numeric" step="0.5" min="0"
          class="input-weight" value="${esc(weight)}" aria-label="${esc(ex.name)} ${index + 1}세트 무게(kg)" />
      </label>
      <label class="field">
        <span class="field-label">회</span>
        <input type="number" inputmode="numeric" step="1" min="0"
          class="input-reps" value="${esc(reps)}" aria-label="${esc(ex.name)} ${index + 1}세트 횟수" />
      </label>
      <button type="button" class="btn set-remove" aria-label="세트 삭제">−</button>
    </div>`;
}

function strengthExerciseMarkup(ex) {
  const rows = Array.from({ length: ex.sets }, (_, i) =>
    setRowMarkup(ex, i, ex.defaultWeightKg, '')
  ).join('');

  return `
    <div class="card exercise" data-exercise-id="${esc(ex.id)}">
      <h3>${esc(ex.name)}</h3>
      <p class="muted target">${esc(targetLabel(ex))}</p>
      ${suggestionMarkup(ex)}
      <div class="sets">${rows}</div>
      <div class="set-actions">
        <button type="button" class="btn set-add">+ 세트 추가</button>
      </div>
      <p class="goal-actual muted" aria-live="polite"></p>
    </div>`;
}

function runningMarkup() {
  const easy = getRun('easy');
  const interval = getRun('interval');
  return `
    <div class="card exercise" data-run="true">
      <h3>러닝</h3>
      <p class="muted">이지런 ${easy.distanceMinKm}~${easy.distanceMaxKm}km · ${formatPace(easy.paceMinSecPerKm)}~${formatPace(easy.paceMaxSecPerKm)}/km · ${esc(easy.note)}</p>
      <p class="muted">인터벌 ${interval.distanceMinKm}~${interval.distanceMaxKm}km · 반복 구간 ${formatPace(interval.paceMinSecPerKm)}~${formatPace(interval.paceMaxSecPerKm)}/km</p>
      <label class="field field--block">
        <span class="field-label">유형</span>
        <select class="input-run-type">
          <option value="easy">이지런 (조깅)</option>
          <option value="interval">인터벌</option>
        </select>
      </label>
      <label class="field field--block">
        <span class="field-label">거리 (km)</span>
        <input type="number" inputmode="decimal" step="0.1" min="0" class="input-distance" placeholder="예: 6" aria-label="러닝 거리(km)" />
      </label>
      <div class="field field--block">
        <span class="field-label">전체 평균 페이스 (분:초 /km)</span>
        <div class="pace-inputs">
          <input type="number" inputmode="numeric" step="1" min="0" class="input-pace-min" placeholder="분" aria-label="전체 평균 페이스 분" />
          <span class="pace-sep">:</span>
          <input type="number" inputmode="numeric" step="1" min="0" max="59" class="input-pace-sec" placeholder="초" aria-label="전체 평균 페이스 초" />
        </div>
      </div>
      <div class="field field--block rep-pace-field" hidden>
        <span class="field-label">반복 구간 페이스 (1km 반복, 분:초 /km)</span>
        <div class="pace-inputs">
          <input type="number" inputmode="numeric" step="1" min="0" class="input-rep-pace-min" placeholder="분" aria-label="반복 구간 페이스 분" />
          <span class="pace-sep">:</span>
          <input type="number" inputmode="numeric" step="1" min="0" max="59" class="input-rep-pace-sec" placeholder="초" aria-label="반복 구간 페이스 초" />
        </div>
      </div>
      <p class="goal-actual muted" aria-live="polite"></p>
    </div>`;
}

function renderToday() {
  const view = document.getElementById('view-today');
  if (!view) return;

  const splitId = getNextSplitId();
  const split = getSplit(splitId);

  if (!split) {
    view.innerHTML = `<div class="card"><p class="status-danger">루틴 정보를 불러오지 못했습니다.</p></div>`;
    return;
  }

  const isRunning = split.type === 'running';
  const exercisesMarkup = isRunning
    ? runningMarkup()
    : split.exercises.map(strengthExerciseMarkup).join('');

  view.innerHTML = `
    <div class="card">
      <h2>오늘 훈련 · <span class="split-name">${esc(split.name)}</span></h2>
      <label class="field field--block">
        <span class="field-label">날짜</span>
        <input type="date" id="today-date" value="${todayIso()}" />
      </label>
      <p class="rir-note">${esc(rirGuidance())}</p>
    </div>
    ${exercisesMarkup}
    <div class="card save-bar">
      <button type="button" id="save-session" class="btn btn-primary">이 세션 저장</button>
      <p id="save-status" class="muted" aria-live="polite"></p>
    </div>
  `;

  view.dataset.splitId = splitId;
  wireTodayEvents(view, split);
}

// Read strength entries out of one exercise card's inputs.
function readExerciseEntries(card) {
  const rows = card.querySelectorAll('.set-row');
  const entries = [];
  rows.forEach((row) => {
    const weightRaw = row.querySelector('.input-weight').value;
    const repsRaw = row.querySelector('.input-reps').value;
    const reps = Number(repsRaw);
    const weightKg = Number(weightRaw);
    // Only count rows that have a rep value entered.
    if (repsRaw !== '' && Number.isFinite(reps)) {
      entries.push({
        weightKg: Number.isFinite(weightKg) ? weightKg : 0,
        reps,
      });
    }
  });
  return entries;
}

// Update the inline goal-vs-actual line for a strength exercise card.
function refreshGoalActual(card, ex) {
  const target = card.querySelector('.goal-actual');
  if (!target) return;
  const entries = readExerciseEntries(card);
  if (entries.length === 0) {
    target.textContent = '';
    target.className = 'goal-actual muted';
    return;
  }
  const gva = goalVsActual(ex, entries);
  if (!gva) {
    target.textContent = '';
    return;
  }
  target.className = `goal-actual ${statusClass(gva.status)}`;
  const perLegNote = ex.perLeg ? ' (다리당)' : '';
  target.textContent = `총 횟수 ${gva.actualVolume}회 / 목표 ${gva.targetMinVolume}~${gva.targetMaxVolume}회${perLegNote} · ${statusLabel(gva.status)}`;
}

// Show/hide the rep-segment pace field based on the selected run type.
function syncRepPaceVisibility(card) {
  const type = card.querySelector('.input-run-type').value;
  const field = card.querySelector('.rep-pace-field');
  if (field) field.hidden = type !== 'interval';
}

// Update the inline pace evaluation line for the running card.
// The interval band grades the REP-SEGMENT pace, so interval sessions are
// evaluated against the rep-segment input; easy runs use the whole-run pace.
function refreshRunEval(card) {
  const target = card.querySelector('.goal-actual');
  if (!target) return;
  const type = card.querySelector('.input-run-type').value;
  const runDef = getRun(type);
  const wholePaceSec = parsePace(
    card.querySelector('.input-pace-min').value,
    card.querySelector('.input-pace-sec').value
  );

  if (type === 'interval') {
    const repPaceSec = parsePace(
      card.querySelector('.input-rep-pace-min').value,
      card.querySelector('.input-rep-pace-sec').value
    );
    if (repPaceSec == null || !runDef) {
      target.textContent = wholePaceSec != null
        ? `전체 평균 ${formatPace(wholePaceSec)}/km · 반복 구간 페이스를 입력하면 목표 대비 평가를 보여줍니다.`
        : '';
      target.className = 'goal-actual muted';
      return;
    }
    const res = evaluatePace(repPaceSec, runDef);
    target.className = `goal-actual ${paceStatusClass(res.result)}`;
    const wholeLabel = wholePaceSec != null ? `전체 평균 ${formatPace(wholePaceSec)}/km · ` : '';
    target.textContent = `${wholeLabel}반복 구간 ${formatPace(repPaceSec)}/km · ${res.message}`;
    return;
  }

  if (wholePaceSec == null || !runDef) {
    target.textContent = '';
    target.className = 'goal-actual muted';
    return;
  }
  const res = evaluatePace(wholePaceSec, runDef);
  target.className = `goal-actual ${paceStatusClass(res.result)}`;
  target.textContent = `기록 페이스 ${formatPace(wholePaceSec)}/km · ${res.message}`;
}

function wireTodayEvents(view, split) {
  const isRunning = split.type === 'running';

  if (!isRunning) {
    view.querySelectorAll('.exercise').forEach((card) => {
      const exId = card.dataset.exerciseId;
      const ex = split.exercises.find((e) => e.id === exId);
      if (!ex) return;

      // Live goal-vs-actual on any input change.
      card.addEventListener('input', () => refreshGoalActual(card, ex));

      // Add a set row.
      const setsEl = card.querySelector('.sets');
      card.querySelector('.set-add').addEventListener('click', () => {
        const nextIndex = setsEl.querySelectorAll('.set-row').length;
        setsEl.insertAdjacentHTML(
          'beforeend',
          setRowMarkup(ex, nextIndex, ex.defaultWeightKg, '')
        );
        reindexSets(setsEl);
      });

      // Remove a set row (event delegation).
      setsEl.addEventListener('click', (evt) => {
        const btn = evt.target.closest('.set-remove');
        if (!btn) return;
        const row = btn.closest('.set-row');
        if (row && setsEl.querySelectorAll('.set-row').length > 1) {
          row.remove();
          reindexSets(setsEl);
        }
        refreshGoalActual(card, ex);
      });
    });
  } else {
    const runCard = view.querySelector('.exercise[data-run="true"]');
    if (runCard) {
      syncRepPaceVisibility(runCard);
      runCard.addEventListener('input', () => refreshRunEval(runCard));
      runCard.addEventListener('change', () => {
        syncRepPaceVisibility(runCard);
        refreshRunEval(runCard);
      });
    }
  }

  const saveBtn = view.querySelector('#save-session');
  if (saveBtn) saveBtn.addEventListener('click', () => handleSave(view, split));
}

// Re-label set numbers after add/remove.
function reindexSets(setsEl) {
  setsEl.querySelectorAll('.set-row').forEach((row, i) => {
    row.dataset.setIndex = i;
    const label = row.querySelector('.set-no');
    if (label) label.textContent = `${i + 1}세트`;
  });
}

function handleSave(view, split) {
  const status = view.querySelector('#save-status');
  const date = (view.querySelector('#today-date') || {}).value || todayIso();
  const splitId = split.id;

  const session = { date, splitId };

  if (split.type === 'running') {
    const runCard = view.querySelector('.exercise[data-run="true"]');
    const type = runCard.querySelector('.input-run-type').value;
    const distanceKm = Number(runCard.querySelector('.input-distance').value);
    const paceSecPerKm = parsePace(
      runCard.querySelector('.input-pace-min').value,
      runCard.querySelector('.input-pace-sec').value
    );
    if (!Number.isFinite(distanceKm) || distanceKm <= 0 || paceSecPerKm == null) {
      setStatus(status, '거리와 전체 평균 페이스를 입력하세요.', true);
      return;
    }
    session.run = { distanceKm, paceSecPerKm, type };
    if (type === 'interval') {
      const repPaceSecPerKm = parsePace(
        runCard.querySelector('.input-rep-pace-min').value,
        runCard.querySelector('.input-rep-pace-sec').value
      );
      if (repPaceSecPerKm == null) {
        setStatus(status, '인터벌은 반복 구간 페이스도 입력하세요.', true);
        return;
      }
      session.run.repPaceSecPerKm = repPaceSecPerKm;
    }
  } else {
    const entriesByExercise = {};
    let anyEntry = false;
    view.querySelectorAll('.exercise').forEach((card) => {
      const exId = card.dataset.exerciseId;
      if (!exId) return;
      const entries = readExerciseEntries(card);
      if (entries.length > 0) {
        entriesByExercise[exId] = entries;
        anyEntry = true;
      }
    });
    if (!anyEntry) {
      setStatus(status, '최소 한 세트 이상 기록하세요.', true);
      return;
    }
    session.entriesByExercise = entriesByExercise;
  }

  saveSession(session);
  setStatus(status, '저장되었습니다. 다음 회차로 넘어갑니다.', false);

  // Rotation has advanced; re-render today and refresh history.
  renderToday();
  renderHistory();
}

function setStatus(el, msg, isError) {
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? 'status-danger' : 'status-ok';
}

// =============================================================================
// 기록 (History) view
// =============================================================================

function sessionSummaryMarkup(session) {
  const name = splitName(session.splitId);
  let body;
  if (session.run) {
    const runDef = getRun(session.run.type);
    const isInterval = session.run.type === 'interval';
    // Grade the rep segment for interval runs; whole-run pace for easy runs.
    const gradedPace = isInterval
      ? session.run.repPaceSecPerKm
      : session.run.paceSecPerKm;
    const evalRes = runDef && typeof gradedPace === 'number'
      ? evaluatePace(gradedPace, runDef)
      : null;
    const evalLine = evalRes
      ? `<span class="${paceStatusClass(evalRes.result)}">${esc(evalRes.message)}</span>`
      : '';
    const typeLabel = isInterval ? '인터벌' : '이지런';
    const repPart = isInterval && typeof session.run.repPaceSecPerKm === 'number'
      ? ` · 반복 구간 ${formatPace(session.run.repPaceSecPerKm)}/km`
      : '';
    body = `<p>${esc(typeLabel)} · ${esc(session.run.distanceKm)}km · 전체 평균 ${formatPace(session.run.paceSecPerKm)}/km${repPart}</p>${evalLine}`;
  } else if (session.entriesByExercise) {
    body = Object.entries(session.entriesByExercise)
      .map(([exId, entries]) => {
        const label = exerciseNameFallback(exId);
        const sets = entries
          .map((e) => `${esc(e.reps)}회${e.weightKg ? `@${esc(e.weightKg)}kg` : ''}`)
          .join(', ');
        return `<p><strong>${esc(label)}</strong>: ${sets}</p>`;
      })
      .join('');
  } else {
    body = '<p class="muted">기록 내용이 없습니다.</p>';
  }

  return `
    <div class="card history-item" data-session-id="${esc(session.id)}">
      <div class="history-head">
        <span><strong>${esc(session.date)}</strong> · ${esc(name)}</span>
        <span class="history-actions">
          <button type="button" class="btn history-edit">수정</button>
          <button type="button" class="btn history-delete">삭제</button>
        </span>
      </div>
      ${body}
    </div>`;
}

// Look up a strength exercise display name by id (falls back to the id itself).
function exerciseNameFallback(exId) {
  for (const splitId of [SPLIT_IDS.CHEST_BACK, SPLIT_IDS.SHOULDER_LEGS_ABS]) {
    const split = getSplit(splitId);
    if (!split || !split.exercises) continue;
    const found = split.exercises.find((e) => e.id === exId);
    if (found) return found.name;
  }
  return exId;
}

function renderHistory() {
  const view = document.getElementById('view-history');
  if (!view) return;

  let sessions;
  try {
    sessions = getAllSessions();
  } catch (err) {
    sessions = [];
  }

  if (!Array.isArray(sessions) || sessions.length === 0) {
    view.innerHTML = `<div class="card"><h2>기록</h2><p class="muted">아직 저장된 세션이 없습니다. '오늘 훈련'에서 첫 세션을 기록해 보세요.</p></div>`;
    return;
  }

  // Newest first.
  const ordered = [...sessions].sort((a, b) => {
    if (a.date === b.date) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    }
    return String(b.date).localeCompare(String(a.date));
  });

  view.innerHTML = `
    <div class="card"><h2>기록</h2><p class="muted">${ordered.length}개의 세션</p></div>
    ${ordered.map(sessionSummaryMarkup).join('')}
  `;

  wireHistoryEvents(view);
}

function wireHistoryEvents(view) {
  view.querySelectorAll('.history-item').forEach((item) => {
    const id = item.dataset.sessionId;

    const delBtn = item.querySelector('.history-delete');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        deleteSession(id);
        renderHistory();
        renderToday();
      });
    }

    const editBtn = item.querySelector('.history-edit');
    if (editBtn) {
      editBtn.addEventListener('click', () => openEditor(item, id));
    }
  });
}

// One editable set row for the history editor (weight + reps).
function editSetRowMarkup(index, weight, reps) {
  return `
    <div class="set-row edit-set-row" data-set-index="${index}">
      <span class="set-no">${index + 1}세트</span>
      <label class="field">
        <span class="field-label">kg</span>
        <input type="number" inputmode="numeric" step="0.5" min="0"
          class="edit-weight" value="${esc(weight)}" aria-label="${index + 1}세트 무게(kg)" />
      </label>
      <label class="field">
        <span class="field-label">회</span>
        <input type="number" inputmode="numeric" step="1" min="0"
          class="edit-reps" value="${esc(reps)}" aria-label="${index + 1}세트 횟수" />
      </label>
      <button type="button" class="btn set-remove" aria-label="세트 삭제">−</button>
    </div>`;
}

// Build the strength editing block: one card per exercise with its logged sets.
function strengthEditorMarkup(session) {
  const entriesByExercise = session.entriesByExercise || {};
  return Object.entries(entriesByExercise)
    .map(([exId, entries]) => {
      const label = exerciseNameFallback(exId);
      const rows = entries
        .map((e, i) => editSetRowMarkup(i, e.weightKg != null ? e.weightKg : '', e.reps != null ? e.reps : ''))
        .join('');
      return `
        <div class="edit-exercise" data-exercise-id="${esc(exId)}">
          <p><strong>${esc(label)}</strong></p>
          <div class="edit-sets">${rows}</div>
          <button type="button" class="btn edit-set-add">+ 세트 추가</button>
        </div>`;
    })
    .join('');
}

// Build the running editing block (distance + whole-run pace + rep-segment pace).
function runningEditorMarkup(session) {
  const run = session.run || {};
  const isInterval = run.type === 'interval';
  const paceSec = Number.isFinite(run.paceSecPerKm) ? run.paceSecPerKm : 0;
  const paceMin = paceSec ? Math.floor(paceSec / 60) : '';
  const paceSS = paceSec ? Math.round(paceSec % 60) : '';
  const repSec = Number.isFinite(run.repPaceSecPerKm) ? run.repPaceSecPerKm : 0;
  const repMin = repSec ? Math.floor(repSec / 60) : '';
  const repSS = repSec ? Math.round(repSec % 60) : '';
  const repField = isInterval
    ? `
      <div class="field field--block">
        <span class="field-label">반복 구간 페이스 (분:초 /km)</span>
        <div class="pace-inputs">
          <input type="number" inputmode="numeric" step="1" min="0" class="edit-rep-pace-min" value="${esc(repMin)}" placeholder="분" aria-label="반복 구간 페이스 분" />
          <span class="pace-sep">:</span>
          <input type="number" inputmode="numeric" step="1" min="0" max="59" class="edit-rep-pace-sec" value="${esc(repSS)}" placeholder="초" aria-label="반복 구간 페이스 초" />
        </div>
      </div>`
    : '';
  return `
    <div class="edit-run" data-run-type="${esc(run.type || 'easy')}">
      <label class="field field--block">
        <span class="field-label">거리 (km)</span>
        <input type="number" inputmode="decimal" step="0.1" min="0" class="edit-distance" value="${esc(run.distanceKm != null ? run.distanceKm : '')}" aria-label="러닝 거리(km)" />
      </label>
      <div class="field field--block">
        <span class="field-label">전체 평균 페이스 (분:초 /km)</span>
        <div class="pace-inputs">
          <input type="number" inputmode="numeric" step="1" min="0" class="edit-pace-min" value="${esc(paceMin)}" placeholder="분" aria-label="전체 평균 페이스 분" />
          <span class="pace-sep">:</span>
          <input type="number" inputmode="numeric" step="1" min="0" max="59" class="edit-pace-sec" value="${esc(paceSS)}" placeholder="초" aria-label="전체 평균 페이스 초" />
        </div>
      </div>
      ${repField}
    </div>`;
}

// Read edited strength entries back out of the editor DOM.
function readEditedEntries(editor) {
  const entriesByExercise = {};
  editor.querySelectorAll('.edit-exercise').forEach((exEl) => {
    const exId = exEl.dataset.exerciseId;
    if (!exId) return;
    const entries = [];
    exEl.querySelectorAll('.edit-set-row').forEach((row) => {
      const repsRaw = row.querySelector('.edit-reps').value;
      const weightRaw = row.querySelector('.edit-weight').value;
      const reps = Number(repsRaw);
      const weightKg = Number(weightRaw);
      if (repsRaw !== '' && Number.isFinite(reps)) {
        entries.push({ weightKg: Number.isFinite(weightKg) ? weightKg : 0, reps });
      }
    });
    if (entries.length > 0) entriesByExercise[exId] = entries;
  });
  return entriesByExercise;
}

// Inline editor: full editing of the session — date plus set reps/weights for
// strength or distance/pace(s) for running. Storage accepts the full patch.
function openEditor(item, sessionId) {
  if (item.querySelector('.history-editor')) return; // already open
  const session = getAllSessions().find((s) => s.id === sessionId);
  if (!session) return;

  const bodyMarkup = session.run
    ? runningEditorMarkup(session)
    : strengthEditorMarkup(session);

  const editor = document.createElement('div');
  editor.className = 'history-editor';
  editor.innerHTML = `
    <label class="field field--block">
      <span class="field-label">날짜</span>
      <input type="date" class="edit-date" value="${esc(session.date)}" />
    </label>
    ${bodyMarkup}
    <p class="edit-error status-danger" aria-live="polite"></p>
    <div class="editor-actions">
      <button type="button" class="btn btn-primary edit-save">저장</button>
      <button type="button" class="btn edit-cancel">취소</button>
    </div>`;
  item.appendChild(editor);

  // Add/remove set rows for strength editing.
  editor.querySelectorAll('.edit-exercise').forEach((exEl) => {
    const setsEl = exEl.querySelector('.edit-sets');
    const addBtn = exEl.querySelector('.edit-set-add');
    if (addBtn && setsEl) {
      addBtn.addEventListener('click', () => {
        const nextIndex = setsEl.querySelectorAll('.edit-set-row').length;
        setsEl.insertAdjacentHTML('beforeend', editSetRowMarkup(nextIndex, '', ''));
        reindexEditSets(setsEl);
      });
    }
    if (setsEl) {
      setsEl.addEventListener('click', (evt) => {
        const btn = evt.target.closest('.set-remove');
        if (!btn) return;
        const row = btn.closest('.edit-set-row');
        if (row && setsEl.querySelectorAll('.edit-set-row').length > 1) {
          row.remove();
          reindexEditSets(setsEl);
        }
      });
    }
  });

  const errEl = editor.querySelector('.edit-error');

  editor.querySelector('.edit-cancel').addEventListener('click', () => editor.remove());
  editor.querySelector('.edit-save').addEventListener('click', () => {
    const newDate = editor.querySelector('.edit-date').value || session.date;
    const patch = { date: newDate };

    if (session.run) {
      const distanceKm = Number(editor.querySelector('.edit-distance').value);
      const paceSecPerKm = parsePace(
        editor.querySelector('.edit-pace-min').value,
        editor.querySelector('.edit-pace-sec').value
      );
      if (!Number.isFinite(distanceKm) || distanceKm <= 0 || paceSecPerKm == null) {
        if (errEl) errEl.textContent = '거리와 전체 평균 페이스를 입력하세요.';
        return;
      }
      const run = { ...session.run, distanceKm, paceSecPerKm };
      if (session.run.type === 'interval') {
        const repPaceSecPerKm = parsePace(
          editor.querySelector('.edit-rep-pace-min').value,
          editor.querySelector('.edit-rep-pace-sec').value
        );
        if (repPaceSecPerKm == null) {
          if (errEl) errEl.textContent = '인터벌은 반복 구간 페이스도 입력하세요.';
          return;
        }
        run.repPaceSecPerKm = repPaceSecPerKm;
      }
      patch.run = run;
    } else if (session.entriesByExercise) {
      const entriesByExercise = readEditedEntries(editor);
      if (Object.keys(entriesByExercise).length === 0) {
        if (errEl) errEl.textContent = '최소 한 세트 이상 기록하세요.';
        return;
      }
      patch.entriesByExercise = entriesByExercise;
    }

    updateSession(sessionId, patch);
    renderHistory();
    // Progression/trends may shift when set data changes; refresh today.
    renderToday();
  });
}

// Re-label edit set numbers after add/remove.
function reindexEditSets(setsEl) {
  setsEl.querySelectorAll('.edit-set-row').forEach((row, i) => {
    row.dataset.setIndex = i;
    const label = row.querySelector('.set-no');
    if (label) label.textContent = `${i + 1}세트`;
  });
}

// =============================================================================
// 추이 (Trends) view — inline-SVG record trends (FEAT-003)
// =============================================================================

// Metric identifiers for the selector. Strength exercises expose two metrics
// (top-set weight, total volume); running exposes an average-pace trend.
const TREND_METRIC = {
  TOP_WEIGHT: 'top_weight',
  VOLUME: 'volume',
  PACE_EASY: 'pace_easy',
  PACE_INTERVAL: 'pace_interval',
};

// Build the ordered list of selectable metric options across all splits.
function trendOptions() {
  const opts = [];
  getSplits().forEach((split) => {
    if (split.type === 'strength') {
      split.exercises.forEach((ex) => {
        opts.push({
          value: `${TREND_METRIC.TOP_WEIGHT}:${ex.id}`,
          label: `${ex.name} · 세트 최고 중량`,
        });
        opts.push({
          value: `${TREND_METRIC.VOLUME}:${ex.id}`,
          label: `${ex.name} · 총 볼륨`,
        });
      });
    } else if (split.type === 'running') {
      opts.push({ value: `${TREND_METRIC.PACE_EASY}:run`, label: '러닝 · 이지런 평균 페이스' });
      opts.push({ value: `${TREND_METRIC.PACE_INTERVAL}:run`, label: '러닝 · 인터벌 반복 구간 페이스' });
    }
  });
  return opts;
}

// --- Metric extraction from stored history -----------------------------------

// Top-set weight per session for a strength exercise: the max weightKg among
// the session's sets (weight-bearing metric).
function topWeightPoints(exerciseId) {
  return getSessionsForExercise(exerciseId).map((s) => {
    const weights = s.entries.map((e) => (Number.isFinite(e.weightKg) ? e.weightKg : 0));
    return { date: s.date, value: weights.length ? Math.max(...weights) : 0 };
  });
}

// Total volume (sum of reps across all sets) per session.
function volumePoints(exerciseId) {
  return getSessionsForExercise(exerciseId).map((s) => {
    const total = s.entries.reduce(
      (sum, e) => sum + (Number.isFinite(e.reps) ? e.reps : 0),
      0
    );
    return { date: s.date, value: total };
  });
}

// Running pace (sec/km) per session for a given run type. For interval runs the
// tracked value is the rep-segment pace (which the target band grades); for easy
// runs it is the whole-run average pace. Falls back to whole-run pace for older
// interval records logged before rep-segment capture existed.
function pacePoints(runType) {
  const sessions = getAllSessions().filter((s) => s.run && s.run.type === runType);
  return sessions
    .map((s) => {
      const value = runType === 'interval' && Number.isFinite(s.run.repPaceSecPerKm)
        ? s.run.repPaceSecPerKm
        : s.run.paceSecPerKm;
      return { date: s.date, value };
    })
    .filter((p) => Number.isFinite(p.value));
}

// Latest-vs-previous trend note. For pace, lower (faster) is better, so the
// arrow direction is inverted when phrasing good/bad.
function trendNoteMarkup(points, opts = {}) {
  const values = points.map((p) => p.value);
  const dir = trendDirection(values);
  const format = opts.formatValue || ((v) => String(v));
  const latest = values[values.length - 1];

  let arrow;
  let word;
  if (dir === 'up') {
    arrow = '▲';
    word = '상승';
  } else if (dir === 'down') {
    arrow = '▼';
    word = '하락';
  } else {
    arrow = '■';
    word = '유지';
  }

  // For pace, faster (down) is the desirable direction.
  let cls = 'muted';
  if (opts.lowerIsBetter) {
    if (dir === 'down') cls = 'status-ok';
    else if (dir === 'up') cls = 'status-warn';
  } else {
    if (dir === 'up') cls = 'status-ok';
    else if (dir === 'down') cls = 'status-warn';
  }

  return `<p class="trend-note ${cls}">최근 값 ${esc(format(latest))} · 직전 대비 ${esc(arrow)} ${esc(word)}</p>`;
}

// Render the chart + note for the currently selected metric into a container.
function renderTrendChart(container, selection) {
  if (!container) return;
  const [metric, id] = String(selection || '').split(':');

  if (metric === TREND_METRIC.TOP_WEIGHT || metric === TREND_METRIC.VOLUME) {
    const ex = getExercise(id);
    if (!ex) {
      container.innerHTML = `<p class="chart-empty muted">${esc(EMPTY_STATE_TEXT)}</p>`;
      return;
    }
    if (metric === TREND_METRIC.TOP_WEIGHT) {
      const points = topWeightPoints(id);
      const fmt = (v) => `${v}kg`;
      const chart = lineChartSvg(points, {
        title: `${ex.name} 세트 최고 중량 추이`,
        formatValue: fmt,
      });
      const note = points.length >= 2 ? trendNoteMarkup(points, { formatValue: fmt }) : '';
      container.innerHTML = chart + note;
    } else {
      const points = volumePoints(id);
      const fmt = (v) => `${v}회`;
      const chart = barChartSvg(points, {
        title: `${ex.name} 총 볼륨 추이`,
        formatValue: fmt,
      });
      const note = points.length >= 2 ? trendNoteMarkup(points, { formatValue: fmt }) : '';
      container.innerHTML = chart + note;
    }
    return;
  }

  if (metric === TREND_METRIC.PACE_EASY || metric === TREND_METRIC.PACE_INTERVAL) {
    const runType = metric === TREND_METRIC.PACE_EASY ? 'easy' : 'interval';
    const runDef = getRun(runType);
    const points = pacePoints(runType);
    const fmt = (v) => `${formatPace(v)}/km`;
    const band = runDef
      ? { min: runDef.paceMinSecPerKm, max: runDef.paceMaxSecPerKm }
      : null;
    const chart = lineChartSvg(points, {
      title: `${runType === 'easy' ? '이지런 평균 페이스' : '인터벌 반복 구간 페이스'} 추이`,
      formatValue: fmt,
      band,
    });
    const bandNote = band
      ? `<p class="trend-band-note muted">목표 구간 ${formatPace(band.min)}~${formatPace(band.max)}/km (음영 영역)</p>`
      : '';
    const note = points.length >= 2
      ? trendNoteMarkup(points, { formatValue: fmt, lowerIsBetter: true })
      : '';
    container.innerHTML = chart + bandNote + note;
    return;
  }

  container.innerHTML = `<p class="chart-empty muted">${esc(EMPTY_STATE_TEXT)}</p>`;
}

function renderTrends() {
  const view = document.getElementById('view-trends');
  if (!view) return;

  const options = trendOptions();
  const optionsMarkup = options
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
    .join('');

  view.innerHTML = `
    <div class="card">
      <h2>추이</h2>
      <p class="muted">운동을 선택하면 기록된 세션의 추이를 보여줍니다. 세트 최고 중량과 총 볼륨, 러닝 평균 페이스를 확인할 수 있습니다.</p>
      <label class="field field--block">
        <span class="field-label">지표 선택</span>
        <select id="trend-metric">${optionsMarkup}</select>
      </label>
    </div>
    <div class="card">
      <div id="trend-chart" class="chart-wrap"></div>
    </div>`;

  const select = view.querySelector('#trend-metric');
  const chartBox = view.querySelector('#trend-chart');
  if (select && chartBox) {
    renderTrendChart(chartBox, select.value);
    select.addEventListener('change', () => renderTrendChart(chartBox, select.value));
  }
}

// =============================================================================
// Init
// =============================================================================

function init() {
  initNav();
  try {
    renderToday();
    renderHistory();
    renderTrends();
  } catch (err) {
    // Fail soft so a rendering error in one view does not break navigation.
    console.error('렌더링 오류:', err);
  }
  switchView('view-today');
}

document.addEventListener('DOMContentLoaded', init);
