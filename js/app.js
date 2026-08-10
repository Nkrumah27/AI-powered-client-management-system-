/* ============================= DATA MODEL ============================= */
const SERVICE_TEMPLATES = {
  social: {
    label: 'Social Media Marketing',
    metrics: [
      {key:'followers', name:'New followers', unit:''},
      {key:'likes', name:'Likes', unit:''},
      {key:'comments', name:'Comments', unit:''},
      {key:'shares', name:'Shares', unit:''},
      {key:'posts', name:'Posts published', unit:''},
      {key:'reach', name:'Reach', unit:''},
      {key:'engagement', name:'Engagement rate', unit:'%'},
      {key:'dms', name:'DM inquiries', unit:''},
    ]
  },
  digital: {
    label: 'Digital Marketing',
    metrics: [
      {key:'visits', name:'Website visits', unit:''},
      {key:'leads', name:'Leads generated', unit:''},
      {key:'conversion', name:'Conversion rate', unit:'%'},
      {key:'adspend', name:'Ad spend', unit:'$'},
      {key:'ctr', name:'Click-through rate', unit:'%'},
      {key:'roi', name:'ROI', unit:'%'},
    ]
  },
  software: {
    label: 'Software Engineering',
    metrics: [
      {key:'tasks', name:'Tasks completed', unit:''},
      {key:'bugs', name:'Bugs fixed', unit:''},
      {key:'hours', name:'Hours logged', unit:'h'},
      {key:'sprint', name:'Sprint progress', unit:'%'},
      {key:'deploys', name:'Deployments', unit:''},
      {key:'reviews', name:'Code reviews', unit:''},
    ]
  }
};

let STATE = { clients: [], view: 'dashboard', filter: 'all', activeClientId: null, loaded: false };

/* ============================= STORAGE ============================= */
/* Uses the browser's localStorage — data lives on this device, in this
   browser, and persists across page reloads and restarts. */
const STORAGE_KEY = 'signal-clients';
async function loadClients(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    STATE.clients = raw ? JSON.parse(raw) : [];
  }catch(e){ STATE.clients = []; }
  STATE.loaded = true;
}
async function saveClients(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE.clients));
  }catch(e){ showToast('Could not save — changes may not persist.'); }
}

/* ============================= SCORING ============================= */
function daysBetween(a,b){ return Math.round((new Date(b) - new Date(a)) / 86400000); }
function todayStr(){ return new Date().toISOString().slice(0,10); }

function activeMetrics(client){
  let list = [];
  client.services.forEach(sKey=>{
    (client.metricsConfig[sKey]||[]).forEach(m=>list.push({...m, service:sKey}));
  });
  return list;
}

function computeStatus(client){
  const entries = Object.entries(client.entries||{}).sort((a,b)=>a[0]<b[0]?1:-1); // newest first
  if(entries.length===0){
    return {status: client.isNew ? 'yellow' : 'red', reason: client.isNew ? 'No data logged yet' : 'No data has been logged'};
  }
  const lastDate = entries[0][0];
  const staleDays = daysBetween(lastDate, todayStr());
  if(staleDays > 7){
    return {status:'red', reason:`No updates in ${staleDays} days`};
  }
  const metrics = activeMetrics(client);
  const withTarget = metrics.filter(m=>client.targets && client.targets[m.key]);
  const recent = entries.slice(0,7);
  const prior = entries.slice(7,14);

  function avgFor(rows, key){
    const vals = rows.map(([,v])=>v[key]).filter(v=>v!==undefined && v!=='' && !isNaN(v)).map(Number);
    if(!vals.length) return null;
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  }

  let ratios = [];
  if(withTarget.length){
    withTarget.forEach(m=>{
      const avg = avgFor(recent, m.key);
      const target = Number(client.targets[m.key]);
      if(avg!==null && target){ ratios.push(Math.min(avg/target, 1.4)); }
    });
  }else{
    metrics.forEach(m=>{
      const r = avgFor(recent, m.key), p = avgFor(prior, m.key);
      if(r!==null && p!==null && p>0){ ratios.push(Math.min(r/p,1.4)); }
    });
  }
  if(!ratios.length){
    return {status:'yellow', reason:'Not enough history yet to score trend'};
  }
  const score = ratios.reduce((a,b)=>a+b,0)/ratios.length;
  if(score>=0.9) return {status:'green', reason:`Tracking at ${Math.round(score*100)}% of goal/trend`};
  if(score>=0.6) return {status:'yellow', reason:`Tracking at ${Math.round(score*100)}% of goal/trend`};
  return {status:'red', reason:`Tracking at only ${Math.round(score*100)}% of goal/trend`};
}

function effectiveStatus(client){
  if(client.manualStatus) return {status:client.manualStatus, reason:'Manually set'};
  return computeStatus(client);
}

/* ============================= AI ============================= */
async function callClaude(promptText){
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{role:"user", content: promptText}]
    })
  });
  const data = await response.json();
  const text = (data.content||[]).map(b=>b.text||'').join('\n');
  return text;
}

function tryParseJSON(text){
  const clean = text.replace(/```json|```/g,'').trim();
  try{ return JSON.parse(clean); }catch(e){ return null; }
}

async function generateAIReport(client, period){
  const days = period==='weekly'?7:30;
  const entries = Object.entries(client.entries||{}).sort((a,b)=>a[0]<b[0]?1:-1).slice(0,days);
  const metrics = activeMetrics(client);
  const prompt = `You are analyzing performance data for a freelancer's client relationship.
Client: ${client.name}
Services provided: ${client.services.map(s=>SERVICE_TEMPLATES[s].label).join(', ')}
Working together since: ${client.startDate}
Targets/goals set (if any): ${JSON.stringify(client.targets||{})}
Metric definitions: ${JSON.stringify(metrics.map(m=>({key:m.key,name:m.name,unit:m.unit})))}
Daily entries for the last ${days} days (most recent first, date: {metricKey: value}): ${JSON.stringify(entries)}
Freelancer's own notes about this client: ${client.notes || 'none'}

Write a ${period} performance report. Respond ONLY with raw JSON, no markdown fences, no preamble, matching exactly this shape:
{"summary": "2-3 sentence plain-language summary of how things went", "highlights": ["short bullet", "short bullet"], "concerns": ["short bullet"], "recommendations": ["short actionable bullet", "short actionable bullet"], "suggestedStatus": "green|yellow|red", "reasoning": "1 sentence on why that status"}`;
  const raw = await callClaude(prompt);
  const parsed = tryParseJSON(raw);
  return parsed || {summary: raw, highlights:[], concerns:[], recommendations:[], suggestedStatus:'yellow', reasoning:''};
}

/* ============================= RENDER HELPERS ============================= */
function el(html){ const t=document.createElement('template'); t.innerHTML=html.trim(); return t.content.firstChild; }
function showToast(msg){
  const t = el(`<div class="toast">${msg}</div>`);
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 3200);
}
function fmtDate(d){ if(!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}); }

/* ============================= APP RENDER ============================= */
const app = document.getElementById('app');

function showFatalError(err){
  console.error(err);
  const msg = (err && err.message) ? err.message : String(err);
  const stack = (err && err.stack) ? err.stack : '';
  app.innerHTML = `<div style="padding:40px;max-width:820px;font-family:monospace;color:#E9EDF3;">
    <h2 style="color:#FF5C6C;margin-top:0;">Signal hit an error while loading</h2>
    <div style="background:#1E2632;border:1px solid #FF5C6C;border-radius:8px;padding:14px;white-space:pre-wrap;">${msg}</div>
    <div style="margin-top:14px;opacity:.6;white-space:pre-wrap;font-size:12px;">${stack}</div>
    <div style="margin-top:16px;color:#93A1B3;font-family:sans-serif;font-size:13px;">Copy this message and send it back for a fix.</div>
  </div>`;
}
window.addEventListener('error', (e)=> showFatalError(e.error || e.message));
window.addEventListener('unhandledrejection', (e)=> showFatalError(e.reason));

function render(){
 try {
  const counts = {all:STATE.clients.length, green:0, yellow:0, red:0};
  STATE.clients.forEach(c=>{ counts[effectiveStatus(c).status]++; });
  const redClients = STATE.clients.filter(c=>effectiveStatus(c).status==='red');

  app.innerHTML = '';
  app.appendChild(el(`
    <div class="sidebar">
      <div class="brand">
        <div class="brand-mark"></div>
        <div>
          <div class="brand-text">Signal</div>
          <div class="brand-sub">Client Ops</div>
        </div>
      </div>
      <nav>
        <button class="nav-item ${STATE.view==='dashboard'?'active':''}" data-nav="dashboard">Overview <span class="nav-count">${counts.all}</span></button>
        <button class="nav-item ${STATE.view==='reports'?'active':''}" data-nav="reports">Reports</button>
      </nav>
      <div class="sidebar-foot">Data is stored privately for you only, in this app's memory.</div>
    </div>
  `));
  const main = el(`<main id="main"></main>`);
  app.appendChild(main);
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{ STATE.view=b.dataset.nav; STATE.activeClientId=null; render(); });

  if(STATE.view==='dashboard' && !STATE.activeClientId){
    renderDashboard(main, counts, redClients);
  } else if(STATE.view==='dashboard' && STATE.activeClientId){
    renderClientDetail(main);
  } else if(STATE.view==='reports'){
    renderReportsView(main);
  }
 } catch(err) {
   showFatalError(err);
 }
}

function renderDashboard(main, counts, redClients){
  main.appendChild(el(`
    <div class="topbar">
      <div>
        <div class="page-title">Overview</div>
        <div class="page-sub">${counts.all} client${counts.all===1?'':'s'} · ${counts.green} green · ${counts.yellow} yellow · ${counts.red} red</div>
      </div>
      <button class="btn btn-primary" id="addClientBtn">+ Add client</button>
    </div>
  `));

  if(redClients.length){
    main.appendChild(el(`
      <div class="alert-strip">
        <span class="alert-dot"></span>
        <span>${redClients.length} client${redClients.length===1?' needs':'s need'} attention: ${redClients.map(c=>c.name).join(', ')}</span>
      </div>
    `));
  }

  main.appendChild(el(`
    <div class="tabs">
      <button class="tab ${STATE.filter==='all'?'active':''}" data-filter="all">All</button>
      <button class="tab ${STATE.filter==='green'?'active':''}" data-filter="green"><span class="tab-swatch" style="background:var(--green)"></span>Green</button>
      <button class="tab ${STATE.filter==='yellow'?'active':''}" data-filter="yellow"><span class="tab-swatch" style="background:var(--yellow)"></span>Yellow</button>
      <button class="tab ${STATE.filter==='red'?'active':''}" data-filter="red"><span class="tab-swatch" style="background:var(--red)"></span>Red</button>
    </div>
  `));

  const filtered = STATE.clients.filter(c=> STATE.filter==='all' || effectiveStatus(c).status===STATE.filter);
  const grid = el(`<div class="grid"></div>`);
  if(!filtered.length){
    grid.appendChild(el(`
      <div class="empty-state" style="grid-column:1/-1">
        ${STATE.clients.length? 'No clients match this filter.' : 'No clients yet. Add your first client to start tracking performance.'}
        ${STATE.clients.length? '' : '<div><button class="btn btn-primary" id="emptyAddBtn">+ Add client</button></div>'}
      </div>
    `));
  } else {
    filtered.forEach(c=> grid.appendChild(renderClientCard(c)));
  }
  main.appendChild(grid);

  document.getElementById('addClientBtn').onclick = openAddClientModal;
  const emptyBtn = document.getElementById('emptyAddBtn');
  if(emptyBtn) emptyBtn.onclick = openAddClientModal;
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{ STATE.filter=b.dataset.filter; render(); });
}

function renderClientCard(client){
  const {status, reason} = effectiveStatus(client);
  const entries = Object.entries(client.entries||{});
  const lastEntry = entries.sort((a,b)=>a[0]<b[0]?1:-1)[0];
  const card = el(`
    <div class="card">
      <div class="card-top">
        <div class="card-name-row">
          <div class="beacon ${status}"></div>
          <div>
            <div class="card-name">${client.name}</div>
            <div class="card-meta">Since ${fmtDate(client.startDate)}</div>
          </div>
        </div>
        <div class="status-label ${status}">${status}</div>
      </div>
      <div class="svc-tags">${client.services.map(s=>`<span class="svc-tag">${SERVICE_TEMPLATES[s].label}</span>`).join('')}</div>
      <div class="card-stat-row">
        <span>${reason}</span>
        <span>${lastEntry? fmtDate(lastEntry[0]) : 'no data'}</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-sm log-btn">Log today</button>
        <button class="btn btn-sm view-btn">Open</button>
        <button class="btn btn-sm btn-danger remove-btn">Remove</button>
      </div>
    </div>
  `);
  card.querySelector('.view-btn').onclick = ()=>{ STATE.activeClientId=client.id; render(); };
  card.querySelector('.log-btn').onclick = ()=>{ STATE.activeClientId=client.id; render(); setTimeout(()=>document.getElementById('entryDate')?.focus(),0); };
  card.querySelector('.remove-btn').onclick = ()=> confirmRemove(client);
  return card;
}

function confirmRemove(client){
  const veil = el(`
    <div class="modal-veil">
      <div class="modal" style="max-width:400px">
        <div class="modal-title" style="margin-bottom:10px">Remove ${client.name}?</div>
        <div class="hint" style="margin-bottom:18px">This deletes all logged data and reports for this client. This can't be undone.</div>
        <div class="modal-foot">
          <button class="btn" id="cancelRemove">Cancel</button>
          <button class="btn btn-danger" id="confirmRemove">Remove client</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(veil);
  veil.onclick=(e)=>{ if(e.target===veil) veil.remove(); };
  veil.querySelector('#cancelRemove').onclick=()=>veil.remove();
  veil.querySelector('#confirmRemove').onclick=async ()=>{
    STATE.clients = STATE.clients.filter(c=>c.id!==client.id);
    await saveClients();
    veil.remove();
    if(STATE.activeClientId===client.id) STATE.activeClientId=null;
    render();
    showToast(`${client.name} removed.`);
  };
}

/* ============================= ADD CLIENT MODAL ============================= */
function openAddClientModal(){
  const formState = { name:'', email:'', isExisting:false, startDate: todayStr(), notes:'', services:[] };
  const veil = el(`
    <div class="modal-veil">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title">Add client</div>
          <button class="modal-close">&times;</button>
        </div>
        <div class="field">
          <label>Client name</label>
          <input type="text" id="f-name" placeholder="e.g. Kofi's Bakery">
        </div>
        <div class="field">
          <label>Contact (optional)</label>
          <input type="text" id="f-email" placeholder="email or phone">
        </div>
        <div class="field">
          <label>Is this a new client, or one you already work with?</label>
          <div class="radio-group">
            <button type="button" class="pill-choice selected" data-existing="false">New client</button>
            <button type="button" class="pill-choice" data-existing="true">Already working with them</button>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label id="dateLabel">Start date</label>
            <input type="date" id="f-start" value="${todayStr()}">
          </div>
        </div>
        <div class="field" id="existingNotesField" style="display:none">
          <label>Where things stand with them so far</label>
          <textarea id="f-notes" placeholder="e.g. Been running their Instagram since March, engagement has been steady, they were unhappy with slow reply times last month..."></textarea>
        </div>
        <div class="field">
          <label>What are you doing for this client?</label>
          <div class="check-group" id="serviceChoices">
            ${Object.entries(SERVICE_TEMPLATES).map(([k,v])=>`<button type="button" class="pill-choice" data-service="${k}">${v.label}</button>`).join('')}
          </div>
        </div>
        <div id="metricBlocks"></div>
        <div class="modal-foot">
          <button class="btn" id="cancelAdd">Cancel</button>
          <button class="btn btn-primary" id="saveClient">Add client</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(veil);
  veil.onclick=(e)=>{ if(e.target===veil) veil.remove(); };
  veil.querySelector('.modal-close').onclick=()=>veil.remove();
  veil.querySelector('#cancelAdd').onclick=()=>veil.remove();

  veil.querySelectorAll('[data-existing]').forEach(btn=>{
    btn.onclick=()=>{
      veil.querySelectorAll('[data-existing]').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected');
      formState.isExisting = btn.dataset.existing==='true';
      veil.querySelector('#existingNotesField').style.display = formState.isExisting ? 'block':'none';
      veil.querySelector('#dateLabel').textContent = formState.isExisting ? 'Working together since' : 'Start date';
    };
  });

  veil.querySelectorAll('[data-service]').forEach(btn=>{
    btn.onclick=()=>{
      const key = btn.dataset.service;
      btn.classList.toggle('selected');
      if(formState.services.includes(key)) formState.services = formState.services.filter(s=>s!==key);
      else formState.services.push(key);
      renderMetricBlocks();
    };
  });

  function renderMetricBlocks(){
    const container = veil.querySelector('#metricBlocks');
    container.innerHTML = '';
    formState.services.forEach(sKey=>{
      const tpl = SERVICE_TEMPLATES[sKey];
      const block = el(`<div class="service-block"><h4>${tpl.label} — metrics to track daily</h4></div>`);
      tpl.metrics.forEach(m=>{
        const row = el(`
          <div class="metric-row">
            <input type="checkbox" checked data-mkey="${sKey}:${m.key}">
            <span class="m-name">${m.name}${m.unit?` (${m.unit})`:''}</span>
            <input type="number" placeholder="target" data-target="${m.key}">
          </div>
        `);
        block.appendChild(row);
      });
      container.appendChild(block);
    });
  }

  veil.querySelector('#saveClient').onclick = async ()=>{
    const name = veil.querySelector('#f-name').value.trim();
    if(!name){ showToast('Client name is required.'); return; }
    if(!formState.services.length){ showToast('Select at least one service.'); return; }
    const email = veil.querySelector('#f-email').value.trim();
    const start = veil.querySelector('#f-start').value || todayStr();
    const notes = formState.isExisting ? (veil.querySelector('#f-notes').value.trim()) : '';

    const metricsConfig = {};
    const targets = {};
    formState.services.forEach(sKey=>{
      const tpl = SERVICE_TEMPLATES[sKey];
      metricsConfig[sKey] = tpl.metrics.filter(m=>{
        const cb = veil.querySelector(`[data-mkey="${sKey}:${m.key}"]`);
        return cb && cb.checked;
      });
      metricsConfig[sKey].forEach(m=>{
        const t = veil.querySelector(`[data-target="${m.key}"]`);
        if(t && t.value) targets[m.key] = Number(t.value);
      });
    });

    const client = {
      id: 'c_' + Date.now() + Math.random().toString(36).slice(2,7),
      name, email, isNew: !formState.isExisting, startDate: start, notes,
      services: formState.services, metricsConfig, targets,
      entries: {}, manualStatus: null, aiReports: []
    };
    STATE.clients.push(client);
    await saveClients();
    veil.remove();
    STATE.activeClientId = client.id;
    render();
    showToast(`${name} added.`);
  };

  renderMetricBlocks();
}

/* ============================= CLIENT DETAIL ============================= */
function renderClientDetail(main){
  const client = STATE.clients.find(c=>c.id===STATE.activeClientId);
  if(!client){ STATE.activeClientId=null; render(); return; }
  const {status, reason} = effectiveStatus(client);
  const metrics = activeMetrics(client);
  const entries = Object.entries(client.entries||{}).sort((a,b)=>a[0]<b[0]?1:-1);

  main.appendChild(el(`<button class="back-link">&larr; All clients</button>`));
  main.querySelector('.back-link').onclick = ()=>{ STATE.activeClientId=null; render(); };

  main.appendChild(el(`
    <div class="detail-head">
      <div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="beacon ${status}" style="width:12px;height:12px"></div>
          <div class="page-title">${client.name}</div>
        </div>
        <div class="page-sub">${client.services.map(s=>SERVICE_TEMPLATES[s].label).join(' · ')} · working together since ${fmtDate(client.startDate)}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="manualStatusSel" class="btn btn-sm">
          <option value="" ${!client.manualStatus?'selected':''}>Auto: ${status}</option>
          <option value="green" ${client.manualStatus==='green'?'selected':''}>Force green</option>
          <option value="yellow" ${client.manualStatus==='yellow'?'selected':''}>Force yellow</option>
          <option value="red" ${client.manualStatus==='red'?'selected':''}>Force red</option>
        </select>
      </div>
    </div>
  `));
  main.querySelector('#manualStatusSel').onchange = async (e)=>{
    client.manualStatus = e.target.value || null;
    await saveClients(); render();
  };

  const sections = el(`<div class="detail-sections"></div>`);

  // Left: entry form + history
  const left = el(`<div style="display:flex;flex-direction:column;gap:16px;"></div>`);
  const entryPanel = el(`
    <div class="panel">
      <h3>Log today's numbers</h3>
      <div class="field"><label>Date</label><input type="date" id="entryDate" value="${todayStr()}"></div>
      <div id="entryFields"></div>
      <button class="btn btn-primary btn-sm" id="saveEntryBtn" style="margin-top:8px;">Save entry</button>
    </div>
  `);
  const entryFields = entryPanel.querySelector('#entryFields');
  metrics.forEach(m=>{
    entryFields.appendChild(el(`
      <div class="field" style="margin-bottom:9px;">
        <label>${m.name}${m.unit?` (${m.unit})`:''}</label>
        <input type="number" step="any" data-entry-key="${m.key}">
      </div>
    `));
  });
  entryPanel.querySelector('#saveEntryBtn').onclick = async ()=>{
    const date = entryPanel.querySelector('#entryDate').value || todayStr();
    const row = {};
    metrics.forEach(m=>{
      const v = entryPanel.querySelector(`[data-entry-key="${m.key}"]`).value;
      if(v!=='') row[m.key] = Number(v);
    });
    client.entries[date] = {...(client.entries[date]||{}), ...row};
    await saveClients();
    showToast('Entry saved.');
    render();
  };
  left.appendChild(entryPanel);

  const historyPanel = el(`
    <div class="panel">
      <h3>Recent history</h3>
      ${entries.length ? `<table class="entry-table"><thead><tr><th>Date</th>${metrics.slice(0,4).map(m=>`<th>${m.name}</th>`).join('')}</tr></thead>
        <tbody>${entries.slice(0,10).map(([date,vals])=>`<tr><td>${fmtDate(date)}</td>${metrics.slice(0,4).map(m=>`<td>${vals[m.key]!==undefined?vals[m.key]:'—'}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : `<div class="hint">No entries logged yet.</div>`}
    </div>
  `);
  left.appendChild(historyPanel);

  if(client.notes){
    left.appendChild(el(`<div class="panel"><h3>Background notes</h3><div class="notes-box">${client.notes}</div></div>`));
  }

  // Right: AI report
  const right = el(`
    <div class="panel">
      <h3>AI performance report</h3>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button class="btn btn-sm" id="genWeekly">Generate weekly report</button>
        <button class="btn btn-sm" id="genMonthly">Generate monthly report</button>
      </div>
      <div id="reportArea"></div>
      <div id="pastReports"></div>
    </div>
  `);
  const reportArea = right.querySelector('#reportArea');
  const pastReports = right.querySelector('#pastReports');

  function renderPastReports(){
    pastReports.innerHTML='';
    if(client.aiReports && client.aiReports.length){
      const h = el(`<h3 style="margin-top:16px;font-size:12.5px;color:var(--text-dim);">Past reports</h3>`);
      pastReports.appendChild(h);
      client.aiReports.slice().reverse().slice(0,5).forEach(r=>{
        pastReports.appendChild(el(`
          <div class="ai-report">
            <span class="report-tag ${r.suggestedStatus}">${r.suggestedStatus}</span> · ${r.period} · ${fmtDate(r.date)}
            <div style="margin-top:6px;">${r.summary}</div>
          </div>
        `));
      });
    }
  }
  renderPastReports();

  async function runReport(period){
    if(entries.length===0){ showToast('Log at least one entry before generating a report.'); return; }
    reportArea.innerHTML = `<div class="loading-line"><span class="spinner"></span> Analyzing ${client.name}'s ${period} performance...</div>`;
    try{
      const result = await generateAIReport(client, period);
      client.aiReports.push({date: todayStr(), period, ...result});
      await saveClients();
      reportArea.innerHTML = '';
      reportArea.appendChild(el(`
        <div class="ai-report">
          <span class="report-tag ${result.suggestedStatus||'yellow'}">${result.suggestedStatus||'unclear'}</span>
          <div style="margin-bottom:8px;">${result.summary||''}</div>
          ${result.highlights&&result.highlights.length?`<div><b style="font-size:11.5px;color:var(--green)">Highlights</b><ul style="margin:4px 0 8px;padding-left:18px;">${result.highlights.map(h=>`<li>${h}</li>`).join('')}</ul></div>`:''}
          ${result.concerns&&result.concerns.length?`<div><b style="font-size:11.5px;color:var(--red)">Concerns</b><ul style="margin:4px 0 8px;padding-left:18px;">${result.concerns.map(h=>`<li>${h}</li>`).join('')}</ul></div>`:''}
          ${result.recommendations&&result.recommendations.length?`<div><b style="font-size:11.5px;color:var(--accent-strong)">Recommendations</b><ul style="margin:4px 0 0;padding-left:18px;">${result.recommendations.map(h=>`<li>${h}</li>`).join('')}</ul></div>`:''}
        </div>
      `));
      renderPastReports();
    }catch(e){
      reportArea.innerHTML = `<div class="hint">Couldn't generate the report right now. Try again in a moment.</div>`;
    }
  }
  right.querySelector('#genWeekly').onclick = ()=>runReport('weekly');
  right.querySelector('#genMonthly').onclick = ()=>runReport('monthly');

  sections.appendChild(left);
  sections.appendChild(right);
  main.appendChild(sections);
}

/* ============================= REPORTS VIEW ============================= */
function renderReportsView(main){
  main.appendChild(el(`
    <div class="topbar">
      <div>
        <div class="page-title">Reports</div>
        <div class="page-sub">All AI-generated reports across your clients</div>
      </div>
    </div>
  `));
  const all = [];
  STATE.clients.forEach(c=> (c.aiReports||[]).forEach(r=> all.push({...r, clientName:c.name, clientId:c.id})));
  all.sort((a,b)=> a.date<b.date?1:-1);

  if(!all.length){
    main.appendChild(el(`<div class="empty-state">No reports yet. Open a client and generate a weekly or monthly report.</div>`));
    return;
  }
  const wrap = el(`<div style="display:flex;flex-direction:column;gap:10px;"></div>`);
  all.forEach(r=>{
    const card = el(`
      <div class="panel" style="cursor:pointer;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <span class="report-tag ${r.suggestedStatus}">${r.suggestedStatus}</span>
            <b style="margin-left:6px;">${r.clientName}</b>
            <span class="hint" style="margin-left:8px;">${r.period} · ${fmtDate(r.date)}</span>
          </div>
        </div>
        <div style="margin-top:8px;font-size:13px;color:var(--text-dim);">${r.summary}</div>
      </div>
    `);
    card.onclick = ()=>{ STATE.view='dashboard'; STATE.activeClientId=r.clientId; render(); };
    wrap.appendChild(card);
  });
  main.appendChild(wrap);
}

/* ============================= INIT ============================= */
(async function init(){
  try {
    app.innerHTML = `<div style="padding:40px;color:var(--text-dim);">Loading your clients…</div>`;
    await loadClients();
    render();
  } catch(err) {
    showFatalError(err);
  }
})();
