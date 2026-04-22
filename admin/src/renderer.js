// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
const S = {
  token:    null,
  loginError: "",
  loginBusy:  false,

  page:     "managers",   // managers | settings | licenses
  managers: [],
  calls:    [],
  selected: null,
  mgrCalls: [],
  modal:    null,         // null | "add" | "edit" | "delete" | "issue-license" | "edit-plan" | "add-plan"
  pendingDeleteId: null,

  activeAudioCallId: null,
  commentDraft:      {},
  savingCommentId:   null,

  form:     { name:"", username:"", password:"", color:"#6366f1" },
  editForm: { name:"", username:"", password:"", color:"" },
  settingsForm: { username:"", password:"", password2:"", threshold:"" },
  settingsError: "",
  settingsDone:  false,
  settingsBusy:  false,
  formError: "",
  formBusy:  false,

  threshold: 5,

  // Licenses page
  licStatus:   null,   // license status object from backend
  licBusy:     false,
  licError:    "",
  licSuccess:  "",
  activateKey: "",     // key being entered
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const sc  = s => s>=75?"#4ade80":s>=50?"#fbbf24":"#f87171";
const vc  = (v,t) => v>=t?"#f87171":v>=t*.6?"#fbbf24":"#4ade80";
const fmt = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

const COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#8b5cf6","#06b6d4"];

// ═══════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════
async function load() {
  const [managers, calls, settings] = await Promise.all([
    window.api.get("/api/managers").catch(()=>[]),
    window.api.get("/api/calls").catch(()=>[]),
    window.api.get("/api/settings").catch(()=>({})),
  ]);
  S.managers  = managers;
  S.calls     = calls;
  S.threshold = settings?.violations_threshold ?? 5;
  render();
}

async function loadMgrCalls(mgrId) {
  S.mgrCalls = await window.api.get(`/api/managers/${mgrId}/calls`).catch(()=>[]);
}

async function loadLicenseStatus() {
  S.licBusy = true; render();
  const status = await window.api.get("/api/license/status").catch(()=>null);
  S.licStatus = status;
  S.licBusy   = false; render();
}

// ═══════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════
function render() {
  document.getElementById("app").innerHTML = html();
  bind();
}

function html() {
  if (!S.token) return loginPage();
  return `
<div class="shell">
  ${sidebar()}
  <div class="main">
    ${topbar()}
    <div class="content">
      ${S.page==="settings" ? pageSettings() : S.page==="licenses" ? pageLicenses() : (S.selected ? pageManagerDetail() : pageManagers())}
    </div>
  </div>
</div>
${S.modal ? modalHtml() : ""}`;
}

// ── Login ──────────────────────────────────────────────────
function loginPage() {
  return `
<div class="login-shell">
  <div class="login-card">
    <div class="login-logo">
      <div class="logo-tag">Sales AI</div>
      <div class="logo-h">Admin Panel</div>
    </div>
    <div class="login-title">Вход администратора</div>
    ${S.loginError ? `<div class="alert-red" style="margin-bottom:14px">${esc(S.loginError)}</div>` : ""}
    <label>Логин</label>
    <input id="login-username" type="text" placeholder="admin" autocomplete="username"/>
    <label>Пароль</label>
    <input id="login-password" type="password" placeholder="••••••" autocomplete="current-password"/>
    <button class="btn-primary btn-full ${S.loginBusy?"disabled":""}" id="btn-login" ${S.loginBusy?"disabled":""} style="margin-top:20px">
      ${S.loginBusy?`<span class="spinner"></span> Вхожу...`:"Войти"}
    </button>
  </div>
</div>`;
}

// ── Sidebar ────────────────────────────────────────────────
function sidebar() {
  return `
<div class="sidebar">
  <div class="logo">
    <div class="logo-tag">Sales AI</div>
    <div class="logo-h">Admin Panel</div>
  </div>
  <div class="nav-section">
    <div class="nav-label">Управление</div>
    <div class="nav ${S.page==="managers"?"on":""}" id="nav-managers">
      <span class="nicon">◉</span>Менеджеры
      <span class="nbadge">${S.managers.length}</span>
    </div>
    <div class="nav ${S.page==="licenses"?"on":""}" id="nav-licenses">
      <span class="nicon">🔑</span>Лицензии
    </div>
    <div class="nav ${S.page==="settings"?"on":""}" id="nav-settings">
      <span class="nicon">⚙</span>Настройки
    </div>
  </div>
  <div class="sidebar-bottom">
    <div class="stat-mini">
      <div class="stat-mini-row">
        <span class="stat-mini-lbl">Всего звонков</span>
        <span class="stat-mini-val">${S.calls.length}</span>
      </div>
      <div class="stat-mini-row">
        <span class="stat-mini-lbl">С нарушениями</span>
        <span class="stat-mini-val" style="color:#f87171">${S.managers.filter(m=>(m.violations||0)>=S.threshold).length}</span>
      </div>
    </div>
    <button class="btn-ghost btn-sm btn-full" id="btn-logout" style="margin-top:10px">Выйти</button>
  </div>
</div>`;
}

// ── Topbar ─────────────────────────────────────────────────
function topbar() {
  if (S.page === "settings") return `
<div class="topbar">
  <div><div class="pt">Настройки</div><div class="ps">Учётные данные администратора и конфигурация</div></div>
</div>`;
  if (S.page === "licenses") return `
<div class="topbar">
  <div><div class="pt">Лицензия</div><div class="ps">Активация и статус лицензии системы</div></div>
</div>`;
  const title = S.selected ? esc(S.selected.name) : "Менеджеры";
  const sub   = S.selected
    ? `${S.selected.calls_count||0} звонков · ${S.selected.violations||0} нарушений`
    : `${S.managers.length} сотрудников`;
  return `
<div class="topbar">
  <div>
    ${S.selected ? `<button class="btn-ghost btn-sm" id="btn-back" style="margin-bottom:6px">← Назад</button><br>` : ""}
    <div class="pt">${title}</div>
    <div class="ps">${sub}</div>
  </div>
  <button class="btn-primary" id="btn-add-mgr">+ Добавить менеджера</button>
</div>`;
}

// ── Managers list ──────────────────────────────────────────
function pageManagers() {
  if (!S.managers.length) return `
<div class="empty">
  <div class="eicon">◉</div>
  Менеджеров пока нет<br>
  <small>Нажмите «+ Добавить менеджера»</small>
</div>`;

  const alertMgrs = S.managers.filter(m=>(m.violations||0)>=S.threshold);
  return `
<div style="display:flex;flex-direction:column;gap:20px">
  ${alertMgrs.length ? `
  <div class="alert-banner">
    <span class="alert-icon">⚠</span>
    <div>
      <div style="font-weight:600;margin-bottom:2px">Превышен порог нарушений</div>
      <div style="font-size:12px;color:var(--text2)">${alertMgrs.map(m=>esc(m.name)).join(", ")} — требуют внимания</div>
    </div>
  </div>` : ""}
  <div class="mgrid">
    ${S.managers.map(m => managerCard(m)).join("")}
  </div>
</div>`;
}

function managerCard(m) {
  const v   = m.violations||0;
  const pct = Math.min(100, Math.round(v/S.threshold*100));
  return `
<div class="mcard" data-mgr="${m.id}">
  <div class="mhd">
    <div class="av" style="background:${m.color}">${esc(m.avatar)}</div>
    <div style="flex:1;min-width:0">
      <div class="mname">${esc(m.name)}</div>
      <div class="musername">@${esc(m.username||"")}</div>
    </div>
    <div class="mcard-actions">
      <button class="icon-btn" data-edit-mgr="${m.id}" title="Редактировать">✎</button>
      <button class="icon-btn icon-btn-red" data-delete-mgr="${m.id}" title="Удалить">✕</button>
    </div>
  </div>
  <div class="sgrid">
    <div class="sbox">
      <div class="sval" style="color:#a5b4fc">${m.calls_count||0}</div>
      <div class="slbl">ЗВОНКОВ</div>
    </div>
    <div class="sbox">
      <div class="sval" style="color:${vc(v,S.threshold)}">${v}</div>
      <div class="slbl">НАРУШ.</div>
    </div>
    <div class="sbox">
      <div class="sval" style="color:#4ade80">${m.avg_score!=null?m.avg_score:"—"}</div>
      <div class="slbl">ОЦЕНКА</div>
    </div>
  </div>
  <div class="vbar-wrap">
    <div class="vbar-hd">
      <span style="font-size:11px;color:var(--text2)">Нарушения</span>
      <span style="font-size:11px;font-family:var(--mono);color:${vc(v,S.threshold)}">${v}/${S.threshold}</span>
    </div>
    <div class="vbar-track"><div class="vbar-fill" style="width:${pct}%;background:${vc(v,S.threshold)}"></div></div>
  </div>
  ${v>=S.threshold ? `<div class="alert-red" style="margin-top:10px;font-size:12px">⚠ Превышен порог нарушений</div>` : ""}
  <div style="display:flex;gap:6px;margin-top:10px">
    <button class="btn-ghost btn-sm" style="flex:1" data-reset-mgr="${m.id}">Сброс</button>
    <button class="btn-ghost btn-sm" style="flex:1" data-view-mgr="${m.id}">Детали →</button>
  </div>
</div>`;
}

// ── Manager detail ─────────────────────────────────────────
function pageManagerDetail() {
  const m   = S.selected;
  const v   = m.violations||0;
  const pct = Math.min(100, Math.round(v/S.threshold*100));

  return `
<div style="display:flex;flex-direction:column;gap:16px">
  <div class="card detail-header">
    <div class="mhd" style="margin-bottom:0">
      <div class="av av-lg" style="background:${m.color}">${esc(m.avatar)}</div>
      <div style="flex:1">
        <div style="font-size:20px;font-weight:700">${esc(m.name)}</div>
        <div class="musername" style="font-size:13px">@${esc(m.username||"")}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-ghost btn-sm" data-edit-mgr="${m.id}">✎ Редактировать</button>
      </div>
    </div>
  </div>

  <div class="detail-stats">
    <div class="stat-card"><div class="stat-val" style="color:#a5b4fc">${m.calls_count||0}</div><div class="stat-lbl">Всего звонков</div></div>
    <div class="stat-card"><div class="stat-val" style="color:${vc(v,S.threshold)}">${v}</div><div class="stat-lbl">Нарушений</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#4ade80">${m.avg_score!=null?m.avg_score:"—"}</div><div class="stat-lbl">Средняя оценка</div></div>
  </div>

  <div class="card">
    <div class="ctitle">Статус нарушений</div>
    <div class="vbar-wrap">
      <div class="vbar-hd">
        <span>Нарушения</span>
        <span style="font-family:var(--mono);color:${vc(v,S.threshold)}">${v} / ${S.threshold}</span>
      </div>
      <div class="vbar-track" style="height:8px"><div class="vbar-fill" style="width:${pct}%;background:${vc(v,S.threshold)}"></div></div>
    </div>
    ${v>=S.threshold?`<div class="alert-red" style="margin-top:12px">⚠ Порог нарушений превышен — требуется внимание руководителя</div>`:""}
    <button class="btn-ghost btn-sm" data-reset-mgr="${m.id}" style="margin-top:12px">Сбросить статистику</button>
  </div>

  <div>
    <div class="ctitle" style="margin-bottom:12px">Записи звонков (${S.mgrCalls.length})</div>
    ${!S.mgrCalls.length ? `<div class="empty-sm">Звонков пока нет</div>` : S.mgrCalls.map(c => callCard(c)).join("")}
  </div>
</div>`;
}

function callCard(c) {
  const draft = S.commentDraft[c.id] !== undefined ? S.commentDraft[c.id] : (c.adminComment||"");
  const saving = S.savingCommentId === c.id;
  const errHtml = (c.errors||[]).map(e=>`
<div class="err-item">
  <span class="sev sev-${e.severity||"low"}">${e.severity==="high"?"Критично":e.severity==="medium"?"Средне":"Мало"}</span>
  <div><div class="err-t">${esc(e.title)}</div><div class="err-d">${esc(e.description)}</div></div>
</div>`).join("");
  const posHtml = (c.positives||[]).map(p=>`<div class="pos-item">+ ${esc(p)}</div>`).join("");
  const isAudioOpen = S.activeAudioCallId === c.id;

  return `
<div class="call-card">
  <div class="call-meta" style="margin-bottom:10px">
    <span class="call-ph">${esc(c.phone||"—")}</span>
    <span style="font-size:11px;color:var(--text3);font-family:var(--mono)">${(c.created_at||"").slice(0,16)}</span>
    ${c.duration?`<span style="font-size:11px;color:var(--text3);font-family:var(--mono)">${fmt(c.duration)}</span>`:""}
    ${c.score!=null?`<span class="score-chip" style="color:${sc(c.score)}">${c.score}/100</span>`:""}
    <span class="ctag ${c.saved?"ctag-saved":"ctag-anl"}">${c.saved?"→ контакт":"аналитика"}</span>
    ${c.audioFile?`<button class="btn-ghost btn-sm" data-play="${c.id}" data-af="${esc(c.audioFile)}" style="margin-left:auto">${isAudioOpen?"■ Закрыть":"▶ Запись"}</button>`:""}
  </div>
  ${isAudioOpen?`<div style="margin-bottom:10px"><audio id="audio-${c.id}" controls style="width:100%;height:32px"></audio></div>`:""}
  ${c.summary?`<div class="call-sum" style="margin-bottom:8px">${esc(c.summary)}</div>`:""}
  ${errHtml?`<div class="err-list" style="margin-bottom:8px">${errHtml}</div>`:""}
  ${posHtml?`<div style="margin-bottom:8px">${posHtml}</div>`:""}
  ${c.recommendation?`<div class="rec-box" style="margin-bottom:8px">💡 ${esc(c.recommendation)}</div>`:""}
  ${c.transcript?`
  <details style="margin-bottom:10px">
    <summary style="cursor:pointer;font-size:12px;color:var(--text2);user-select:none;padding:4px 0">Транскрипт</summary>
    <div class="transcript-box" style="margin-top:6px">${esc(c.transcript)}</div>
  </details>`:""}
  <div style="margin-top:8px">
    <label style="font-size:11px;color:var(--text3);margin-bottom:4px;display:block">Комментарий администратора</label>
    <textarea class="comment-ta" data-comment-id="${c.id}" rows="2" placeholder="Введите комментарий по результатам ручной проверки...">${esc(draft)}</textarea>
    <button class="btn-ghost btn-sm ${saving?"disabled":""}" data-save-comment="${c.id}" ${saving?"disabled":""} style="margin-top:6px">
      ${saving?`<span class="spinner"></span> Сохраняю...`:"Сохранить комментарий"}
    </button>
    ${c.adminComment&&S.commentDraft[c.id]===undefined?`<span style="font-size:11px;color:#4ade80;margin-left:8px">✓ Сохранён</span>`:""}
  </div>
</div>`;
}

// ── Settings page ──────────────────────────────────────────
function pageSettings() {
  const f = S.settingsForm;
  return `
<div style="display:flex;flex-direction:column;gap:18px;max-width:440px">
  <div class="card">
    <div class="ctitle">Порог уведомлений о нарушениях</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:14px">Администратор получает уведомление, когда число нарушений менеджера кратно этому числу.</p>
    <label>Количество нарушений для уведомления</label>
    <input id="s-threshold" type="number" min="1" max="100" value="${S.threshold}" style="width:120px"/>
    <button class="btn-primary" id="btn-save-threshold" style="margin-top:14px">Сохранить порог</button>
  </div>
  <div class="card">
    <div class="ctitle">Сменить логин и пароль администратора</div>
    ${S.settingsDone ? `<div class="alert-green" style="margin-bottom:14px">✓ Сохранено успешно</div>` : ""}
    ${S.settingsError ? `<div class="alert-red" style="margin-bottom:14px">${esc(S.settingsError)}</div>` : ""}
    <label>Новый логин</label>
    <input id="s-username" type="text" placeholder="admin" value="${esc(f.username)}"/>
    <label>Новый пароль</label>
    <input id="s-password" type="password" placeholder="Минимум 4 символа" value="${esc(f.password)}"/>
    <label>Повторите пароль</label>
    <input id="s-password2" type="password" placeholder="Повторите пароль" value="${esc(f.password2)}"/>
    <button class="btn-primary btn-full ${S.settingsBusy?"disabled":""}" id="btn-save-settings" ${S.settingsBusy?"disabled":""} style="margin-top:20px">
      ${S.settingsBusy?`<span class="spinner"></span> Сохраняю...`:"Сохранить учётные данные"}
    </button>
    <div style="margin-top:12px;font-size:12px;color:var(--text3)">
      По умолчанию: логин <code>admin</code>, пароль <code>admin</code>
    </div>
  </div>
</div>`;
}

// ── Modals ─────────────────────────────────────────────────
function modalHtml() {
  if (S.modal === "add")    return modalAdd();
  if (S.modal === "edit")   return modalEdit();
  if (S.modal === "delete") return modalDelete();
  return "";
}

function modalAdd() {
  const f = S.form;
  return `<div class="overlay"><div class="modal">
  <div class="modal-header">
    <h2>Новый менеджер</h2>
    <button class="modal-close" id="modal-close">✕</button>
  </div>
  ${S.formError?`<div class="alert-red" style="margin-bottom:14px">${esc(S.formError)}</div>`:""}
  <label>Имя Фамилия *</label>
  <input id="f-name" type="text" placeholder="Иван Петров" value="${esc(f.name)}"/>
  <label>Логин (username) *</label>
  <input id="f-username" type="text" placeholder="ivan.petrov" value="${esc(f.username)}"/>
  <label>Пароль *</label>
  <input id="f-password" type="password" placeholder="Минимум 4 символа" value="${esc(f.password)}"/>
  <label>Цвет аватара</label>
  <div class="color-row">${COLORS.map(c=>`<div class="color-dot ${f.color===c?"color-dot-sel":""}" data-color="${c}" style="background:${c}"></div>`).join("")}</div>
  <div class="mrow" style="margin-top:20px">
    <button class="btn-ghost" id="modal-close2">Отмена</button>
    <button class="btn-primary ${S.formBusy?"disabled":""}" id="btn-save-mgr" ${S.formBusy?"disabled":""}>
      ${S.formBusy?`<span class="spinner"></span> Сохраняю...`:"Создать менеджера"}
    </button>
  </div>
</div></div>`;
}

function modalEdit() {
  const f = S.editForm;
  return `<div class="overlay"><div class="modal">
  <div class="modal-header">
    <h2>Редактировать менеджера</h2>
    <button class="modal-close" id="modal-close">✕</button>
  </div>
  ${S.formError?`<div class="alert-red" style="margin-bottom:14px">${esc(S.formError)}</div>`:""}
  <label>Имя Фамилия</label>
  <input id="ef-name" type="text" value="${esc(f.name)}"/>
  <label>Логин (username)</label>
  <input id="ef-username" type="text" value="${esc(f.username)}"/>
  <label>Новый пароль <span style="color:var(--text3)">(оставьте пустым чтобы не менять)</span></label>
  <input id="ef-password" type="password" placeholder="Новый пароль..."/>
  <label>Цвет аватара</label>
  <div class="color-row">${COLORS.map(c=>`<div class="color-dot ${f.color===c?"color-dot-sel":""}" data-color-edit="${c}" style="background:${c}"></div>`).join("")}</div>
  <div class="mrow" style="margin-top:20px">
    <button class="btn-ghost" id="modal-close2">Отмена</button>
    <button class="btn-primary ${S.formBusy?"disabled":""}" id="btn-update-mgr" ${S.formBusy?"disabled":""}>
      ${S.formBusy?`<span class="spinner"></span> Сохраняю...`:"Сохранить"}
    </button>
  </div>
</div></div>`;
}

function modalDelete() {
  const m = S.managers.find(x=>x.id===S.pendingDeleteId);
  return `<div class="overlay"><div class="modal" style="max-width:400px">
  <h2>Удалить менеджера?</h2>
  <div class="modal-sub" style="margin-top:8px">
    Менеджер <strong>${esc(m?.name||"")}</strong> (@${esc(m?.username||"")}) и все его данные будут удалены.
    Это действие нельзя отменить.
  </div>
  <div class="mrow" style="margin-top:20px">
    <button class="btn-ghost" id="modal-close2">Отмена</button>
    <button class="btn-red" id="btn-confirm-delete">Удалить</button>
  </div>
</div></div>`;
}

// ═══════════════════════════════════════════════════════════
// LICENSES PAGE
// ═══════════════════════════════════════════════════════════
function pageLicenses() {
  if (S.licBusy) return `<div class="empty"><span class="spinner"></span></div>`;

  const st  = S.licStatus;
  const inf = v => (v === -1 || v == null) ? "∞" : v;

  // Status card
  let statusCard = "";
  if (st) {
    const isDev     = st.plan === "dev";
    const isValid   = st.valid;
    const used      = st.usage?.used ?? 0;
    const limit     = st.limits?.requests_per_month ?? -1;
    const pct       = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
    const barColor  = pct >= 90 ? "#f87171" : pct >= 70 ? "#fbbf24" : "#4ade80";
    const expiresAt = st.expires_at
      ? new Date(st.expires_at).toLocaleDateString("ru")
      : null;

    statusCard = `
<div class="card" style="margin-bottom:20px">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
    <div>
      <div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Текущая лицензия</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span class="lic-status ${isDev?"lic-dev":isValid?"lic-active":"lic-revoked"}">
          ${isDev ? "Dev-режим" : isValid ? "Активна" : "Недействительна"}
        </span>
        ${st.plan && !isDev ? `<span style="font-family:var(--mono);font-size:13px;font-weight:600">${esc(st.plan)}</span>` : ""}
        ${st.customer ? `<span style="font-size:12px;color:var(--text2)">${esc(st.customer)}</span>` : ""}
      </div>
      ${st.keyMasked && !isDev ? `<div style="font-family:var(--mono);font-size:11px;color:var(--text3)">${esc(st.keyMasked)}</div>` : ""}
      ${expiresAt ? `<div style="font-size:11px;color:var(--text2);margin-top:4px">Действует до: ${expiresAt}</div>` : ""}
      ${!isValid && st.reason ? `<div class="alert-red" style="margin-top:8px;font-size:12px">${esc(st.reason)}</div>` : ""}
    </div>
    ${!isDev ? `
    <div style="min-width:200px">
      <div style="font-size:11px;color:var(--text2);margin-bottom:6px">Использование (${st.usage?.month||"—"})</div>
      <div class="sgrid" style="grid-template-columns:1fr 1fr">
        <div class="sbox"><div class="sval">${inf(st.limits?.max_devices)}</div><div class="slbl">устройств</div></div>
        <div class="sbox"><div class="sval" style="font-size:14px">${used}/${inf(limit)}</div><div class="slbl">запросов</div></div>
      </div>
      ${limit > 0 ? `
      <div class="lic-bar-track" style="margin-top:10px">
        <div class="lic-bar-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>` : ""}
    </div>` : ""}
  </div>
</div>`;
  }

  return `
<div style="max-width:560px">
  ${statusCard}

  <div class="card">
    <div class="ctitle">Активировать лицензию</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:16px;line-height:1.6">
      Введите лицензионный ключ, полученный от поставщика системы.
      После активации ключ сохраняется в базе данных и применяется автоматически.
    </div>
    ${S.licError   ? `<div class="alert-red"   style="margin-bottom:12px">${esc(S.licError)}</div>`   : ""}
    ${S.licSuccess ? `<div class="alert-green" style="margin-bottom:12px">${esc(S.licSuccess)}</div>` : ""}
    <label>Лицензионный ключ</label>
    <input id="lic-key-input" type="text" placeholder="SALES-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      value="${esc(S.activateKey)}" style="font-family:var(--mono);font-size:12px"/>
    <button class="btn-primary btn-full" id="btn-activate-license" style="margin-top:14px">
      ${S.licBusy ? `<span class="spinner"></span> Проверяю…` : "Активировать"}
    </button>
  </div>
</div>`;
}

// ═══════════════════════════════════════════════════════════
// EVENT BINDING
// ═══════════════════════════════════════════════════════════
function bind() {
  // Login
  document.getElementById("btn-login")?.addEventListener("click", doLogin);
  document.getElementById("login-username")?.addEventListener("keydown", e => { if(e.key==="Enter") doLogin(); });
  document.getElementById("login-password")?.addEventListener("keydown", e => { if(e.key==="Enter") doLogin(); });

  // Logout
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await window.api.setToken(null);
    S.token=null; S.managers=[]; S.calls=[]; S.selected=null; render();
  });

  // Navigation
  document.getElementById("nav-managers")?.addEventListener("click", () => {
    S.page="managers"; S.selected=null; S.mgrCalls=[]; render();
  });
  document.getElementById("nav-settings")?.addEventListener("click", () => {
    S.page="settings"; S.selected=null; S.mgrCalls=[];
    S.settingsForm={username:"",password:"",password2:""}; S.settingsError=""; S.settingsDone=false; render();
  });
  document.getElementById("nav-licenses")?.addEventListener("click", () => {
    S.page="licenses"; S.selected=null; S.mgrCalls=[]; render();
    loadLicenseStatus();
  });
  document.getElementById("btn-back")?.addEventListener("click", () => {
    S.selected=null; S.mgrCalls=[]; S.activeAudioCallId=null; render();
  });

  // Settings — threshold
  document.getElementById("btn-save-threshold")?.addEventListener("click", async () => {
    const val = parseInt(document.getElementById("s-threshold")?.value)||5;
    const t   = Math.max(1, Math.min(100, val));
    await window.api.put("/api/settings", { violations_threshold: t });
    S.threshold = t;
    render();
  });

  // Settings — admin credentials
  document.getElementById("s-username")?.addEventListener("input",   e => { S.settingsForm.username=e.target.value; });
  document.getElementById("s-password")?.addEventListener("input",   e => { S.settingsForm.password=e.target.value; });
  document.getElementById("s-password2")?.addEventListener("input",  e => { S.settingsForm.password2=e.target.value; });
  document.getElementById("btn-save-settings")?.addEventListener("click", async () => {
    const username  = document.getElementById("s-username")?.value.trim()||"";
    const password  = document.getElementById("s-password")?.value||"";
    const password2 = document.getElementById("s-password2")?.value||"";
    if (!username)              { S.settingsError="Введите логин"; render(); return; }
    if (!password)              { S.settingsError="Введите пароль"; render(); return; }
    if (password.length < 4)    { S.settingsError="Пароль минимум 4 символа"; render(); return; }
    if (password !== password2) { S.settingsError="Пароли не совпадают"; render(); return; }
    S.settingsBusy=true; S.settingsError=""; S.settingsDone=false; render();
    const res = await window.api.put("/api/auth/admin", { username, password });
    S.settingsBusy=false;
    if (res?.error) { S.settingsError=res.error; render(); return; }
    S.settingsDone=true; S.settingsForm={username:"",password:"",password2:""}; render();
    setTimeout(()=>{ S.settingsDone=false; render(); }, 3000);
  });

  // Add manager button
  document.getElementById("btn-add-mgr")?.addEventListener("click", () => {
    S.form = { name:"", username:"", password:"", color:"#6366f1" };
    S.formError=""; S.modal="add"; render();
  });

  // Card click → detail view
  document.querySelectorAll("[data-mgr]").forEach(el =>
    el.addEventListener("click", e => {
      if (e.target.closest("[data-edit-mgr],[data-delete-mgr],[data-reset-mgr],[data-view-mgr]")) return;
      openManagerDetail(+el.dataset.mgr);
    })
  );

  // View detail button
  document.querySelectorAll("[data-view-mgr]").forEach(el =>
    el.addEventListener("click", e => {
      e.stopPropagation();
      openManagerDetail(+el.dataset.viewMgr);
    })
  );

  // Edit manager
  document.querySelectorAll("[data-edit-mgr]").forEach(el =>
    el.addEventListener("click", e => {
      e.stopPropagation();
      const m = S.managers.find(x=>x.id===+el.dataset.editMgr);
      if (!m) return;
      S.editForm = { id:m.id, name:m.name, username:m.username||"", password:"", color:m.color };
      S.formError=""; S.modal="edit"; render();
    })
  );

  // Delete manager
  document.querySelectorAll("[data-delete-mgr]").forEach(el =>
    el.addEventListener("click", e => {
      e.stopPropagation();
      S.pendingDeleteId=+el.dataset.deleteMgr;
      S.modal="delete"; render();
    })
  );

  // Reset stats
  document.querySelectorAll("[data-reset-mgr]").forEach(el =>
    el.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm("Сбросить статистику менеджера?")) return;
      await window.api.delete(`/api/managers/${el.dataset.resetMgr}/reset`);
      await load();
      if (S.selected?.id === +el.dataset.resetMgr)
        S.selected = S.managers.find(m=>m.id===S.selected.id)||null;
      render();
    })
  );

  // ── Licenses page ─────────────────────────────────────────
  document.getElementById("lic-key-input")?.addEventListener("input", e => { S.activateKey = e.target.value; });

  document.getElementById("btn-activate-license")?.addEventListener("click", async () => {
    const key = (document.getElementById("lic-key-input")?.value || S.activateKey).trim();
    if (!key) { S.licError = "Введите лицензионный ключ"; render(); return; }
    S.licBusy = true; S.licError = ""; S.licSuccess = ""; render();
    const res = await window.api.post("/api/license/activate", { key });
    S.licBusy = false;
    if (res?.error) { S.licError = res.error; render(); return; }
    S.activateKey = "";
    S.licSuccess = `Лицензия активирована — план: ${res.plan || "—"}`;
    await loadLicenseStatus();
  });

  // Play audio
  document.querySelectorAll("[data-play]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const callId    = parseInt(btn.dataset.play);
      const audioFile = btn.dataset.af;
      if (S.activeAudioCallId === callId) {
        S.activeAudioCallId = null; render(); return;
      }
      S.activeAudioCallId = callId; render();
      const buf = await window.api.getAudioData(audioFile);
      if (!buf) { alert("Файл записи не найден"); S.activeAudioCallId=null; render(); return; }
      const blob = new Blob([buf], { type:"audio/webm" });
      const url  = URL.createObjectURL(blob);
      const el   = document.getElementById(`audio-${callId}`);
      if (el) { el.src=url; el.play().catch(()=>{}); }
    });
  });

  // Comment textarea — track draft
  document.querySelectorAll(".comment-ta").forEach(ta => {
    ta.addEventListener("input", e => {
      S.commentDraft[+ta.dataset.commentId] = e.target.value;
    });
  });

  // Save comment
  document.querySelectorAll("[data-save-comment]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const callId = parseInt(btn.dataset.saveComment);
      const text   = S.commentDraft[callId] !== undefined
        ? S.commentDraft[callId]
        : (S.mgrCalls.find(c=>c.id===callId)?.adminComment||"");
      S.savingCommentId = callId; render();
      await window.api.put(`/api/calls/${callId}/comment`, { adminComment: text });
      // Update local mgrCalls record
      const call = S.mgrCalls.find(c=>c.id===callId);
      if (call) call.adminComment = text;
      delete S.commentDraft[callId];
      S.savingCommentId = null; render();
    });
  });

  // Modal close
  document.getElementById("modal-close")?.addEventListener("click",  () => { S.modal=null; render(); });
  document.getElementById("modal-close2")?.addEventListener("click", () => { S.modal=null; render(); });

  // Color picker (add)
  document.querySelectorAll("[data-color]").forEach(el =>
    el.addEventListener("click", () => { S.form.color=el.dataset.color; render(); })
  );
  // Color picker (edit)
  document.querySelectorAll("[data-color-edit]").forEach(el =>
    el.addEventListener("click", () => { S.editForm.color=el.dataset.colorEdit; render(); })
  );

  // Form inputs (add)
  document.getElementById("f-name")?.addEventListener("input",     e => { S.form.name=e.target.value; });
  document.getElementById("f-username")?.addEventListener("input", e => { S.form.username=e.target.value; });
  document.getElementById("f-password")?.addEventListener("input", e => { S.form.password=e.target.value; });

  // Save new manager
  document.getElementById("btn-save-mgr")?.addEventListener("click", async () => {
    const name     = document.getElementById("f-name")?.value.trim()||"";
    const username = document.getElementById("f-username")?.value.trim()||"";
    const password = document.getElementById("f-password")?.value||"";
    if (!name)            { S.formError="Введите имя";    render(); return; }
    if (!username)        { S.formError="Введите логин";  render(); return; }
    if (password.length < 4) { S.formError="Пароль минимум 4 символа"; render(); return; }
    S.formBusy=true; S.formError=""; render();
    const res = await window.api.post("/api/managers", { name, username, password, color:S.form.color });
    S.formBusy=false;
    if (res?.error) { S.formError=res.error; render(); return; }
    S.modal=null; await load();
  });

  // Form inputs (edit)
  document.getElementById("ef-name")?.addEventListener("input",     e => { S.editForm.name=e.target.value; });
  document.getElementById("ef-username")?.addEventListener("input", e => { S.editForm.username=e.target.value; });

  // Save edited manager
  document.getElementById("btn-update-mgr")?.addEventListener("click", async () => {
    const name     = document.getElementById("ef-name")?.value.trim()||"";
    const username = document.getElementById("ef-username")?.value.trim()||"";
    const password = document.getElementById("ef-password")?.value||"";
    if (!name)     { S.formError="Введите имя";   render(); return; }
    if (!username) { S.formError="Введите логин"; render(); return; }
    S.formBusy=true; S.formError=""; render();
    const res = await window.api.put(`/api/managers/${S.editForm.id}`, { name, username, password, color:S.editForm.color });
    S.formBusy=false;
    if (res?.error) { S.formError=res.error; render(); return; }
    S.modal=null;
    await load();
    if (S.selected?.id === S.editForm.id)
      S.selected = S.managers.find(m=>m.id===S.editForm.id)||null;
    render();
  });

  // Confirm delete
  document.getElementById("btn-confirm-delete")?.addEventListener("click", async () => {
    const res = await window.api.delete(`/api/managers/${S.pendingDeleteId}`);
    if (res?.error) { alert(res.error); return; }
    if (S.selected?.id === S.pendingDeleteId) { S.selected=null; S.mgrCalls=[]; }
    S.modal=null; S.pendingDeleteId=null;
    await load();
  });
}

async function openManagerDetail(mgrId) {
  const m = S.managers.find(x=>x.id===mgrId);
  if (!m) return;
  S.selected          = m;
  S.activeAudioCallId = null;
  S.commentDraft      = {};
  render();
  await loadMgrCalls(mgrId);
  render();
}

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════
async function doLogin() {
  const username = document.getElementById("login-username")?.value.trim()||"";
  const password = document.getElementById("login-password")?.value||"";
  if (!username || !password) { S.loginError="Введите логин и пароль"; render(); return; }
  S.loginBusy=true; S.loginError=""; render();
  const res = await window.api.post("/api/auth/admin", { username, password });
  S.loginBusy=false;
  if (res?.error || !res?.token) {
    S.loginError = res?.error||"Неверный логин или пароль"; render(); return;
  }
  S.token = res.token;
  await window.api.setToken(res.token);
  load();
}

// ═══════════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════════
const style = document.createElement("style");
style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Manrope:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0f;--surface:#13131a;--surface2:#1c1c26;
  --border:rgba(255,255,255,.07);--border2:rgba(255,255,255,.12);
  --accent:#ffffff;--accent2:#e2e8f0;
  --text:#f1f5f9;--text2:#94a3b8;--text3:#475569;
  --mono:'IBM Plex Mono',monospace;--sans:'Manrope',sans-serif;
  --r:10px;--rl:16px;
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.6}
.shell{display:flex;height:100vh}

/* Sidebar */
.sidebar{width:220px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:20px 0;overflow-y:auto}
.logo{padding:0 20px 18px;border-bottom:1px solid var(--border);margin-bottom:12px;cursor:default}
.logo-tag{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:2px;text-transform:uppercase}
.logo-h{font-size:16px;font-weight:700;margin-top:2px;letter-spacing:-.3px}
.nav-section{padding:0 12px;margin-bottom:8px}
.nav-label{font-size:10px;font-weight:600;color:var(--text3);letter-spacing:1px;text-transform:uppercase;padding:4px 8px;margin-bottom:4px}
.nav{display:flex;align-items:center;gap:10px;padding:9px 8px;cursor:pointer;color:var(--text2);font-size:13px;font-weight:500;border-radius:var(--r);transition:all .15s;user-select:none}
.nav:hover{color:var(--text);background:rgba(255,255,255,.06)}
.nav.on{color:var(--accent2);background:rgba(255,255,255,.14);font-weight:600}
.nicon{width:18px;text-align:center}
.nbadge{margin-left:auto;font-size:10px;font-weight:600;border-radius:10px;padding:1px 7px;font-family:var(--mono);background:rgba(255,255,255,.2);color:var(--accent2)}
.sidebar-bottom{margin-top:auto;padding:14px 20px;border-top:1px solid var(--border)}
.stat-mini{font-size:12px;color:var(--text2)}
.stat-mini-row{display:flex;justify-content:space-between;padding:3px 0}
.stat-mini-val{font-family:var(--mono);font-weight:600;color:var(--text)}

/* Main */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{display:flex;align-items:flex-start;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.pt{font-size:16px;font-weight:700;letter-spacing:-.3px}
.ps{font-size:12px;color:var(--text2);margin-top:1px}
.content{flex:1;overflow-y:auto;padding:24px 28px}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:20px}
.ctitle{font-size:10px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--text3);margin-bottom:14px}

/* Form */
label{font-size:12px;color:var(--text2);display:block;margin-bottom:5px;margin-top:12px}
label:first-of-type{margin-top:0}
input,select,textarea{width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--r);color:var(--text);font-family:var(--sans);font-size:13px;padding:9px 12px;outline:none;transition:border .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,255,255,.15)}
textarea{resize:vertical;font-size:12px;line-height:1.5}

/* Buttons */
.btn-primary{background:var(--accent);color:#0a0a0f;border:none;border-radius:var(--r);padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn-primary:hover{background:var(--accent2)}
.btn-full{width:100%}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:var(--r);padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:6px}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent2)}
.btn-red{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.2);border-radius:var(--r);padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer}
.btn-red:hover{background:rgba(239,68,68,.22)}
.btn-sm{font-size:11px;padding:5px 12px}

/* Icon buttons */
.icon-btn{background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text2);width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center;transition:all .15s}
.icon-btn:hover{color:var(--text);border-color:var(--border2)}
.icon-btn-red:hover{color:#f87171;border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.1)}

/* Managers grid */
.mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.mcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:18px;cursor:pointer;transition:border .15s}
.mcard:hover{border-color:var(--border2)}
.mhd{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.mcard-actions{display:flex;gap:6px;margin-left:auto;flex-shrink:0}
.mname{font-size:15px;font-weight:700;line-height:1.2}
.musername{font-size:12px;color:var(--text3);font-family:var(--mono)}
.av{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0a0a0f;flex-shrink:0}
.av-lg{width:52px;height:52px;font-size:18px}
.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.sbox{background:var(--surface2);border-radius:var(--r);padding:8px;text-align:center}
.sval{font-size:18px;font-weight:700;font-family:var(--mono)}
.slbl{font-size:10px;color:var(--text3);margin-top:1px;letter-spacing:.5px}
.vbar-wrap{margin-top:12px}
.vbar-hd{display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-bottom:5px}
.vbar-track{height:5px;background:var(--surface2);border-radius:3px;overflow:hidden}
.vbar-fill{height:100%;border-radius:3px;transition:width .5s}

/* Detail */
.detail-header{padding:20px}
.detail-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:20px;text-align:center}
.stat-val{font-size:32px;font-weight:700;font-family:var(--mono)}
.stat-lbl{font-size:12px;color:var(--text2);margin-top:4px}

/* Call cards */
.call-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:10px}
.call-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.call-ph{font-family:var(--mono);font-size:13px;font-weight:500}
.call-sum{font-size:12px;color:var(--text2);line-height:1.5}
.score-chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;font-family:var(--mono)}
.ctag{font-size:11px;padding:2px 8px;border-radius:20px;font-family:var(--mono)}
.ctag-saved{background:rgba(255,255,255,.15);color:var(--accent2)}
.ctag-anl{background:var(--surface2);color:var(--text3)}
.empty-sm{font-size:12px;color:var(--text3);padding:12px 0}
audio{border-radius:6px;background:var(--surface2)}
.transcript-box{font-size:12px;font-family:var(--mono);color:var(--text2);line-height:1.7;max-height:200px;overflow-y:auto;background:var(--surface2);padding:10px 14px;border-radius:var(--r)}
details summary::-webkit-details-marker{color:var(--text3)}
.comment-ta{font-family:var(--sans);font-size:12px;line-height:1.5;padding:8px 12px}

/* Errors/positives */
.err-list{display:flex;flex-direction:column;gap:6px}
.err-item{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;background:var(--surface2);border-radius:var(--r);border:1px solid var(--border)}
.sev{font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;white-space:nowrap;flex-shrink:0;margin-top:2px;font-family:var(--mono)}
.sev-high{background:#fee2e2;color:#991b1b}
.sev-medium{background:#fef3c7;color:#92400e}
.sev-low{background:#dcfce7;color:#166534}
.err-t{font-size:12px;font-weight:500}
.err-d{font-size:11px;color:var(--text2);margin-top:2px}
.pos-item{font-size:12px;color:#4ade80;padding:4px 10px;background:rgba(34,197,94,.06);border-radius:var(--r);border-left:2px solid #22c55e;margin-bottom:4px}
.rec-box{padding:10px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:var(--r);font-size:12px;color:var(--accent2);line-height:1.6}

/* Alert banner */
.alert-banner{display:flex;align-items:flex-start;gap:14px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:var(--rl);padding:14px 18px;color:var(--text)}
.alert-icon{font-size:20px;flex-shrink:0;margin-top:1px}
.alert-red{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#fca5a5;padding:10px 14px;border-radius:var(--r);font-size:13px}
.alert-green{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);color:#4ade80;padding:10px 14px;border-radius:var(--r);font-size:13px}
code{font-family:var(--mono);font-size:12px;background:var(--surface2);padding:2px 6px;border-radius:4px;color:var(--accent2)}

/* Color picker */
.color-row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.color-dot{width:28px;height:28px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:transform .15s}
.color-dot:hover{transform:scale(1.15)}
.color-dot-sel{border-color:var(--accent);transform:scale(1.15)}

/* Modal */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(4px)}
.modal{background:var(--surface);border:1px solid var(--border2);border-radius:var(--rl);padding:28px;width:480px;max-width:90vw;max-height:88vh;overflow-y:auto}
.modal h2{font-size:18px;font-weight:700}
.modal-sub{font-size:13px;color:var(--text2);line-height:1.6}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.modal-close{background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:2px 8px;border-radius:6px;line-height:1}
.modal-close:hover{color:var(--text);background:rgba(255,255,255,.08)}
.mrow{display:flex;gap:10px}
.mrow .btn-ghost,.mrow .btn-primary,.mrow .btn-red{flex:1;margin-top:0}

/* Login */
.login-shell{height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg)}
.login-card{background:var(--surface);border:1px solid var(--border2);border-radius:var(--rl);padding:36px 32px;width:380px}
.login-logo{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.login-title{font-size:16px;font-weight:700;margin-bottom:8px}

/* Spinner */
.spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}

/* License plans grid */
.plans-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.plan-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:16px}
.plan-hd{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px}
.plan-name{font-size:14px;font-weight:700}
.plan-slug{font-size:11px;font-family:var(--mono);color:var(--text3);margin-top:2px}
.plan-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.plan-stat{background:var(--surface2);border-radius:var(--r);padding:8px;text-align:center}
.plan-val{font-size:20px;font-weight:700;font-family:var(--mono)}
.plan-lbl{font-size:10px;color:var(--text3);margin-top:2px}
.plan-desc{font-size:11px;color:var(--text2);line-height:1.5}

/* License table */
.lic-table-wrap{overflow-x:auto;border-radius:var(--rl);border:1px solid var(--border)}
.lic-table{width:100%;border-collapse:collapse;font-size:13px}
.lic-table th{background:var(--surface2);color:var(--text3);font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;padding:10px 14px;text-align:left;border-bottom:1px solid var(--border)}
.lic-table td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
.lic-table tr:last-child td{border-bottom:none}
.lic-table tr:hover td{background:rgba(255,255,255,.02)}
.lic-inactive td{opacity:.5}
.lic-status{font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;font-family:var(--mono)}
.lic-active{background:rgba(34,197,94,.12);color:#4ade80}
.lic-revoked{background:rgba(239,68,68,.12);color:#f87171}
.lic-dev{background:rgba(99,102,241,.12);color:#a5b4fc}
.lic-bar-track{flex:1;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;min-width:60px}
.lic-bar-fill{height:100%;border-radius:3px;transition:width .4s}

/* Misc */
.empty{text-align:center;padding:60px 20px;color:var(--text3);font-size:13px}
.eicon{font-size:30px;margin-bottom:10px}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
`;
document.head.appendChild(style);

// ── Init ──────────────────────────────────────────────────
render();
