// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
const S = {
  token:    null,
  loginError: "",
  loginBusy:  false,

  page:     "managers",   // managers | settings
  managers: [],
  calls:    [],
  selected: null,   // selected manager object
  modal:    null,   // null | "add" | "edit" | "confirm-delete"
  pendingDeleteId: null,

  form: { name:"", username:"", password:"", color:"#6366f1" },
  editForm: { name:"", username:"", password:"", color:"" },
  settingsForm: { username:"", password:"", password2:"" },
  settingsError: "",
  settingsDone: false,
  settingsBusy: false,
  formError: "",
  formBusy: false,
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const sc  = s => s>=75?"#4ade80":s>=50?"#fbbf24":"#f87171";
const vc  = (v,t) => v>=t?"#f87171":v>=t*.6?"#fbbf24":"#4ade80";
const THRESHOLD = 5;

const COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#8b5cf6","#06b6d4"];

// ═══════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════
async function load() {
  [S.managers, S.calls] = await Promise.all([
    window.api.get("/api/managers").catch(()=>[]),
    window.api.get("/api/calls").catch(()=>[]),
  ]);
  render();
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
      ${S.page==="settings" ? pageSettings() : (S.selected ? pageManagerDetail() : pageManagers())}
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
        <span class="stat-mini-val" style="color:#f87171">${S.managers.filter(m=>(m.violations||0)>=THRESHOLD).length}</span>
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
  <div><div class="pt">Настройки</div><div class="ps">Учётные данные администратора</div></div>
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

  const alertMgrs = S.managers.filter(m=>(m.violations||0)>=THRESHOLD);
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
  const v = m.violations||0;
  const pct = Math.min(100, Math.round(v/THRESHOLD*100));
  const callsForMgr = S.calls.filter(c=>c.manager_id===m.id||false).length;
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
      <div class="sval" style="color:${vc(v,THRESHOLD)}">${v}</div>
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
      <span style="font-size:11px;font-family:var(--mono);color:${vc(v,THRESHOLD)}">${v}/${THRESHOLD}</span>
    </div>
    <div class="vbar-track"><div class="vbar-fill" style="width:${pct}%;background:${vc(v,THRESHOLD)}"></div></div>
  </div>
  ${v>=THRESHOLD ? `<div class="alert-red" style="margin-top:10px;font-size:12px">⚠ Превышен порог нарушений</div>` : ""}
  <div style="display:flex;gap:6px;margin-top:10px">
    <button class="btn-ghost btn-sm" style="flex:1" data-reset-mgr="${m.id}">Сброс статистики</button>
    <button class="btn-ghost btn-sm" style="flex:1" data-view-mgr="${m.id}">Детали →</button>
  </div>
</div>`;
}

// ── Manager detail ─────────────────────────────────────────
function pageManagerDetail() {
  const m = S.selected;
  const v = m.violations||0;
  const pct = Math.min(100, Math.round(v/THRESHOLD*100));
  const mgrCalls = S.calls.filter(c=>c.manager_id===m.id);

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
        <button class="btn-red btn-sm" data-delete-mgr="${m.id}">Удалить</button>
      </div>
    </div>
  </div>

  <div class="detail-stats">
    <div class="stat-card"><div class="stat-val" style="color:#a5b4fc">${m.calls_count||0}</div><div class="stat-lbl">Всего звонков</div></div>
    <div class="stat-card"><div class="stat-val" style="color:${vc(v,THRESHOLD)}">${v}</div><div class="stat-lbl">Нарушений</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#4ade80">${m.avg_score!=null?m.avg_score:"—"}</div><div class="stat-lbl">Средняя оценка</div></div>
  </div>

  <div class="card">
    <div class="ctitle">Статус нарушений</div>
    <div class="vbar-wrap">
      <div class="vbar-hd">
        <span>Нарушения</span>
        <span style="font-family:var(--mono);color:${vc(v,THRESHOLD)}">${v} / ${THRESHOLD}</span>
      </div>
      <div class="vbar-track" style="height:8px"><div class="vbar-fill" style="width:${pct}%;background:${vc(v,THRESHOLD)}"></div></div>
    </div>
    ${v>=THRESHOLD?`<div class="alert-red" style="margin-top:12px">⚠ Порог нарушений превышен — требуется внимание руководителя</div>`:""}
    <button class="btn-ghost btn-sm" data-reset-mgr="${m.id}" style="margin-top:12px">Сбросить статистику</button>
  </div>

  <div class="card">
    <div class="ctitle">Последние звонки (${mgrCalls.length})</div>
    ${mgrCalls.length ? mgrCalls.slice(0,10).map(c=>`
    <div class="call-row">
      <div class="call-meta">
        <span class="call-ph">${esc(c.phone||"—")}</span>
        <span style="font-size:11px;color:var(--text3);font-family:var(--mono)">${(c.created_at||"").slice(0,16)}</span>
        ${c.score!=null?`<span class="score-chip" style="color:${sc(c.score)}">${c.score}/100</span>`:""}
        ${(c.errors||[]).length?`<span style="font-size:11px;color:#f87171;font-family:var(--mono)">${c.errors.length} ошиб.</span>`:""}
      </div>
      ${c.summary?`<div class="call-sum">${esc(c.summary.slice(0,100))}${c.summary.length>100?"...":""}</div>`:""}
    </div>`).join("") : `<div class="empty-sm">Звонков пока нет</div>`}
  </div>
</div>`;
}

// ── Settings page ──────────────────────────────────────────
function pageSettings() {
  const f = S.settingsForm;
  return `
<div style="max-width:440px">
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
      ${S.settingsBusy?`<span class="spinner"></span> Сохраняю...`:"Сохранить"}
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
  document.getElementById("nav-managers")?.addEventListener("click", () => { S.page="managers"; S.selected=null; render(); });
  document.getElementById("nav-settings")?.addEventListener("click", () => { S.page="settings"; S.selected=null; S.settingsForm={username:"",password:"",password2:""}; S.settingsError=""; S.settingsDone=false; render(); });
  document.getElementById("btn-back")?.addEventListener("click", () => { S.selected=null; render(); });

  // Settings
  document.getElementById("s-username")?.addEventListener("input",   e => { S.settingsForm.username=e.target.value; });
  document.getElementById("s-password")?.addEventListener("input",   e => { S.settingsForm.password=e.target.value; });
  document.getElementById("s-password2")?.addEventListener("input",  e => { S.settingsForm.password2=e.target.value; });
  document.getElementById("btn-save-settings")?.addEventListener("click", async () => {
    const username  = document.getElementById("s-username")?.value.trim()||"";
    const password  = document.getElementById("s-password")?.value||"";
    const password2 = document.getElementById("s-password2")?.value||"";
    if (!username)                  { S.settingsError="Введите логин"; render(); return; }
    if (!password)                  { S.settingsError="Введите пароль"; render(); return; }
    if (password.length < 4)        { S.settingsError="Пароль минимум 4 символа"; render(); return; }
    if (password !== password2)     { S.settingsError="Пароли не совпадают"; render(); return; }
    S.settingsBusy=true; S.settingsError=""; S.settingsDone=false; render();
    const res = await window.api.put("/api/auth/admin", { username, password });
    S.settingsBusy=false;
    if (res?.error) { S.settingsError=res.error; render(); return; }
    S.settingsDone=true; S.settingsForm={username:"",password:"",password2:""}; render();
    setTimeout(()=>{ S.settingsDone=false; render(); }, 3000);
  });

  // Add manager button → open modal
  document.getElementById("btn-add-mgr")?.addEventListener("click", () => {
    S.form = { name:"", username:"", password:"", color:"#6366f1" };
    S.formError=""; S.modal="add"; render();
  });

  // Card click → detail view
  document.querySelectorAll("[data-mgr]").forEach(el =>
    el.addEventListener("click", e => {
      if (e.target.closest("[data-edit-mgr],[data-delete-mgr],[data-reset-mgr],[data-view-mgr]")) return;
      const m = S.managers.find(x=>x.id===+el.dataset.mgr);
      if (m) { S.selected=m; render(); }
    })
  );

  // View detail
  document.querySelectorAll("[data-view-mgr]").forEach(el =>
    el.addEventListener("click", e => {
      e.stopPropagation();
      const m = S.managers.find(x=>x.id===+el.dataset.viewMgr);
      if (m) { S.selected=m; render(); }
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
    if (S.selected?.id === S.pendingDeleteId) S.selected=null;
    S.modal=null; S.pendingDeleteId=null;
    await load();
  });
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
input,select{width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--r);color:var(--text);font-family:var(--sans);font-size:13px;padding:9px 12px;outline:none;transition:border .15s}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,255,255,.15)}

/* Buttons */
.btn-primary{background:var(--accent);color:#0a0a0f;border:none;border-radius:var(--r);padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn-primary:hover{background:var(--accent2)}
.btn-full{width:100%}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:var(--r);padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
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

/* Calls */
.call-row{padding:8px 0;border-bottom:.5px solid var(--border)}
.call-row:last-child{border-bottom:none}
.call-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px}
.call-ph{font-family:var(--mono);font-size:13px;font-weight:500}
.call-sum{font-size:12px;color:var(--text2);line-height:1.5}
.score-chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;font-family:var(--mono)}
.empty-sm{font-size:12px;color:var(--text3);padding:12px 0}

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
.login-hint{font-size:12px;color:var(--text3);line-height:1.6;margin-bottom:20px}

/* Spinner */
.spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}

/* Misc */
.empty{text-align:center;padding:60px 20px;color:var(--text3);font-size:13px}
.eicon{font-size:30px;margin-bottom:10px}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
`;
document.head.appendChild(style);

// ── Init ──────────────────────────────────────────────────
render();
