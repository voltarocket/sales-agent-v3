// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
const S = {
  page:        "phone",   // phone | contacts | calls | managers | analytics
  wsStatus:    "disconnected",
  recording:   false,
  seconds:     0,
  phone:       "",
  managerId:   1,
  managers:    [],
  contacts:    [],
  calls:       [],
  analysis:    null,
  transcript:  "",
  duration:    0,
  modal:       null,   // null | "wait" | "ask" | "form" | "saving" | "done"
  company:     "",
  cname:       "",
  selectedContact: null,
  manualTxt:   "",
  manualRes:   null,
  manualBusy:  false,
  threshold:   5,
  mediaRecorder: null,
  timerInt:    null,
  skipNextAnalysis: false,
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const fmt = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const sc  = s => s>=75?"#4ade80":s>=50?"#fbbf24":"#f87171";
const vc  = (v,t) => v>=t?"#f87171":v>=t*.6?"#fbbf24":"#4ade80";
const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// ═══════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════
async function load() {
  [S.contacts, S.calls, S.managers] = await Promise.all([
    window.api.get("/api/contacts").catch(()=>[]),
    window.api.get("/api/calls").catch(()=>[]),
    window.api.get("/api/managers").catch(()=>[]),
  ]);
  if (S.managers.length && !S.managers.find(m=>m.id===S.managerId))
    S.managerId = S.managers[0].id;
  render();
}

// ═══════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════
async function startAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:false, noiseSuppression:false, sampleRate:16000, channelCount:1 },
      video: false,
    });
    const mr = new MediaRecorder(stream, { mimeType:"audio/webm;codecs=opus" });
    mr.ondataavailable = async e => {
      if (e.data?.size > 0) {
        const buf = await e.data.arrayBuffer();
        window.api.sendAudioChunk(buf);
      }
    };
    mr.start(1000);
    S.mediaRecorder = mr;
    return true;
  } catch(e) { alert("Нет доступа к микрофону: "+e.message); return false; }
}

function stopAudio() {
  if (S.mediaRecorder?.state !== "inactive") {
    S.mediaRecorder?.stop();
    S.mediaRecorder?.stream?.getTracks().forEach(t=>t.stop());
  }
  S.mediaRecorder = null;
}

// ═══════════════════════════════════════════════════════════
// CALL FLOW
// ═══════════════════════════════════════════════════════════
async function startCall() {
  const ok = await window.api.startRecording({ phone: "", managerId: S.managerId });
  if (ok?.error) { alert(ok.error); return; }

  if (!await startAudio()) return;

  S.recording = true; S.seconds = 0;
  S.timerInt = setInterval(()=>{
    S.seconds++;
    const t = fmt(S.seconds);
    const el = document.getElementById("timer"); if(el) el.textContent=t;
    const st = document.getElementById("sidebar-timer"); if(st) st.textContent=t;
    const tt = document.getElementById("topbar-timer"); if(tt) tt.textContent=t;
  }, 1000);
  render();
}

async function stopCall() {
  stopAudio();
  clearInterval(S.timerInt);
  S.duration = S.seconds;
  S.recording = false;
  await window.api.stopRecording();
  S.modal = "wait"; render();
}

async function discardCall() {
  await window.api.post("/api/calls", {
    phone:S.phone, duration:S.duration, transcript:S.transcript,
    summary:S.analysis?.summary, score:S.analysis?.score,
    errors:S.analysis?.errors||[], positives:S.analysis?.positives||[],
    recommendation:S.analysis?.recommendation, saved:false,
  });
  S.modal=null; S.analysis=null; S.transcript=""; load();
}

async function saveContact() {
  S.modal = "saving"; render();
  const callRes = await window.api.post("/api/calls", {
    phone:S.phone, duration:S.duration, transcript:S.transcript,
    summary:S.analysis?.summary, score:S.analysis?.score,
    errors:S.analysis?.errors||[], positives:S.analysis?.positives||[],
    recommendation:S.analysis?.recommendation, saved:true,
  });
  await window.api.post("/api/contacts", {
    phone:S.phone, company:S.company, name:S.cname,
    summary:S.analysis?.summary, transcript:S.transcript,
    score:S.analysis?.score, errors:S.analysis?.errors||[],
    recommendation:S.analysis?.recommendation, call_id:callRes.id,
  });
  S.modal="done"; render();
  setTimeout(()=>{ S.modal=null; S.analysis=null; S.transcript=""; S.company=""; S.cname=""; load(); }, 1400);
}

// ═══════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════
function render() {
  document.getElementById("app").innerHTML = html();
  bind();
}

function html() {
  return `
<div class="shell">
  ${sidebar()}
  <div class="main">
    ${topbar()}
    <div class="content">
      ${S.page==="phone"     ? pagePhone()    : ""}
      ${S.page==="contacts"  ? pageContacts() : ""}
      ${S.page==="calls"     ? pageCalls()    : ""}
      ${S.page==="managers"  ? pageManagers() : ""}
      ${S.page==="analytics" ? pageAnalytics(): ""}
    </div>
  </div>
</div>
${S.modal ? modalHtml() : ""}`;
}

// ── Sidebar ───────────────────────────────────────────────
function sidebar() {
  const nav = (id,icon,label,badge="") => `
<div class="nav ${S.page===id?"on":""}" data-page="${id}">
  <span class="nicon">${icon}</span>${esc(label)}
  ${badge?`<span class="nbadge">${badge}</span>`:""}
</div>`;
  return `
<div class="sidebar">
  <div class="logo">
    <div class="logo-tag">Sales AI</div>
    <div class="logo-h">Call Analyzer</div>
  </div>
  ${nav("phone","☎","Звонок")}
  ${nav("contacts","◈","Контакты",S.contacts.length||"")}
  ${nav("calls","◷","История",S.calls.length||"")}
  ${nav("managers","◉","Менеджеры")}
  ${nav("analytics","⊕","Аналитика")}
  <div class="sip-section">
    ${S.recording?`<div class="call-active-bar"><span class="rec-dot"></span><span>Идёт разговор</span><span class="call-active-timer" id="sidebar-timer">${fmt(S.seconds)}</span></div>`:""}
    <div class="sip-row">
      <span class="sdot ${S.wsStatus==="connected"?"sdot-on":"sdot-off"}"></span>
      <span class="sip-lbl">${S.wsStatus==="connected"?"Бэкенд подключён":"Нет связи"}</span>
    </div>
  </div>
</div>`;
}

// ── Topbar ────────────────────────────────────────────────
function topbar() {
  const titles = { phone:"Звонок", contacts:"Контакты", calls:"История звонков", managers:"Менеджеры", analytics:"Аналитика" };
  const subs   = { phone:"Запись и анализ разговора", contacts:`${S.contacts.length} клиентов в базе`, calls:`${S.calls.length} звонков`, managers:`${S.managers.length} менеджеров`, analytics:"Анализ текста" };
  const callBadge = S.recording ? `<div class="topbar-call-badge"><span class="rec-dot"></span>Идёт разговор · <span id="topbar-timer">${fmt(S.seconds)}</span></div>` : "";
  return `<div class="topbar"><div><div class="pt">${titles[S.page]}</div><div class="ps">${subs[S.page]}</div></div>${callBadge}</div>`;
}

// ── Phone page ────────────────────────────────────────────
function pagePhone() {
  const mgrs = S.managers.map(m=>`<option value="${m.id}" ${m.id===S.managerId?"selected":""}>${esc(m.name)}</option>`).join("");
  if (S.recording) return `
<div class="rec-screen">
  <div class="rec-badge"><span class="rec-dot"></span>ЗАПИСЬ</div>
  <div class="rec-phone">Входящий звонок</div>
  <div class="rec-timer" id="timer">${fmt(S.seconds)}</div>
  <div class="wave">${Array.from({length:14},(_,i)=>`<div class="wbar" style="animation-delay:${i*0.07}s"></div>`).join("")}</div>
  <button class="btn-stop" id="btn-stop">■ Завершить звонок</button>
  <div class="hint">Аудио стримится на сервер • Groq Whisper распознаёт речь</div>
</div>`;

  return `
<div class="phone-page">
  <div class="standby-card card">
    <div class="standby-icon">☎</div>
    <div class="standby-title">Ожидание звонка</div>
    <div class="standby-sub">Нажмите кнопку когда начнётся разговор с клиентом</div>
    ${S.managers.length>1?`<div style="margin-top:14px"><label>Менеджер</label><select id="mgr-sel">${mgrs}</select></div>`:""}
    <button class="btn-primary btn-full" id="btn-start" style="margin-top:20px">● Принять и записать</button>
  </div>

  <div class="recent card">
    <div class="ctitle">Последние звонки</div>
    ${S.calls.slice(0,8).map(c=>`
    <div class="call-row">
      <div class="call-meta">
        <span class="call-ph">${esc(c.phone||"—")}</span>
        ${c.score!=null?`<span class="score-chip" style="color:${sc(c.score)}">${c.score}/100</span>`:""}
        <span class="ctag ${c.saved?"ctag-saved":"ctag-anl"}">${c.saved?"контакт":"аналитика"}</span>
      </div>
      ${c.summary?`<div class="call-sum">${esc(c.summary.slice(0,90))}${c.summary.length>90?"...":""}</div>`:""}
    </div>`).join("")}
    ${!S.calls.length?`<div class="empty-sm">Звонков пока нет</div>`:""}
  </div>
</div>`;
}

// ── Contacts page ─────────────────────────────────────────
function pageContacts() {
  if (S.selectedContact) {
    const c = S.selectedContact;
    const errHtml = (c.errors||[]).map(e=>`
<div class="err-item">
  <span class="sev sev-${e.severity||"low"}">${e.severity==="high"?"Критично":e.severity==="medium"?"Средне":"Мало"}</span>
  <div><div class="err-t">${esc(e.title)}</div><div class="err-d">${esc(e.description)}</div></div>
</div>`).join("");
    return `
<div style="display:flex;flex-direction:column;gap:14px">
  <button class="btn-ghost btn-sm" id="btn-back">← Назад</button>
  <div class="card">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
      <div class="av" style="background:var(--accent);width:52px;height:52px;font-size:18px">${(c.company||c.phone||"?")[0].toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-size:18px;font-weight:700">${esc(c.company||"Без названия")}</div>
        ${c.name?`<div style="font-size:13px;color:var(--text2)">👤 ${esc(c.name)}</div>`:""}
        <div style="font-size:13px;color:var(--text2);font-family:var(--mono)">${esc(c.phone)}</div>
      </div>
      <button class="btn-red btn-sm" data-del-contact="${c.id}">Удалить</button>
    </div>
    <div class="divider"></div>
    ${c.score!=null?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span style="color:var(--text2);font-size:13px">Оценка:</span><span style="font-size:22px;font-weight:700;font-family:var(--mono);color:${sc(c.score)}">${c.score}/100</span></div>`:""}
    ${c.summary?`<div style="font-size:13px;color:var(--text2);line-height:1.7;margin-bottom:12px">${esc(c.summary)}</div>`:""}
    ${c.recommendation?`<div class="rec-box">💡 ${esc(c.recommendation)}</div>`:""}
    ${errHtml?`<div class="ctitle" style="margin-top:14px">Ошибки в последнем звонке</div><div class="err-list">${errHtml}</div>`:""}
    ${c.transcript?`<div class="ctitle" style="margin-top:14px">Транскрипт</div><div class="transcript-box">${esc(c.transcript)}</div>`:""}
  </div>
</div>`;
  }

  if (!S.contacts.length) return `<div class="empty"><div class="eicon">◈</div>Контактов пока нет<br><small>Они появятся после сохранения звонка</small></div>`;

  return `
<div class="cgrid">
  ${S.contacts.map(c=>`
  <div class="ccard" data-contact="${c.id}">
    <div class="ccard-hd">
      <div class="av" style="background:var(--accent)">${(c.company||c.phone||"?")[0].toUpperCase()}</div>
      <div>
        <div class="cname">${esc(c.company||"Без названия")}</div>
        <div class="cphone">${esc(c.phone)}</div>
      </div>
      ${c.score!=null?`<span class="score-chip" style="color:${sc(c.score)};margin-left:auto">${c.score}/100</span>`:""}
    </div>
    ${c.summary?`<div class="csumm">${esc(c.summary.slice(0,100))}${c.summary.length>100?"...":""}</div>`:""}
    <div class="cdate">${(c.updated_at||"").slice(0,10)}</div>
  </div>`).join("")}
</div>`;
}

// ── Calls page ────────────────────────────────────────────
function pageCalls() {
  if (!S.calls.length) return `<div class="empty"><div class="eicon">◷</div>Звонков пока нет</div>`;
  return `
<div style="display:flex;flex-direction:column;gap:8px">
  ${S.calls.map(c=>`
  <div class="call-item">
    <div class="call-meta">
      <span class="call-ph">${esc(c.phone||"—")}</span>
      <span style="font-size:11px;color:var(--text3);font-family:var(--mono)">${(c.created_at||"").slice(0,16)}</span>
      ${c.duration?`<span style="font-size:11px;color:var(--text3);font-family:var(--mono)">${fmt(c.duration)}</span>`:""}
      ${c.score!=null?`<span class="score-chip" style="color:${sc(c.score)}">${c.score}/100</span>`:""}
      <span class="ctag ${c.saved?"ctag-saved":"ctag-anl"}">${c.saved?"→ контакт":"аналитика"}</span>
    </div>
    ${c.summary?`<div class="call-sum">${esc(c.summary)}</div>`:""}
  </div>`).join("")}
</div>`;
}

// ── Managers page ─────────────────────────────────────────
function pageManagers() {
  return `
<div style="display:flex;flex-direction:column;gap:14px">
  <div class="mgrid">
    ${S.managers.map(m=>{
      const v=m.violations||0, t=S.threshold, pct=Math.min(100,Math.round(v/t*100));
      return `
<div class="mcard">
  <div class="mhd">
    <div class="av" style="background:${m.color}">${esc(m.avatar)}</div>
    <div><div class="mname">${esc(m.name)}</div><div style="font-size:12px;color:var(--text2)">Менеджер</div></div>
  </div>
  <div class="sgrid">
    <div class="sbox"><div class="sval" style="color:#a5b4fc">${m.calls_count||0}</div><div class="slbl">ЗВОНКОВ</div></div>
    <div class="sbox"><div class="sval" style="color:${vc(v,t)}">${v}</div><div class="slbl">НАРУШ.</div></div>
    <div class="sbox"><div class="sval" style="color:#4ade80">${m.avg_score!=null?m.avg_score:"—"}</div><div class="slbl">ОЦЕНКА</div></div>
  </div>
  <div class="vbar-wrap">
    <div class="vbar-hd"><span>Нарушения</span><span style="font-family:var(--mono)">${v}/${t}</span></div>
    <div class="vbar-track"><div class="vbar-fill" style="width:${pct}%;background:${vc(v,t)}"></div></div>
  </div>
  ${v>=t?`<div class="alert-red" style="margin-top:10px;padding:8px 12px;font-size:12px">⚠ Превышен порог</div>`:""}
  <div style="display:flex;gap:6px;margin-top:10px">
    <button class="btn-ghost btn-sm" style="flex:1" data-reset-mgr="${m.id}">Сброс статистики</button>
  </div>
</div>`;
    }).join("")}
  </div>
  <div class="card">
    <div class="ctitle">Добавить менеджера</div>
    <div style="display:flex;gap:8px">
      <input id="new-mgr" type="text" placeholder="Имя Фамилия" style="flex:1"/>
      <button class="btn-ghost" id="btn-add-mgr">Добавить</button>
    </div>
    <div style="margin-top:12px">
      <label>Порог нарушений для алерта</label>
      <input id="threshold-inp" type="number" min="1" max="20" value="${S.threshold}" style="width:80px"/>
    </div>
  </div>
</div>`;
}

// ── Analytics page ────────────────────────────────────────
function pageAnalytics() {
  const res = S.manualRes;
  return `
<div class="two-col">
  <div class="card">
    <div class="ctitle">Транскрипт разговора</div>
    <textarea id="man-txt" style="min-height:200px">${esc(S.manualTxt)}</textarea>
    <button class="btn-primary btn-full ${S.manualBusy?"disabled":""}" id="btn-analyze" ${S.manualBusy?"disabled":""}>
      ${S.manualBusy?`<span class="spinner"></span> Анализирую...`:"→ Анализировать"}
    </button>
  </div>
  <div>
    ${!res&&!S.manualBusy?`<div class="empty"><div class="eicon">⊕</div>Вставьте текст слева</div>`:""}
    ${S.manualBusy?`<div class="card" style="text-align:center;padding:40px"><div class="spinner" style="margin:0 auto 12px"></div>Анализирую...</div>`:""}
    ${res&&!res.error?`
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="score-row">
        <div style="font-size:36px;font-weight:700;font-family:var(--mono);color:${sc(res.score)}">${res.score}</div>
        <div style="margin-left:12px"><div style="font-weight:600;font-size:14px">Оценка звонка</div><div style="font-size:12px;color:var(--text2);margin-top:3px;line-height:1.5">${esc(res.summary)}</div></div>
      </div>
      ${res.errors?.length?`
      <div class="card">
        <div class="ctitle">Ошибки — ${res.errors.length}</div>
        <div class="err-list">${res.errors.map(e=>`
        <div class="err-item">
          <span class="sev sev-${e.severity}">${e.severity==="high"?"Критично":e.severity==="medium"?"Средне":"Мало"}</span>
          <div><div class="err-t">${esc(e.title)}</div><div class="err-d">${esc(e.description)}</div></div>
        </div>`).join("")}</div>
      </div>`:""}
      ${res.positives?.length?`<div class="card"><div class="ctitle">Хорошо</div>${res.positives.map(p=>`<div class="pos-item">+ ${esc(p)}</div>`).join("")}</div>`:""}
      ${res.recommendation?`<div class="card"><div class="ctitle">Рекомендация</div><div class="rec-box">${esc(res.recommendation)}</div></div>`:""}
    </div>`:""}
    ${res?.error?`<div class="alert-red">✕ ${esc(res.error)}</div>`:""}
  </div>
</div>`;
}

// ── Modal ─────────────────────────────────────────────────
function modalHtml() {
  const a = S.analysis;
  let body = "";

  if (S.modal === "wait") {
    body = `
<div class="modal-header">
  <span style="font-size:14px;font-weight:600;color:var(--text2)">Обработка звонка</span>
  <button class="modal-close" id="btn-cancel-wait">✕</button>
</div>
<div style="text-align:center;padding:20px 0 30px"><div class="spinner" style="margin:0 auto 12px"></div><div>Транскрибирую и анализирую...</div></div>`;
  } else if (S.modal === "ask" && a) {
    body = `
<h2>Звонок завершён</h2>
<div class="modal-sub">📞 ${esc(S.phone)} · ⏱ ${fmt(S.duration)}</div>
<div class="score-row" style="margin-bottom:14px">
  <div style="font-size:28px;font-weight:700;font-family:var(--mono);color:${sc(a.score)}">${a.score}/100</div>
  <div style="margin-left:12px;font-size:12px;color:var(--text2);line-height:1.5">${esc(a.summary||"")}</div>
</div>
<div style="font-size:14px;font-weight:600;margin-bottom:14px">Сохранить клиента в базу?</div>
<div class="mrow">
  <button class="btn-red" id="btn-discard">Нет — только аналитика</button>
  <button class="btn-primary" id="btn-to-form">Да — создать карточку</button>
</div>`;
  } else if (S.modal === "form") {
    body = `
<h2>Данные клиента</h2>
<div class="modal-sub">📞 ${esc(S.phone)}</div>
<label>Название компании *</label>
<input id="company-inp" type="text" placeholder="ООО Ромашка" value="${esc(S.company)}"/>
<label>Имя контакта (опционально)</label>
<input id="cname-inp" type="text" placeholder="Иван Петров" value="${esc(S.cname)}"/>
<div class="mrow" style="margin-top:16px">
  <button class="btn-ghost" id="btn-back-ask">← Назад</button>
  <button class="btn-primary" id="btn-save-contact">Сохранить карточку</button>
</div>`;
  } else if (S.modal === "saving") {
    body = `<div style="text-align:center;padding:30px 0"><div class="spinner" style="margin:0 auto 12px"></div><div>Сохраняю...</div></div>`;
  } else if (S.modal === "done") {
    body = `<div style="text-align:center;padding:20px 0;color:#4ade80;font-size:16px;font-weight:700">✓ Карточка сохранена!</div>`;
  }

  return `<div class="overlay"><div class="modal">${body}</div></div>`;
}

// ═══════════════════════════════════════════════════════════
// EVENT BINDING
// ═══════════════════════════════════════════════════════════
function bind() {
  // Navigation
  document.querySelectorAll("[data-page]").forEach(el =>
    el.addEventListener("click", () => { S.page=el.dataset.page; render(); })
  );

  // Phone
  document.getElementById("btn-start")?.addEventListener("click", startCall);
  document.getElementById("btn-stop")?.addEventListener("click", stopCall);
  document.getElementById("mgr-sel")?.addEventListener("change", e => S.managerId=+e.target.value);

  // Contacts
  document.querySelectorAll("[data-contact]").forEach(el =>
    el.addEventListener("click", () => { S.selectedContact=S.contacts.find(c=>c.id===+el.dataset.contact); render(); })
  );
  document.getElementById("btn-back")?.addEventListener("click", () => { S.selectedContact=null; render(); });
  document.querySelectorAll("[data-del-contact]").forEach(el =>
    el.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm("Удалить контакт?")) return;
      await window.api.delete(`/api/contacts/${el.dataset.delContact}`);
      S.selectedContact=null; load();
    })
  );

  // Managers
  document.getElementById("btn-add-mgr")?.addEventListener("click", async () => {
    const name = document.getElementById("new-mgr")?.value.trim();
    if (!name) return;
    await window.api.post("/api/managers", { name });
    document.getElementById("new-mgr").value = "";
    load();
  });
  document.querySelectorAll("[data-reset-mgr]").forEach(el =>
    el.addEventListener("click", async () => {
      await window.api.delete(`/api/managers/${el.dataset.resetMgr}/reset`);
      load();
    })
  );
  document.getElementById("threshold-inp")?.addEventListener("change", e => { S.threshold=+e.target.value; });

  // Analytics
  document.getElementById("man-txt")?.addEventListener("input", e => S.manualTxt=e.target.value);
  document.getElementById("btn-analyze")?.addEventListener("click", async () => {
    if (!S.manualTxt.trim() || S.manualBusy) return;
    S.manualBusy=true; S.manualRes=null; render();
    S.manualRes = await window.api.post("/api/analyze", { managerName:"Менеджер", transcript:S.manualTxt });
    S.manualBusy=false; render();
  });

  // Modal
  document.getElementById("btn-cancel-wait")?.addEventListener("click", () => {
    S.skipNextAnalysis = true; S.modal = null; render();
  });
  document.getElementById("btn-discard")?.addEventListener("click", discardCall);
  document.getElementById("btn-to-form")?.addEventListener("click", () => { S.modal="form"; render(); });
  document.getElementById("btn-back-ask")?.addEventListener("click", () => { S.modal="ask"; render(); });
  document.getElementById("company-inp")?.addEventListener("input", e => S.company=e.target.value);
  document.getElementById("cname-inp")?.addEventListener("input", e => S.cname=e.target.value);
  document.getElementById("btn-save-contact")?.addEventListener("click", () => {
    S.company = document.getElementById("company-inp")?.value||"";
    S.cname   = document.getElementById("cname-inp")?.value||"";
    if (!S.company.trim()) { alert("Введите название компании"); return; }
    saveContact();
  });
}

// ═══════════════════════════════════════════════════════════
// BACKEND EVENTS
// ═══════════════════════════════════════════════════════════
window.api.on("ws-status", status => { S.wsStatus=status; render(); });
window.api.on("processing", () => { S.modal="wait"; render(); });
window.api.on("call-analyzed", msg => {
  if (S.skipNextAnalysis) { S.skipNextAnalysis = false; return; }
  S.analysis   = msg.analysis;
  S.transcript = msg.transcript||"";
  S.duration   = msg.duration||S.seconds;
  S.modal      = "ask";
  render();
});
window.api.on("stream-error", err => { S.modal=null; alert("Ошибка: "+err); render(); });
window.api.on("data-updated", () => load());

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
.sidebar{width:220px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:20px 0;overflow-y:auto;position:relative;z-index:10}
.logo{padding:0 20px 18px;border-bottom:1px solid var(--border);margin-bottom:12px;cursor:default}
.logo-tag{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:2px;text-transform:uppercase}
.logo-h{font-size:16px;font-weight:700;margin-top:2px;letter-spacing:-.3px}
.nav{display:flex;align-items:center;gap:10px;padding:9px 20px;cursor:pointer;color:var(--text2);font-size:13px;font-weight:500;border-left:2px solid transparent;transition:all .15s;user-select:none}
.nav:hover{color:var(--text);background:rgba(255,255,255,.06)}
.nav.on{color:var(--accent2);border-left-color:var(--accent);background:rgba(255,255,255,.14);font-weight:600}
.nicon{width:18px;text-align:center}
.nbadge{margin-left:auto;font-size:10px;font-weight:600;border-radius:10px;padding:1px 7px;font-family:var(--mono);background:rgba(255,255,255,.2);color:var(--accent2)}
.sip-section{margin-top:auto;padding:14px 20px;border-top:1px solid var(--border)}
.sip-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2)}
.sdot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.sdot-on{background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.6)}
.sdot-off{background:var(--text3)}

/* Main */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.pt{font-size:16px;font-weight:700;letter-spacing:-.3px}
.ps{font-size:12px;color:var(--text2);margin-top:1px}
.content{flex:1;overflow-y:auto;padding:24px 28px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:20px}
.ctitle{font-size:10px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--text3);margin-bottom:14px}
.divider{height:.5px;background:var(--border);margin:14px 0}

/* Form */
label{font-size:12px;color:var(--text2);display:block;margin-bottom:5px;margin-top:12px}
label:first-of-type{margin-top:0}
input,select,textarea{width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--r);color:var(--text);font-family:var(--sans);font-size:13px;padding:9px 12px;outline:none;transition:border .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,255,255,.15)}
textarea{resize:vertical;font-family:var(--mono);font-size:12px;line-height:1.6}

/* Buttons */
.btn-primary{background:var(--accent);color:#0a0a0f;border:none;border-radius:var(--r);padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn-primary:hover{background:var(--accent2)}
.btn-full{width:100%;margin-top:14px}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:var(--r);padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent2)}
.btn-red{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.2);border-radius:var(--r);padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer}
.btn-red:hover{background:rgba(239,68,68,.22)}
.btn-sm{font-size:11px;padding:5px 12px;margin-top:0}

/* Phone */
.phone-page{display:grid;grid-template-columns:320px 1fr;gap:18px}
.standby-card{text-align:center;padding:36px 24px}
.standby-icon{font-size:44px;margin-bottom:14px;opacity:.5}
.standby-title{font-size:18px;font-weight:700;margin-bottom:8px}
.standby-sub{font-size:13px;color:var(--text2);line-height:1.6}
.call-active-bar{display:flex;align-items:center;gap:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:var(--r);padding:6px 10px;margin-bottom:8px;font-size:11px;color:#f87171;font-weight:600}
.call-active-timer{margin-left:auto;font-family:var(--mono)}
.topbar-call-badge{display:flex;align-items:center;gap:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:var(--r);padding:5px 14px;font-size:12px;font-weight:600;color:#f87171;font-family:var(--mono)}
.btn-stop{width:100%;padding:14px;background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.25);border-radius:var(--rl);font-size:14px;font-weight:600;cursor:pointer;margin-bottom:12px}
.btn-stop:hover{background:rgba(239,68,68,.22)}
.hint{text-align:center;font-size:11px;color:var(--text3)}
.rec-screen{max-width:340px;margin:0 auto;text-align:center;padding:20px 0}
.rec-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#f87171;padding:6px 16px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:2px;margin-bottom:20px}
.rec-dot{width:8px;height:8px;border-radius:50%;background:#ef4444;animation:blink .8s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.rec-phone{font-size:22px;font-weight:700;font-family:var(--mono);margin-bottom:8px}
.rec-timer{font-size:44px;font-weight:700;font-family:var(--mono);color:var(--accent2);margin-bottom:24px}
.wave{display:flex;justify-content:center;gap:4px;height:44px;align-items:center;margin-bottom:28px}
.wbar{width:4px;background:var(--accent);border-radius:2px;animation:wave 1s ease-in-out infinite}
@keyframes wave{0%,100%{height:6px;opacity:.4}50%{height:34px;opacity:1}}

/* Contacts */
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
.ccard{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:18px;cursor:pointer;transition:border .15s}
.ccard:hover{border-color:var(--border2)}
.ccard-hd{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.av{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0a0a0f;flex-shrink:0}
.cname{font-size:14px;font-weight:600}
.cphone{font-size:12px;color:var(--text2);font-family:var(--mono)}
.csumm{font-size:12px;color:var(--text2);line-height:1.6;margin-top:4px}
.cdate{font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:6px}
.transcript-box{font-size:12px;font-family:var(--mono);color:var(--text2);line-height:1.7;max-height:180px;overflow-y:auto;background:var(--surface2);padding:10px 14px;border-radius:var(--r)}

/* Calls */
.call-item{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px 16px;margin-bottom:0}
.call-row{padding:8px 0;border-bottom:.5px solid var(--border)}
.call-row:last-child{border-bottom:none}
.call-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px}
.call-ph{font-family:var(--mono);font-size:13px;font-weight:500}
.call-sum{font-size:12px;color:var(--text2);line-height:1.5}
.score-chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;font-family:var(--mono)}
.ctag{font-size:11px;padding:2px 8px;border-radius:20px;font-family:var(--mono)}
.ctag-saved{background:rgba(255,255,255,.15);color:var(--accent2)}
.ctag-anl{background:var(--surface2);color:var(--text3)}
.empty-sm{font-size:12px;color:var(--text3);padding:12px 0}

/* Managers */
.mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.mcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:18px}
.mhd{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.mname{font-size:15px;font-weight:700}
.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.sbox{background:var(--surface2);border-radius:var(--r);padding:8px;text-align:center}
.sval{font-size:18px;font-weight:700;font-family:var(--mono)}
.slbl{font-size:10px;color:var(--text3);margin-top:1px;letter-spacing:.5px}
.vbar-wrap{margin-top:12px}
.vbar-hd{display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-bottom:5px}
.vbar-track{height:5px;background:var(--surface2);border-radius:3px;overflow:hidden}
.vbar-fill{height:100%;border-radius:3px;transition:width .5s}

/* Analytics */
.score-row{display:flex;align-items:center;padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--rl)}
.err-list{display:flex;flex-direction:column;gap:8px}
.err-item{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;background:var(--surface2);border-radius:var(--r);border:1px solid var(--border)}
.sev{font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;white-space:nowrap;flex-shrink:0;margin-top:2px;font-family:var(--mono)}
.sev-high{background:#fee2e2;color:#991b1b}
.sev-medium{background:#fef3c7;color:#92400e}
.sev-low{background:#dcfce7;color:#166534}
.err-t{font-size:12px;font-weight:500}
.err-d{font-size:11px;color:var(--text2);margin-top:2px}
.pos-item{font-size:12px;color:#4ade80;padding:5px 10px;background:rgba(34,197,94,.06);border-radius:var(--r);border-left:2px solid #22c55e;margin-bottom:4px}
.rec-box{padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:var(--r);font-size:13px;color:var(--accent2);line-height:1.6}

/* Alerts */
.alert-red{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#fca5a5;padding:10px 14px;border-radius:var(--r);font-size:13px}

/* Modal */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(4px)}
.modal{background:var(--surface);border:1px solid var(--border2);border-radius:var(--rl);padding:28px;width:500px;max-width:90vw;max-height:88vh;overflow-y:auto}
.modal h2{font-size:18px;font-weight:700;margin-bottom:4px}
.modal-sub{font-size:12px;color:var(--text2);margin-bottom:16px}
.mrow{display:flex;gap:10px}
.mrow .btn-red,.mrow .btn-primary{flex:1;margin-top:0}

/* Modal header / close */
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.modal-close{background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:2px 8px;border-radius:6px;line-height:1;transition:all .15s}
.modal-close:hover{color:var(--text);background:rgba(255,255,255,.08)}

/* Spinner */
.spinner{width:18px;height:18px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
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
load();
