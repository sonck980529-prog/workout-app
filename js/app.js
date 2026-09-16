// app.js — full UI wiring for the 홈트 & 러닝 트래커.
// Renders the auto-rotating '오늘 훈련' view, fast mobile per-set logging,
// goal-vs-actual + pace evaluation, progression suggestions, and the '기록'
// history view (editable/deletable). '추이' is a placeholder for FEAT-003.
//
// PURE logic lives in progression.js / data.js. Persistence lives in storage.js.
// This module only does DOM wiring and formatting.

import {
  saveSession,
  getAllSessions,
  getSessionsForExercise,
  getNextSplitId,
  deleteSession,
  updateSession,
  ensureMigrated,
  getSplitPersisted,
  getSplitsPersisted,
  getRunPersisted,
  getExercisePersisted,
  saveSplit,
  updateSplit,
  deleteSplit,
  addExerciseToSplit,
  updateExercise,
  deleteExercise,
  reorderSplitCycle,
  getSplitCyclePersisted,
  getExerciseLibrary,
  addLibraryExercise,
  updateLibraryExercise,
  deleteLibraryExercise,
  exportData,
  importData,
  isValidBackup,
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
import {
  qualifyingStreak,
  proposeTargetChange,
  detectPlateau,
  computeWeeklyReview,
  QUALIFYING_WINDOW,
} from './coaching.js';

// In-memory dismissal registry for advisory coaching cards.
//
// The user can tap [나중에] / [유지] to dismiss a proposal/deload card without
// mutating the routine. We keep dismissals IN MEMORY (a module-level Set keyed
// by exercise id + card kind) rather than persisting them: this needs NO
// storage schema change and keeps backups/isValidBackup untouched. Dismissals
// are intentionally re-evaluated on reload — reopening the app surfaces the
// suggestion again, which is desirable for advisory (non-destructive) coaching.
const dismissedCoaching = new Set();
function coachingDismissKey(exId, kind) {
  return `${exId}:${kind}`;
}

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

// Map a run type to its Korean display name. Falls back to the run def name (or
// the raw type) for any unknown/future type.
const RUN_TYPE_NAMES = { lsd: 'LSD', easy: '이지런', tempo: '템포런', interval: '인터벌' };
function runTypeLabel(type, runDef) {
  if (RUN_TYPE_NAMES[type]) return RUN_TYPE_NAMES[type];
  if (runDef && runDef.name) return runDef.name;
  return type == null ? '' : String(type);
}

function splitName(splitId) {
  const split = getSplitPersisted(splitId);
  return split ? split.name : '알 수 없음';
}

// Build a target-range label for a strength exercise.
function targetLabel(ex) {
  const perLeg = ex.perLeg ? ' (다리당)' : '';
  return `목표 ${ex.repMin}~${ex.repMax}회 x ${ex.sets}세트${perLeg}`;
}

// Pure validation for a strength exercise input (used by the 루틴 editor).
// Accepts raw string/number values; returns { valid, errors: [..], value }
// where value is the normalized exercise fields on success. Rules: non-empty
// name; defaultWeightKg is a non-negative number; repMin/repMax/sets are
// positive integers; repMin <= repMax.
export function validateExerciseInput(raw) {
  const errors = [];
  const name = String(raw && raw.name != null ? raw.name : '').trim();
  if (!name) errors.push('이름을 입력하세요.');

  const weightNum = Number(raw && raw.defaultWeightKg);
  const weightKg = Number.isFinite(weightNum) && weightNum >= 0 ? weightNum : 0;
  if (raw && raw.defaultWeightKg !== '' && raw.defaultWeightKg != null &&
      (!Number.isFinite(weightNum) || weightNum < 0)) {
    errors.push('기본 무게는 0 이상의 숫자여야 합니다.');
  }

  const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
  const repMin = Number(raw && raw.repMin);
  const repMax = Number(raw && raw.repMax);
  const sets = Number(raw && raw.sets);
  if (!isPositiveInt(repMin)) errors.push('목표 최소 횟수는 1 이상의 정수여야 합니다.');
  if (!isPositiveInt(repMax)) errors.push('목표 최대 횟수는 1 이상의 정수여야 합니다.');
  if (!isPositiveInt(sets)) errors.push('세트 수는 1 이상의 정수여야 합니다.');
  if (isPositiveInt(repMin) && isPositiveInt(repMax) && repMin > repMax) {
    errors.push('목표 최소 횟수는 최대 횟수보다 클 수 없습니다.');
  }

  return {
    valid: errors.length === 0,
    errors,
    value: {
      name,
      defaultWeightKg: weightKg,
      repMin,
      repMax,
      sets,
      perLeg: !!(raw && raw.perLeg),
    },
  };
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

// Collect the FULL session history's set-entries for an exercise
// (oldest→newest). The coaching functions (qualifyingStreak / proposeTargetChange
// / detectPlateau) need the multi-session window, not just the last two.
function allEntriesFor(exerciseId) {
  return getSessionsForExercise(exerciseId).map((s) => s.entries);
}

// Format a target line like "12kg · 6~10회 × 4세트" from an exercise-shaped
// object ({defaultWeightKg, repMin, repMax, sets}).
function coachingTargetText(t) {
  const weightPart = t.defaultWeightKg > 0 ? `${t.defaultWeightKg}kg · ` : '맨몸 · ';
  return `${weightPart}${t.repMin}~${t.repMax}회 × ${t.sets}세트`;
}

// Build the 목표 상향 제안 / 정체 감지 advisory card(s) for a strength exercise.
// Returns an HTML string (possibly empty). No card when nothing is actionable.
// An exercise can never be both qualified and plateaued at once (opposite
// conditions), but we render defensively so only the relevant card appears.
function coachingCardsMarkup(ex) {
  const entries = allEntriesFor(ex.id);
  let html = '';

  // (1) Goal-up proposal.
  const proposal = proposeTargetChange(ex, entries);
  if (proposal.qualified && !dismissedCoaching.has(coachingDismissKey(ex.id, 'goalup'))) {
    const currentText = coachingTargetText(proposal.current);
    const proposedText = coachingTargetText(proposal.proposed);
    let deltaText;
    if (proposal.kind === 'weight') {
      const delta = proposal.proposed.defaultWeightKg - proposal.current.defaultWeightKg;
      deltaText = `+${delta}kg`;
    } else {
      const delta = proposal.proposed.repMax - proposal.current.repMax;
      deltaText = `+${delta}회`;
    }
    html += `
      <div class="coaching-card coaching-goalup" data-coaching="goalup">
        <p class="coaching-title status-ok">⬆ 목표 상향 제안</p>
        <p class="coaching-line"><span class="muted">현재 목표</span> ${esc(currentText)}</p>
        <p class="coaching-line"><span class="muted">제안</span> ${esc(proposedText)} <strong>(${esc(deltaText)})</strong></p>
        <p class="coaching-reason muted">${esc(proposal.reason)}</p>
        <div class="coaching-actions">
          <button type="button" class="btn btn-primary coaching-apply">적용</button>
          <button type="button" class="btn coaching-dismiss">나중에</button>
        </div>
      </div>`;
  } else if (!proposal.qualified && proposal.streak > 0) {
    // Partial progress hint like "증량 제안까지 2/3". The denominator is
    // QUALIFYING_WINDOW (3 sessions ≈ 3 weeks), the agreed multi-session window.
    // The chat mock-up showed "1/2", but that predates the confirmed 3-session
    // window; "N/3" is intentional and matches the product decision (review
    // issue #4), so the copy is left as-is.
    html += `
      <p class="coaching-progress muted">증량 제안까지 ${esc(proposal.streak)}/${esc(proposal.required || QUALIFYING_WINDOW)} · 다음 달성 시 상향 제안</p>`;
  }

  // (2) Plateau / deload suggestion.
  const plateau = detectPlateau(ex, entries);
  if (plateau.plateaued && !dismissedCoaching.has(coachingDismissKey(ex.id, 'deload'))) {
    const s = plateau.suggestion;
    let changeText;
    if (s.kind === 'deload_weight') {
      // Show the deload FROM the observed plateau load (basisWeightKg) so the
      // arrow stays coherent with the ~10% cut, which is now anchored on the
      // load the user actually plateaued at (falls back to defaultWeightKg).
      const fromKg = plateau.basisWeightKg != null ? plateau.basisWeightKg : ex.defaultWeightKg;
      changeText = `무게 ${fromKg}kg → ${s.patch.defaultWeightKg}kg`;
    } else {
      changeText = `세트 ${ex.sets} → ${s.patch.sets}`;
    }
    html += `
      <div class="coaching-card coaching-deload" data-coaching="deload">
        <p class="coaching-title status-warn">⚠ 정체 감지</p>
        <p class="coaching-line"><span class="muted">최근 ${esc(plateau.streak)}회 상한 미달</span> · 디로드 제안 ${esc(changeText)}</p>
        <p class="coaching-reason muted">${esc(s.reason)}</p>
        <div class="coaching-actions">
          <button type="button" class="btn btn-primary coaching-deload-apply">디로드 적용</button>
          <button type="button" class="btn coaching-deload-dismiss">유지</button>
        </div>
      </div>`;
  }

  return html;
}

// Wire the advisory coaching card buttons for one strength exercise card.
// [적용]/[디로드 적용] mutate the routine via storage.updateExercise (the ONLY
// place a coaching suggestion changes real data), then re-render every view so
// the new target pre-fills. [나중에]/[유지] dismiss in-memory only (no mutation).
//
// After [적용] raises the target, the same past sessions no longer meet the new
// upper target, so proposeTargetChange returns qualified:false and the card
// naturally clears on re-render without any persisted dismissal.
function wireCoachingCards(card, ex, splitId) {
  const goalCard = card.querySelector('[data-coaching="goalup"]');
  if (goalCard) {
    const applyBtn = goalCard.querySelector('.coaching-apply');
    const dismissBtn = goalCard.querySelector('.coaching-dismiss');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const proposal = proposeTargetChange(ex, allEntriesFor(ex.id));
        if (proposal.qualified) {
          updateExercise(splitId, ex.id, proposal.patch);
          // Dismiss in-memory so the same historical data does not immediately
          // re-propose another increase; the suggestion re-evaluates once new
          // sessions are logged at the raised target (or on reload).
          dismissedCoaching.add(coachingDismissKey(ex.id, 'goalup'));
          renderToday();
          renderRoutine();
          renderTrends();
        }
      });
    }
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        dismissedCoaching.add(coachingDismissKey(ex.id, 'goalup'));
        goalCard.remove();
      });
    }
  }

  const deloadCard = card.querySelector('[data-coaching="deload"]');
  if (deloadCard) {
    const applyBtn = deloadCard.querySelector('.coaching-deload-apply');
    const dismissBtn = deloadCard.querySelector('.coaching-deload-dismiss');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const plateau = detectPlateau(ex, allEntriesFor(ex.id));
        if (plateau.plateaued) {
          updateExercise(splitId, ex.id, plateau.suggestion.patch);
          // Dismiss in-memory so the deload card clears after applying; it
          // re-evaluates once new sessions are logged (or on reload).
          dismissedCoaching.add(coachingDismissKey(ex.id, 'deload'));
          renderToday();
          renderRoutine();
          renderTrends();
        }
      });
    }
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        dismissedCoaching.add(coachingDismissKey(ex.id, 'deload'));
        deloadCard.remove();
      });
    }
  }
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
      ${coachingCardsMarkup(ex)}
      <div class="sets">${rows}</div>
      <div class="set-actions">
        <button type="button" class="btn set-add">+ 세트 추가</button>
      </div>
      <p class="goal-actual muted" aria-live="polite"></p>
    </div>`;
}

function runningMarkup(splitId) {
  const lsd = getRunPersisted('lsd', splitId) || {};
  const easy = getRunPersisted('easy', splitId) || {};
  const tempo = getRunPersisted('tempo', splitId) || {};
  const interval = getRunPersisted('interval', splitId) || {};
  const lsdLine = lsd.distanceMinKm != null
    ? `<p class="muted">LSD ${lsd.distanceMinKm}~${lsd.distanceMaxKm}km · ${formatPace(lsd.paceMinSecPerKm)}~${formatPace(lsd.paceMaxSecPerKm)}/km · ${esc(lsd.note)}</p>`
    : '';
  const easyLine = easy.distanceMinKm != null
    ? `<p class="muted">이지런 ${easy.distanceMinKm}~${easy.distanceMaxKm}km · ${formatPace(easy.paceMinSecPerKm)}~${formatPace(easy.paceMaxSecPerKm)}/km · ${esc(easy.note)}</p>`
    : '';
  const tempoLine = tempo.distanceMinKm != null
    ? `<p class="muted">템포런 ${tempo.distanceMinKm}~${tempo.distanceMaxKm}km · ${formatPace(tempo.paceMinSecPerKm)}~${formatPace(tempo.paceMaxSecPerKm)}/km · ${esc(tempo.note)}</p>`
    : '';
  const intervalLine = interval.distanceMinKm != null
    ? `<p class="muted">인터벌 ${interval.distanceMinKm}~${interval.distanceMaxKm}km · 반복 구간 ${formatPace(interval.paceMinSecPerKm)}~${formatPace(interval.paceMaxSecPerKm)}/km</p>`
    : '';
  return `
    <div class="card exercise" data-run="true">
      <h3>러닝</h3>
      ${lsdLine}
      ${easyLine}
      ${tempoLine}
      ${intervalLine}
      <label class="field field--block">
        <span class="field-label">유형</span>
        <select class="input-run-type">
          <option value="lsd">LSD</option>
          <option value="easy">이지런 (조깅)</option>
          <option value="tempo">템포런</option>
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

// renderToday accepts an optional splitId override for MANUAL split selection.
// When omitted, it defaults to the auto-rotation next split (getNextSplitId()).
// A manual selection only changes which split the view shows/logs under; it does
// NOT change rotation state (rotation still advances from the last SAVED session
// per getNextSplitId semantics).
//
// NOTE on manual-selection reset: calling renderToday() with no argument (after
// a save, or from refreshAfterRoutineChange/import) rebuilds the view on the
// auto split, discarding any manual pick. This is intentional and safe:
//   - After a save the entered sets are already persisted, so nothing in
//     progress is lost.
//   - Routine edits and imports happen from the 루틴 tab, not while the user is
//     mid-entry in 오늘 훈련, so those re-renders never drop half-entered sets.
// Switching split via the picker deliberately re-renders (clearing inputs),
// since sets entered for one split do not carry over to another.
function renderToday(overrideSplitId) {
  const view = document.getElementById('view-today');
  if (!view) return;

  const autoSplitId = getNextSplitId();
  const splits = getSplitsPersisted();
  // Use the override only when it resolves to a real split; otherwise auto.
  const requested = overrideSplitId && getSplitPersisted(overrideSplitId)
    ? overrideSplitId
    : autoSplitId;
  const split = getSplitPersisted(requested);

  if (!split) {
    view.innerHTML = `<div class="card"><p class="status-danger">루틴 정보를 불러오지 못했습니다.</p></div>`;
    return;
  }

  const splitId = split.id;
  const isRunning = split.type === 'running';
  const exercisesMarkup = isRunning
    ? runningMarkup(splitId)
    : split.exercises.map(strengthExerciseMarkup).join('');

  const pickerOptions = splits
    .map((s) => {
      const isAuto = s.id === autoSplitId ? ' (자동 순서)' : '';
      const selected = s.id === splitId ? ' selected' : '';
      return `<option value="${esc(s.id)}"${selected}>${esc(s.name)}${isAuto}</option>`;
    })
    .join('');

  view.innerHTML = `
    <div class="card">
      <h2>오늘 훈련 · <span class="split-name">${esc(split.name)}</span></h2>
      <label class="field field--block">
        <span class="field-label">분할 선택</span>
        <select id="today-split">${pickerOptions}</select>
      </label>
      <p class="muted split-picker-note">기본값은 자동 로테이션 순서입니다. 다른 분할을 골라 오늘 훈련할 수 있으며, 저장 후 다음 순서는 저장된 세션을 기준으로 자동 진행됩니다.</p>
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

  // Manual split picker: re-render the today view for the chosen split without
  // touching rotation state.
  const picker = view.querySelector('#today-split');
  if (picker) {
    picker.addEventListener('change', () => renderToday(picker.value));
  }
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
function refreshRunEval(card, splitId) {
  const target = card.querySelector('.goal-actual');
  if (!target) return;
  const type = card.querySelector('.input-run-type').value;
  const runDef = getRunPersisted(type, splitId);
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

      // Advisory coaching cards: [적용]/[나중에] and [디로드 적용]/[유지].
      wireCoachingCards(card, ex, split.id);

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
      runCard.addEventListener('input', () => refreshRunEval(runCard, split.id));
      runCard.addEventListener('change', () => {
        syncRepPaceVisibility(runCard);
        refreshRunEval(runCard, split.id);
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
    const exerciseNames = {};
    let anyEntry = false;
    view.querySelectorAll('.exercise').forEach((card) => {
      const exId = card.dataset.exerciseId;
      if (!exId) return;
      const entries = readExerciseEntries(card);
      if (entries.length > 0) {
        entriesByExercise[exId] = entries;
        // Snapshot the display name from the split in scope at log time.
        const ex = split.exercises.find((e) => e.id === exId);
        if (ex && ex.name) exerciseNames[exId] = ex.name;
        anyEntry = true;
      }
    });
    if (!anyEntry) {
      setStatus(status, '최소 한 세트 이상 기록하세요.', true);
      return;
    }
    session.entriesByExercise = entriesByExercise;
    session.exerciseNames = exerciseNames;
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
    const runDef = getRunPersisted(session.run.type, session.splitId);
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
    const typeLabel = runTypeLabel(session.run.type, runDef);
    const repPart = isInterval && typeof session.run.repPaceSecPerKm === 'number'
      ? ` · 반복 구간 ${formatPace(session.run.repPaceSecPerKm)}/km`
      : '';
    body = `<p>${esc(typeLabel)} · ${esc(session.run.distanceKm)}km · 전체 평균 ${formatPace(session.run.paceSecPerKm)}/km${repPart}</p>${evalLine}`;
  } else if (session.entriesByExercise) {
    body = Object.entries(session.entriesByExercise)
      .map(([exId, entries]) => {
        const label = exerciseNameFallback(exId, session.exerciseNames);
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

// Look up a strength exercise display name by id. Resolution order:
//   1) the name snapshotted into the session at log time (survives later
//      renames/deletes of the exercise),
//   2) the live persisted routine (covers older sessions logged before the
//      snapshot existed, and reflects a current rename),
//   3) the raw id as a last resort.
// `snapshot` is the session's optional { [exId]: name } map.
function exerciseNameFallback(exId, snapshot) {
  if (snapshot && typeof snapshot[exId] === 'string' && snapshot[exId]) {
    return snapshot[exId];
  }
  const ex = getExercisePersisted(exId);
  return ex ? ex.name : exId;
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
      const label = exerciseNameFallback(exId, session.exerciseNames);
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
  PACE_LSD: 'pace_lsd',
  PACE_EASY: 'pace_easy',
  PACE_TEMPO: 'pace_tempo',
  PACE_INTERVAL: 'pace_interval',
};

// Build the ordered list of selectable metric options across all splits.
function trendOptions() {
  const opts = [];
  getSplitsPersisted().forEach((split) => {
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
      opts.push({ value: `${TREND_METRIC.PACE_LSD}:run`, label: '러닝 · LSD 평균 페이스' });
      opts.push({ value: `${TREND_METRIC.PACE_EASY}:run`, label: '러닝 · 이지런 평균 페이스' });
      opts.push({ value: `${TREND_METRIC.PACE_TEMPO}:run`, label: '러닝 · 템포런 평균 페이스' });
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
    const ex = getExercisePersisted(id);
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

  const PACE_METRIC_MAP = {
    [TREND_METRIC.PACE_LSD]: { runType: 'lsd', title: 'LSD 평균 페이스' },
    [TREND_METRIC.PACE_EASY]: { runType: 'easy', title: '이지런 평균 페이스' },
    [TREND_METRIC.PACE_TEMPO]: { runType: 'tempo', title: '템포런 평균 페이스' },
    [TREND_METRIC.PACE_INTERVAL]: { runType: 'interval', title: '인터벌 반복 구간 페이스' },
  };
  if (PACE_METRIC_MAP[metric]) {
    const { runType, title } = PACE_METRIC_MAP[metric];
    const runDef = getRunPersisted(runType);
    const points = pacePoints(runType);
    const fmt = (v) => `${formatPace(v)}/km`;
    const band = runDef
      ? { min: runDef.paceMinSecPerKm, max: runDef.paceMaxSecPerKm }
      : null;
    const chart = lineChartSvg(points, {
      title: `${title} 추이`,
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

// Format a signed second delta as a readable pace-change phrase. Negative =
// faster (개선). Returns e.g. "12초 빨라짐" / "8초 느려짐" / "변화 없음".
function paceDeltaText(deltaSec) {
  if (deltaSec == null) return null;
  const abs = Math.abs(Math.round(deltaSec));
  if (abs === 0) return '변화 없음';
  return deltaSec < 0 ? `${abs}초 빨라짐` : `${abs}초 느려짐`;
}

// Collect pending goal-up progress across strength exercises (e.g.
// '풀업 증량 대기 2/3') for the weekly-review card's "진행 중 제안" row. Returns an
// array of phrases (empty when nothing is mid-progress). This AUGMENTS the
// review's own nextWeekHint on a separate row rather than replacing it, so the
// PR/volume/pace conclusion always stays visible (review issue #2).
function pendingProposalHint() {
  const parts = [];
  getSplitsPersisted().forEach((split) => {
    if (split.type !== 'strength') return;
    (split.exercises || []).forEach((ex) => {
      const res = proposeTargetChange(ex, allEntriesFor(ex.id));
      if (res.qualified) {
        parts.push(`${ex.name} 상향 제안 대기`);
      } else if (res.streak > 0) {
        parts.push(`${ex.name} 증량 대기 ${res.streak}/${res.required || QUALIFYING_WINDOW}`);
      }
    });
  });
  return parts;
}

// Weekly-review summary card markup for the TOP of the 추이 view.
function weeklyReviewMarkup() {
  let review;
  try {
    review = computeWeeklyReview(getAllSessions());
  } catch (err) {
    review = { hasData: false };
  }

  if (!review.hasData) {
    return `
      <div class="card weekly-review">
        <h2>주간 리뷰 요약</h2>
        <p class="muted">아직 이번 주 훈련 데이터가 없습니다. '오늘 훈련'에서 세션을 기록하면 주간 리뷰가 표시됩니다.</p>
      </div>`;
  }

  // 볼륨 변화 (▲/▼ %) — handle the null (no previous-week base) case gracefully.
  let volumeLine;
  if (review.volumeChangePct == null) {
    volumeLine = `<span class="muted">비교할 지난주 데이터가 없습니다</span>`;
  } else if (review.volumeChangePct > 0) {
    volumeLine = `<span class="status-ok">▲ ${review.volumeChangePct}%</span>`;
  } else if (review.volumeChangePct < 0) {
    volumeLine = `<span class="status-warn">▼ ${Math.abs(review.volumeChangePct)}%</span>`;
  } else {
    volumeLine = `<span class="muted">■ 0%</span>`;
  }

  // PR 갱신.
  const prLine = review.prs.length
    ? review.prs
        .map((pr) => {
          const kindLabel = pr.kind === 'weight' ? `${pr.value}kg` : `${pr.value}회`;
          return `${esc(pr.name)} (${esc(kindLabel)})`;
        })
        .join(', ')
    : '없음';

  // 러닝 페이스 변화 (faster = 개선).
  const easyText = paceDeltaText(review.runningPace.easyDeltaSec);
  const intervalText = paceDeltaText(review.runningPace.intervalDeltaSec);
  const paceParts = [];
  if (easyText) {
    const cls = review.runningPace.easyDeltaSec < 0 ? 'status-ok' : review.runningPace.easyDeltaSec > 0 ? 'status-warn' : 'muted';
    paceParts.push(`이지런 <span class="${cls}">${esc(easyText)}</span>`);
  }
  if (intervalText) {
    const cls = review.runningPace.intervalDeltaSec < 0 ? 'status-ok' : review.runningPace.intervalDeltaSec > 0 ? 'status-warn' : 'muted';
    paceParts.push(`인터벌 <span class="${cls}">${esc(intervalText)}</span>`);
  }
  const paceLine = paceParts.length ? paceParts.join(' · ') : '<span class="muted">비교할 러닝 데이터가 없습니다</span>';

  // 다음 주 추천: ALWAYS show the review's own signal-aware hint (PR / volume /
  // pace). Pending goal-up progress is shown on its OWN row so it augments,
  // rather than shadows, review.nextWeekHint (previously the pending progress
  // replaced the hint whenever any exercise had streak>0, so the PR/volume/pace
  // conclusion rarely surfaced — see review issue #2).
  const pending = pendingProposalHint();
  const pendingRow = pending.length
    ? `
      <div class="review-row review-hint"><span class="review-label muted">진행 중 제안</span><span class="review-value">${esc(pending.join(' · '))}</span></div>`
    : '';

  return `
    <div class="card weekly-review">
      <h2>주간 리뷰 요약</h2>
      <div class="review-row"><span class="review-label muted">이번 주 운동 횟수</span><span class="review-value">${esc(review.sessionCount)}회</span></div>
      <div class="review-row"><span class="review-label muted">PR 갱신</span><span class="review-value">${prLine}</span></div>
      <div class="review-row"><span class="review-label muted">지난주 대비 총 볼륨</span><span class="review-value">${volumeLine}</span></div>
      <div class="review-row"><span class="review-label muted">러닝 페이스 변화</span><span class="review-value">${paceLine}</span></div>
      <div class="review-row review-hint"><span class="review-label muted">다음 주 추천</span><span class="review-value">${esc(review.nextWeekHint)}</span></div>${pendingRow}
    </div>`;
}

function renderTrends() {
  const view = document.getElementById('view-trends');
  if (!view) return;

  const options = trendOptions();
  const optionsMarkup = options
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
    .join('');

  view.innerHTML = `
    ${weeklyReviewMarkup()}
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
// 루틴 (Routine & Exercise manager) view — wger-inspired editor (FEAT-005)
// =============================================================================

// Re-render every view that surfaces routine data after a mutation.
function refreshAfterRoutineChange() {
  renderRoutine();
  renderToday();
  renderTrends();
}

// Markup for a single exercise row inside a split card (read + edit/delete).
function routineExerciseRowMarkup(ex) {
  return `
    <li class="routine-ex" data-exercise-id="${esc(ex.id)}">
      <div class="routine-ex-info">
        <span class="routine-ex-name">${esc(ex.name)}</span>
        <span class="muted routine-ex-target">${esc(targetLabel(ex))}${ex.defaultWeightKg ? ` · 기본 ${esc(ex.defaultWeightKg)}kg` : ''}</span>
      </div>
      <div class="routine-ex-actions">
        <button type="button" class="btn ex-edit" aria-label="${esc(ex.name)} 수정">수정</button>
        <button type="button" class="btn ex-delete" aria-label="${esc(ex.name)} 삭제">삭제</button>
      </div>
    </li>`;
}

// Markup for the running split's read-only run definitions.
function routineRunningMarkup(split) {
  const lsd = split.runs && split.runs.lsd;
  const easy = split.runs && split.runs.easy;
  const tempo = split.runs && split.runs.tempo;
  const interval = split.runs && split.runs.interval;
  const lsdLine = lsd
    ? `<p class="muted">LSD ${esc(lsd.distanceMinKm)}~${esc(lsd.distanceMaxKm)}km · ${formatPace(lsd.paceMinSecPerKm)}~${formatPace(lsd.paceMaxSecPerKm)}/km</p>`
    : '';
  const easyLine = easy
    ? `<p class="muted">이지런 ${esc(easy.distanceMinKm)}~${esc(easy.distanceMaxKm)}km · ${formatPace(easy.paceMinSecPerKm)}~${formatPace(easy.paceMaxSecPerKm)}/km</p>`
    : '';
  const tempoLine = tempo
    ? `<p class="muted">템포런 ${esc(tempo.distanceMinKm)}~${esc(tempo.distanceMaxKm)}km · ${formatPace(tempo.paceMinSecPerKm)}~${formatPace(tempo.paceMaxSecPerKm)}/km</p>`
    : '';
  const intervalLine = interval
    ? `<p class="muted">인터벌 ${esc(interval.distanceMinKm)}~${esc(interval.distanceMaxKm)}km · 반복 구간 ${formatPace(interval.paceMinSecPerKm)}~${formatPace(interval.paceMaxSecPerKm)}/km</p>`
    : '';
  return `<div class="routine-running">${lsdLine}${easyLine}${tempoLine}${intervalLine}<p class="muted routine-running-note">러닝 목표는 읽기 전용입니다.</p></div>`;
}

// The add/edit exercise form fields. `values` pre-fills; `mode` = 'add'|'edit'.
function exerciseFormMarkup(values, opts = {}) {
  const v = values || {};
  const libOptions = opts.showLibrary
    ? getExerciseLibrary()
        .map((lib) => `<option value="${esc(lib.id)}">${esc(lib.name)}</option>`)
        .join('')
    : '';
  const librarySelect = opts.showLibrary
    ? `
      <label class="field field--block">
        <span class="field-label">라이브러리에서 선택</span>
        <select class="ex-lib-select">
          <option value="">직접 입력 (커스텀)</option>
          ${libOptions}
        </select>
      </label>`
    : '';
  const saveToLib = opts.showLibrary
    ? `
      <label class="checkbox-field">
        <input type="checkbox" class="ex-save-to-lib" />
        <span>이 운동을 라이브러리에도 저장</span>
      </label>`
    : '';
  return `
    <div class="routine-form">
      ${librarySelect}
      <label class="field field--block">
        <span class="field-label">이름</span>
        <input type="text" class="ex-name" value="${esc(v.name != null ? v.name : '')}" placeholder="예: 벤치프레스" />
      </label>
      <label class="field field--block">
        <span class="field-label">기본 무게 (kg)</span>
        <input type="number" inputmode="decimal" step="0.5" min="0" class="ex-weight" value="${esc(v.defaultWeightKg != null ? v.defaultWeightKg : 0)}" />
      </label>
      <div class="routine-form-row">
        <label class="field">
          <span class="field-label">목표 최소 횟수</span>
          <input type="number" inputmode="numeric" step="1" min="1" class="ex-repmin" value="${esc(v.repMin != null ? v.repMin : '')}" />
        </label>
        <label class="field">
          <span class="field-label">목표 최대 횟수</span>
          <input type="number" inputmode="numeric" step="1" min="1" class="ex-repmax" value="${esc(v.repMax != null ? v.repMax : '')}" />
        </label>
        <label class="field">
          <span class="field-label">세트 수</span>
          <input type="number" inputmode="numeric" step="1" min="1" class="ex-sets" value="${esc(v.sets != null ? v.sets : '')}" />
        </label>
      </div>
      <label class="checkbox-field">
        <input type="checkbox" class="ex-perleg" ${v.perLeg ? 'checked' : ''} />
        <span>다리당 (좌우 각각)</span>
      </label>
      ${saveToLib}
      <p class="routine-form-error status-danger" aria-live="polite"></p>
      <div class="routine-form-actions">
        <button type="button" class="btn btn-primary ex-form-save">${opts.saveLabel || '저장'}</button>
        <button type="button" class="btn ex-form-cancel">취소</button>
      </div>
    </div>`;
}

// Read the exercise form fields into a raw object for validation.
function readExerciseForm(formEl) {
  return {
    name: formEl.querySelector('.ex-name').value,
    defaultWeightKg: formEl.querySelector('.ex-weight').value,
    repMin: formEl.querySelector('.ex-repmin').value,
    repMax: formEl.querySelector('.ex-repmax').value,
    sets: formEl.querySelector('.ex-sets').value,
    perLeg: formEl.querySelector('.ex-perleg').checked,
  };
}

// Markup for one split card in the routine editor.
function routineSplitMarkup(split, index, total) {
  const isRunning = split.type === 'running';
  const typeLabel = isRunning ? '러닝' : '근력';
  const body = isRunning
    ? routineRunningMarkup(split)
    : `
      <ul class="routine-ex-list">
        ${(split.exercises || []).map(routineExerciseRowMarkup).join('') || '<li class="muted routine-ex-empty">운동이 없습니다.</li>'}
      </ul>
      <button type="button" class="btn ex-add">+ 운동 추가</button>`;

  return `
    <div class="card routine-split" data-split-id="${esc(split.id)}" data-split-type="${esc(split.type)}">
      <div class="routine-split-head">
        <div class="routine-split-title">
          <span class="routine-split-name">${esc(split.name)}</span>
          <span class="muted routine-split-type">${esc(typeLabel)} · ${index + 1}/${total}</span>
        </div>
        <div class="routine-split-move">
          <button type="button" class="btn split-up" aria-label="위로 이동" ${index === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="btn split-down" aria-label="아래로 이동" ${index === total - 1 ? 'disabled' : ''}>▼</button>
        </div>
      </div>
      <div class="routine-split-actions">
        <button type="button" class="btn split-rename">이름 수정</button>
        <button type="button" class="btn split-delete" ${total <= 1 ? 'disabled' : ''}>분할 삭제</button>
      </div>
      ${body}
    </div>`;
}

// Library management section markup.
function libraryItemMarkup(lib) {
  return `
    <li class="library-item" data-lib-id="${esc(lib.id)}">
      <div class="routine-ex-info">
        <span class="routine-ex-name">${esc(lib.name)}</span>
        <span class="muted routine-ex-target">${esc(targetLabel(lib))}${lib.defaultWeightKg ? ` · 기본 ${esc(lib.defaultWeightKg)}kg` : ''}</span>
      </div>
      <div class="routine-ex-actions">
        <button type="button" class="btn lib-edit" aria-label="${esc(lib.name)} 수정">수정</button>
        <button type="button" class="btn lib-delete" aria-label="${esc(lib.name)} 삭제">삭제</button>
      </div>
    </li>`;
}

function renderRoutine() {
  const view = document.getElementById('view-routine');
  if (!view) return;

  const splits = getSplitsPersisted();
  const total = splits.length;
  const splitsMarkup = splits
    .map((split, i) => routineSplitMarkup(split, i, total))
    .join('');

  const library = getExerciseLibrary();
  const libraryMarkup = library.map(libraryItemMarkup).join('') ||
    '<li class="muted routine-ex-empty">라이브러리가 비어 있습니다.</li>';

  view.innerHTML = `
    <div class="card">
      <h2>루틴 관리</h2>
      <p class="muted">분할과 운동을 편집하고 로테이션 순서를 조정할 수 있습니다. 변경 사항은 자동 저장됩니다.</p>
    </div>
    ${splitsMarkup}
    <div class="card routine-add-split">
      <h3>분할 추가</h3>
      <label class="field field--block">
        <span class="field-label">분할 이름</span>
        <input type="text" id="new-split-name" placeholder="예: 팔·복근" />
      </label>
      <label class="field field--block">
        <span class="field-label">유형</span>
        <select id="new-split-type">
          <option value="strength">근력</option>
          <option value="running">러닝</option>
        </select>
      </label>
      <p class="routine-form-error status-danger" id="new-split-error" aria-live="polite"></p>
      <button type="button" class="btn btn-primary" id="add-split-btn">+ 분할 추가</button>
    </div>
    <div class="card routine-library">
      <h3>운동 라이브러리</h3>
      <p class="muted">운동 추가 시 여기에서 선택해 빠르게 채울 수 있습니다.</p>
      <ul class="library-list">${libraryMarkup}</ul>
      <button type="button" class="btn" id="lib-add-btn">+ 라이브러리에 추가</button>
    </div>
    <div class="card routine-backup">
      <h3>설정 / 백업</h3>
      <p class="muted">모든 기록·루틴·운동 라이브러리를 JSON 파일로 내보내고 다시 가져올 수 있습니다. 기기 이전이나 브라우저 데이터 삭제에 대비해 백업하세요. 가져오기는 현재 데이터를 덮어씁니다.</p>
      <div class="routine-backup-actions">
        <button type="button" class="btn btn-primary" id="export-data-btn">내보내기</button>
        <label class="btn" id="import-data-label" for="import-data-input">가져오기</label>
        <input type="file" id="import-data-input" accept=".json,application/json" hidden />
      </div>
      <p class="routine-backup-status muted" id="backup-status" aria-live="polite"></p>
    </div>`;

  wireRoutineEvents(view);
  wireBackupEvents(view);
}

// Close any inline form already open within a container element.
function removeInlineForm(container) {
  const existing = container.querySelector('.routine-form');
  if (existing) existing.remove();
}

// Populate an exercise form's fields from a library exercise (pre-fill).
function prefillFormFromLibrary(formEl, lib) {
  if (!lib) return;
  formEl.querySelector('.ex-name').value = lib.name != null ? lib.name : '';
  formEl.querySelector('.ex-weight').value = lib.defaultWeightKg != null ? lib.defaultWeightKg : 0;
  formEl.querySelector('.ex-repmin').value = lib.repMin != null ? lib.repMin : '';
  formEl.querySelector('.ex-repmax').value = lib.repMax != null ? lib.repMax : '';
  formEl.querySelector('.ex-sets').value = lib.sets != null ? lib.sets : '';
  formEl.querySelector('.ex-perleg').checked = !!lib.perLeg;
}

// Wire the save/cancel + validation lifecycle of an exercise form. `onSave`
// receives the validated value plus the form element (for library options).
function wireExerciseForm(formEl, onSave) {
  const errEl = formEl.querySelector('.routine-form-error');
  const libSelect = formEl.querySelector('.ex-lib-select');
  if (libSelect) {
    libSelect.addEventListener('change', () => {
      const lib = getExerciseLibrary().find((l) => l.id === libSelect.value);
      if (lib) prefillFormFromLibrary(formEl, lib);
    });
  }
  formEl.querySelector('.ex-form-cancel').addEventListener('click', () => formEl.remove());
  formEl.querySelector('.ex-form-save').addEventListener('click', () => {
    const result = validateExerciseInput(readExerciseForm(formEl));
    if (!result.valid) {
      if (errEl) errEl.textContent = result.errors.join(' ');
      return;
    }
    if (errEl) errEl.textContent = '';
    const saveToLib = formEl.querySelector('.ex-save-to-lib');
    onSave(result.value, { saveToLibrary: saveToLib ? saveToLib.checked : false });
  });
}

function wireRoutineEvents(view) {
  // --- Per-split controls ---
  view.querySelectorAll('.routine-split').forEach((card) => {
    const splitId = card.dataset.splitId;
    const isRunning = card.dataset.splitType === 'running';

    const upBtn = card.querySelector('.split-up');
    const downBtn = card.querySelector('.split-down');
    if (upBtn) upBtn.addEventListener('click', () => moveSplit(splitId, -1));
    if (downBtn) downBtn.addEventListener('click', () => moveSplit(splitId, 1));

    const renameBtn = card.querySelector('.split-rename');
    if (renameBtn) renameBtn.addEventListener('click', () => openSplitRename(card, splitId));

    const delBtn = card.querySelector('.split-delete');
    if (delBtn && !delBtn.disabled) {
      delBtn.addEventListener('click', () => {
        const split = getSplitPersisted(splitId);
        const name = split ? split.name : '';
        if (getSplitsPersisted().length <= 1) return; // guard: last split
        if (window.confirm(`'${name}' 분할을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) {
          deleteSplit(splitId);
          refreshAfterRoutineChange();
        }
      });
    }

    if (!isRunning) {
      const addBtn = card.querySelector('.ex-add');
      if (addBtn) {
        addBtn.addEventListener('click', () => openAddExercise(card, splitId));
      }

      card.querySelectorAll('.routine-ex').forEach((row) => {
        const exId = row.dataset.exerciseId;
        const editBtn = row.querySelector('.ex-edit');
        const delExBtn = row.querySelector('.ex-delete');
        if (editBtn) editBtn.addEventListener('click', () => openEditExercise(row, splitId, exId));
        if (delExBtn) {
          delExBtn.addEventListener('click', () => {
            const ex = getExercisePersisted(exId);
            const name = ex ? ex.name : '';
            if (window.confirm(`'${name}' 운동을 삭제할까요?`)) {
              deleteExercise(splitId, exId);
              refreshAfterRoutineChange();
            }
          });
        }
      });
    }
  });

  // --- Add split ---
  const addSplitBtn = view.querySelector('#add-split-btn');
  if (addSplitBtn) {
    addSplitBtn.addEventListener('click', () => {
      const nameEl = view.querySelector('#new-split-name');
      const typeEl = view.querySelector('#new-split-type');
      const errEl = view.querySelector('#new-split-error');
      const name = (nameEl.value || '').trim();
      if (!name) {
        if (errEl) errEl.textContent = '분할 이름을 입력하세요.';
        return;
      }
      if (errEl) errEl.textContent = '';
      const type = typeEl.value === 'running' ? 'running' : 'strength';
      const split = type === 'running'
        ? { name, type: 'running', runs: {} }
        : { name, type: 'strength', exercises: [] };
      saveSplit(split);
      refreshAfterRoutineChange();
    });
  }

  // --- Library management ---
  const libAddBtn = view.querySelector('#lib-add-btn');
  if (libAddBtn) {
    libAddBtn.addEventListener('click', () => {
      const section = view.querySelector('.routine-library');
      removeInlineForm(section);
      const holder = document.createElement('div');
      holder.innerHTML = exerciseFormMarkup({ defaultWeightKg: 0 }, { saveLabel: '라이브러리에 추가' });
      const formEl = holder.firstElementChild;
      section.appendChild(formEl);
      wireExerciseForm(formEl, (value) => {
        addLibraryExercise(value);
        renderRoutine();
      });
    });
  }

  view.querySelectorAll('.library-item').forEach((row) => {
    const libId = row.dataset.libId;
    const editBtn = row.querySelector('.lib-edit');
    const delBtn = row.querySelector('.lib-delete');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const lib = getExerciseLibrary().find((l) => l.id === libId);
        if (!lib) return;
        removeInlineForm(row.closest('.routine-library'));
        const holder = document.createElement('div');
        holder.innerHTML = exerciseFormMarkup(lib, { saveLabel: '수정 저장' });
        const formEl = holder.firstElementChild;
        row.insertAdjacentElement('afterend', formEl);
        wireExerciseForm(formEl, (value) => {
          updateLibraryExercise(libId, value);
          renderRoutine();
        });
      });
    }
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        const lib = getExerciseLibrary().find((l) => l.id === libId);
        const name = lib ? lib.name : '';
        if (window.confirm(`라이브러리에서 '${name}' 을(를) 삭제할까요?`)) {
          deleteLibraryExercise(libId);
          renderRoutine();
        }
      });
    }
  });
}

// Wire the backup/restore controls (export download + import from file).
function wireBackupEvents(view) {
  const statusEl = view.querySelector('#backup-status');

  const exportBtn = view.querySelector('#export-data-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      try {
        const json = exportData();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `htracker-backup-${todayIso()}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // Release the object URL after the download has kicked off.
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setBackupStatus(statusEl, '백업 파일을 내보냈습니다.', false);
      } catch (err) {
        setBackupStatus(statusEl, '내보내기에 실패했습니다.', true);
      }
    });
  }

  const importInput = view.querySelector('#import-data-input');
  if (importInput) {
    importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(String(reader.result));
        } catch (err) {
          setBackupStatus(statusEl, '올바른 JSON 파일이 아닙니다.', true);
          importInput.value = '';
          return;
        }
        if (!isValidBackup(parsed)) {
          setBackupStatus(statusEl, '백업 파일 형식이 올바르지 않습니다. 기존 데이터는 그대로 유지됩니다.', true);
          importInput.value = '';
          return;
        }
        const ok = importData(parsed);
        importInput.value = '';
        if (!ok) {
          setBackupStatus(statusEl, '가져오기에 실패했습니다. 기존 데이터는 그대로 유지됩니다.', true);
          return;
        }
        // Success: re-render every view so restored data shows immediately.
        renderToday();
        renderHistory();
        renderTrends();
        renderRoutine();
        // renderRoutine rebuilt this section, so re-query the status element.
        const freshStatus = document.querySelector('#backup-status');
        setBackupStatus(freshStatus, '데이터를 가져와 복원했습니다.', false);
      };
      reader.onerror = () => {
        setBackupStatus(statusEl, '파일을 읽지 못했습니다.', true);
        importInput.value = '';
      };
      reader.readAsText(file);
    });
  }
}

function setBackupStatus(el, msg, isError) {
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? 'routine-backup-status status-danger' : 'routine-backup-status status-ok';
}

// Move a split up (-1) or down (+1) within the cycle and persist.
function moveSplit(splitId, delta) {
  const cycle = getSplitCyclePersisted();
  const idx = cycle.indexOf(splitId);
  if (idx === -1) return;
  const target = idx + delta;
  if (target < 0 || target >= cycle.length) return;
  const reordered = [...cycle];
  const [moved] = reordered.splice(idx, 1);
  reordered.splice(target, 0, moved);
  reorderSplitCycle(reordered);
  refreshAfterRoutineChange();
}

// Inline split-name rename form.
function openSplitRename(card, splitId) {
  if (card.querySelector('.split-rename-form')) return;
  const split = getSplitPersisted(splitId);
  if (!split) return;
  const holder = document.createElement('div');
  holder.className = 'split-rename-form routine-form';
  holder.innerHTML = `
    <label class="field field--block">
      <span class="field-label">분할 이름</span>
      <input type="text" class="split-name-input" value="${esc(split.name)}" />
    </label>
    <p class="routine-form-error status-danger" aria-live="polite"></p>
    <div class="routine-form-actions">
      <button type="button" class="btn btn-primary split-name-save">저장</button>
      <button type="button" class="btn split-name-cancel">취소</button>
    </div>`;
  const head = card.querySelector('.routine-split-actions');
  head.insertAdjacentElement('afterend', holder);
  const errEl = holder.querySelector('.routine-form-error');
  holder.querySelector('.split-name-cancel').addEventListener('click', () => holder.remove());
  holder.querySelector('.split-name-save').addEventListener('click', () => {
    const name = (holder.querySelector('.split-name-input').value || '').trim();
    if (!name) {
      if (errEl) errEl.textContent = '분할 이름을 입력하세요.';
      return;
    }
    updateSplit(splitId, { name });
    refreshAfterRoutineChange();
  });
}

// Inline add-exercise form (with library pre-fill + optional save-to-library).
function openAddExercise(card, splitId) {
  removeInlineForm(card);
  const holder = document.createElement('div');
  holder.innerHTML = exerciseFormMarkup({ defaultWeightKg: 0 }, { showLibrary: true, saveLabel: '운동 추가' });
  const formEl = holder.firstElementChild;
  card.appendChild(formEl);
  wireExerciseForm(formEl, (value, meta) => {
    addExerciseToSplit(splitId, value);
    if (meta && meta.saveToLibrary) addLibraryExercise(value);
    refreshAfterRoutineChange();
  });
}

// Inline edit-exercise form.
function openEditExercise(row, splitId, exId) {
  const ex = getExercisePersisted(exId);
  if (!ex) return;
  const card = row.closest('.routine-split');
  removeInlineForm(card);
  const holder = document.createElement('div');
  holder.innerHTML = exerciseFormMarkup(ex, { saveLabel: '수정 저장' });
  const formEl = holder.firstElementChild;
  row.insertAdjacentElement('afterend', formEl);
  wireExerciseForm(formEl, (value) => {
    updateExercise(splitId, exId, value);
    refreshAfterRoutineChange();
  });
}

// =============================================================================
// Init
// =============================================================================

function init() {
  initNav();
  try {
    // Seed the default routine + exercise library on first run, or migrate any
    // existing v1 data in place (sessions preserved) before rendering.
    ensureMigrated();
  } catch (err) {
    console.error('마이그레이션 오류:', err);
  }
  try {
    renderToday();
    renderHistory();
    renderTrends();
    renderRoutine();
  } catch (err) {
    // Fail soft so a rendering error in one view does not break navigation.
    console.error('렌더링 오류:', err);
  }
  switchView('view-today');
}

// Only wire up when running in a browser (guards node imports for testing).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', init);
}
