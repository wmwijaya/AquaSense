/* ---------- Storage (single swap point; replace internals to move to IndexedDB etc.) ---------- */
const KEY = 'aquasense:v1';
const DEFAULTS = () => ({
  target: 2000, targetUpdatedAt: 0,
  remindersUpdatedAt: 0,
  deleted: [],     // ids of removed drinks (tombstones so deletes sync)
  drinks: [],      // {id, ts, ml, label}
  urination: {},   // 'YYYY-MM-DD' -> {count, hold, duration, reason, symptoms[]}
  uro: [],         // {ts, level}
  reminders: { enabled: true, times: ['07:00', '09:30', '12:00', '15:30'], fired: {} },
});
const Store = {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? { ...DEFAULTS(), ...JSON.parse(raw) } : DEFAULTS();
    } catch { return DEFAULTS(); }
  },
  save(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* private mode / quota */ }
  },
};
const data = Store.load();
const commit = () => { Store.save(data); Sync.schedule(); };

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const nf = new Intl.NumberFormat('id-ID');
const pad = n => String(n).padStart(2, '0');
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeLabel = ts => { const d = new Date(ts); return `${pad(d.getHours())}.${pad(d.getMinutes())}`; };
const todayKey = () => dayKey(Date.now());
const drinksOn = key => data.drinks.filter(d => dayKey(d.ts) === key);
const sumMl = list => list.reduce((s, d) => s + d.ml, 0);
const lastUro = () => data.uro.length ? data.uro[data.uro.length - 1] : null;

const ui = { size: 200, qty: 1, pee: 0, selectedColor: null };

function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function showPage(id) {
  $$('.page').forEach(p => p.classList.toggle('active', p.id === id));
  $$('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.page === id));
  $('.app-shell').scrollTop = 0;
  render();
}

/* ---------- Score ---------- */
function computeScore() {
  const key = todayKey();
  const total = sumMl(drinksOn(key));
  const rec = data.urination[key];
  const uro = lastUro();

  const intake = Math.min(1, total / data.target) * 60;
  const holdPts = !rec ? 10 : [20, 14, 8, 0][rec.hold] ?? 0;
  const uroPts = !uro ? 10 : [20, 20, 20, 12, 6, 0][uro.level - 1];
  const score = Math.round(intake + holdPts + uroPts);

  const [label, desc] =
    score >= 80 ? ['Sangat baik', 'Kebiasaan hidrasimu sangat baik. Pertahankan ritme ini.'] :
    score >= 60 ? ['Cukup baik', 'Kebiasaan hidrasimu cukup baik. Masih ada beberapa hal yang bisa ditingkatkan.'] :
    score >= 40 ? ['Perlu perhatian', 'Coba tambah asupan cairan dan lengkapi catatan harianmu.'] :
                  ['Perlu ditingkatkan', 'Mulai catat minum hari ini dan minum secara bertahap.'];

  const why = [];
  why.push(total > 0 ? ['yes', `${nf.format(total)} ml tercatat hari ini`] : ['warn', 'Belum ada konsumsi tercatat hari ini']);
  why.push(total >= data.target ? ['yes', 'Target minum harian tercapai'] : ['warn', 'Target minum harian belum tercapai']);
  why.push(!rec ? ['warn', 'Belum ada catatan berkemih hari ini']
    : rec.hold === 0 ? ['yes', 'Tidak tercatat menahan berkemih']
    : ['warn', `Tercatat menahan berkemih (${rec.duration})`]);
  why.push(!uro ? ['warn', 'Belum ada UroColor Check']
    : [uro.level <= 3 ? 'yes' : 'warn', `UroColor terakhir menunjukkan warna ${uro.level}`]);
  return { score, label, desc, why };
}

/* ---------- Render ---------- */
function renderHome() {
  const total = sumMl(drinksOn(todayKey()));
  const percent = Math.min(100, Math.round(total / data.target * 100));
  $('#targetMl').textContent = data.target;
  $('#totalMl').textContent = nf.format(total);
  $('#percent').textContent = percent + '%';
  $('#waterLevel').style.width = percent + '%';
  $('#remainingLine').innerHTML = total >= data.target
    ? 'Target hari ini tercapai 🎉'
    : `Target tersisa <span id="remainingMl">${nf.format(data.target - total)}</span> ml`;
}

function renderHistory() {
  const list = drinksOn(todayKey()).sort((a, b) => b.ts - a.ts);
  $('#historyCount').textContent = list.length + ' catatan';
  const box = $('#historyList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">Belum ada catatan hari ini.</div>'; return; }
  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = '<i></i><div><b></b><small></small></div><strong></strong><button class="del" aria-label="Hapus catatan">×</button>';
    row.querySelector('b').textContent = d.label;
    row.querySelector('small').textContent = timeLabel(d.ts);
    row.querySelector('strong').textContent = '+' + d.ml + ' ml';
    row.querySelector('.del').addEventListener('click', () => {
      data.drinks = data.drinks.filter(x => x.id !== d.id);
      data.deleted.push(d.id);
      commit(); render(); toast('Catatan dihapus');
    });
    box.append(row);
  }
}

function renderInsight() {
  const { score, label, desc, why } = computeScore();
  $('#scoreNum').textContent = score;
  $('#scoreLabel').textContent = label;
  $('#scoreDesc').textContent = desc;
  $('#scoreBar').style.width = score + '%';
  $('#whyTitle').textContent = `Kenapa skornya ${score}?`;
  $('#whyList').innerHTML = why.map(([k, t]) => `<p><i class="${k}">${k === 'yes' ? '✓' : '!'}</i><span>${t}</span></p>`).join('');

  const days = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const chart = $('#barChart');
  chart.innerHTML = '';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ml = sumMl(drinksOn(dayKey(d)));
    const h = Math.max(2, Math.min(100, Math.round(ml / data.target * 100)));
    const col = document.createElement('div');
    col.style.setProperty('--h', h + '%');
    col.title = `${nf.format(ml)} ml`;
    col.innerHTML = `<i${i === 0 ? ' class="today"' : ''}></i><span>${days[d.getDay()]}</span>`;
    chart.append(col);
  }
}

function renderUrination() {
  const rec = data.urination[todayKey()];
  ui.pee = rec ? rec.count : 0;
  $('#peeCount').textContent = ui.pee;
  $$('.choice-row').forEach(row => {
    const g = row.dataset.group;
    const idx = !rec ? 0 : g === 'hold' ? rec.hold : g === 'duration' ? rec.durationIdx : rec.reasonIdx;
    [...row.children].forEach((b, i) => b.classList.toggle('selected', i === idx));
  });
  $$('#urination .check input').forEach(c => { c.checked = !!rec && rec.symptoms.includes(c.value); });
}

function renderReminders() {
  const r = data.reminders;
  $('#reminderToggle').classList.toggle('on', r.enabled);
  $('#reminderToggle').setAttribute('aria-pressed', r.enabled);
  $('#schedule').style.opacity = r.enabled ? '1' : '.45';
  $$('.slot').forEach(inp => { inp.value = r.times[+inp.dataset.slot]; });
}

function render() { renderHome(); renderHistory(); renderInsight(); }

/* ---------- Drinks ---------- */
function addDrink(ml, label) {
  data.drinks.push({ id: Date.now() + Math.random(), ts: Date.now(), ml, label });
  commit(); render();
}
const containerNames = { 200: 'Gelas', 350: 'Botol kecil', 600: 'Tumbler' };

$$('[data-page]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
$$('[data-add]').forEach(b => b.addEventListener('click', () => {
  addDrink(+b.dataset.add, 'Tambah cepat');
  toast(`+${b.dataset.add} ml ditambahkan!`);
}));
function updateSaveAmount() {
  $('#drinkQty').textContent = ui.qty;
  $('#saveAmount').textContent = (ui.size * ui.qty) + ' ml';
}
$$('#containers .container').forEach(b => b.addEventListener('click', () => {
  ui.size = +b.dataset.size;
  $$('#containers .container').forEach(x => x.classList.toggle('selected', x === b));
  updateSaveAmount();
}));
$('#drinkMinus').addEventListener('click', () => { ui.qty = Math.max(1, ui.qty - 1); updateSaveAmount(); });
$('#drinkPlus').addEventListener('click', () => { ui.qty++; updateSaveAmount(); });
$('#saveDrink').addEventListener('click', () => {
  addDrink(ui.size * ui.qty, ui.qty > 1 ? `${containerNames[ui.size]} ×${ui.qty}` : containerNames[ui.size]);
  ui.qty = 1; updateSaveAmount();
  toast('Konsumsi tersimpan ✓');
});

/* ---------- Reminders ---------- */
$('#reminderToggle').addEventListener('click', () => {
  const r = data.reminders;
  r.enabled = !r.enabled; data.remindersUpdatedAt = Date.now();
  commit(); renderReminders();
  if (r.enabled && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  toast(r.enabled ? 'Pengingat aktif' : 'Pengingat dinonaktifkan');
});
$$('.slot').forEach(inp => inp.addEventListener('change', () => {
  if (!inp.value) return;
  data.reminders.times[+inp.dataset.slot] = inp.value; data.remindersUpdatedAt = Date.now();
  commit(); toast('Jadwal diperbarui');
}));
function checkReminders() {
  const r = data.reminders;
  if (!r.enabled) return;
  const now = new Date(), hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`, key = todayKey();
  const names = ['Sebelum kelas', 'Istirahat pertama', 'Istirahat siang', 'Sepulang sekolah'];
  r.times.forEach((t, i) => {
    const id = `${key}@${t}#${i}`;
    if (t !== hhmm || r.fired[id]) return;
    r.fired = Object.fromEntries(Object.entries(r.fired).filter(([k]) => k.startsWith(key)));
    r.fired[id] = 1; commit();
    toast(`💧 ${names[i] || 'Waktunya minum'} — waktunya minum!`);
    if ('Notification' in window && Notification.permission === 'granted') new Notification('AquaSense', { body: 'Waktunya minum air 💧' });
  });
}
setInterval(checkReminders, 20000);

/* ---------- Urination ---------- */
$('#peeMinus').addEventListener('click', () => { ui.pee = Math.max(0, ui.pee - 1); $('#peeCount').textContent = ui.pee; });
$('#peePlus').addEventListener('click', () => { ui.pee++; $('#peeCount').textContent = ui.pee; });
$$('.choice-row').forEach(row => row.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  row.querySelectorAll('button').forEach(x => x.classList.toggle('selected', x === b));
  // Choosing "no holding" in one group resets dependent groups; picking a hold value clears "Tidak menahan".
  if (row.dataset.group === 'hold') {
    const none = [...row.children].indexOf(b) === 0;
    if (none) $$('.choice-row').forEach(r => { if (r.dataset.group !== 'hold') [...r.children].forEach((x, i) => x.classList.toggle('selected', i === 0)); });
  }
})));
$('#saveUrination').addEventListener('click', () => {
  const pick = g => {
    const row = $(`.choice-row[data-group="${g}"]`);
    const i = [...row.children].findIndex(b => b.classList.contains('selected'));
    return { i, text: row.children[i].textContent };
  };
  const hold = pick('hold'), dur = pick('duration'), reason = pick('reason');
  data.urination[todayKey()] = {
    count: ui.pee,
    hold: hold.i, duration: dur.text, reason: reason.text,
    durationIdx: dur.i, reasonIdx: reason.i,
    symptoms: $$('#urination .check input:checked').map(c => c.value),
    updatedAt: Date.now(),
  };
  commit(); render();
  const danger = data.urination[todayKey()].symptoms.includes('Urine kemerahan atau berdarah');
  toast(danger ? 'Tersimpan. Urine berdarah perlu dicek tenaga kesehatan.' : 'Catatan tersimpan ✓');
});

/* ---------- UroColor ---------- */
const results = {
  1: ['Sangat pucat', 'Warna terlihat sangat pucat.', 'Pertahankan pola minum yang teratur dan tetap perhatikan kebutuhan cairan tubuhmu.'],
  2: ['Terlihat baik', 'Warna terlihat cukup pucat.', 'Pertahankan kebiasaan hidrasi yang baik sepanjang hari.'],
  3: ['Cukup baik', 'Warna masih terlihat cukup ringan.', 'Tetap minum secara teratur, terutama setelah beraktivitas.'],
  4: ['Cukup pekat', 'Warna terlihat lebih pekat.', 'Coba perhatikan kembali asupan cairanmu hari ini dan minum secara bertahap.'],
  5: ['Pekat', 'Warna terlihat cukup pekat.', 'Pertimbangkan untuk meningkatkan perhatian pada pola minum hari ini.'],
  6: ['Sangat pekat', 'Warna terlihat sangat pekat.', 'Perhatikan kondisi tubuh dan konsumsi cairan. Jika disertai keluhan lain, beri tahu orang tua atau tenaga kesehatan.'],
};
$$('#colorGrid button').forEach(b => b.addEventListener('click', () => {
  ui.selectedColor = +b.dataset.color;
  $$('#colorGrid button').forEach(x => x.classList.toggle('selected', x === b));
  $('#showResult').disabled = false;
}));
$('#showResult').addEventListener('click', () => {
  const n = ui.selectedColor, r = results[n];
  const sw = $('#colorGrid button.selected').style.getPropertyValue('--swatch');
  data.uro.push({ ts: Date.now(), level: n });
  data.uro = data.uro.slice(-200);
  commit();
  $('#resultSwatch').style.setProperty('--swatch', sw);
  $('#resultNo').textContent = n;
  $('#resultStatus').textContent = r[0];
  $('#resultText').textContent = r[1];
  $('#resultTip').textContent = r[2];
  $('#uroSelect').hidden = true;
  $('#uroResult').hidden = false;
  render();
});
$('#checkAgain').addEventListener('click', () => {
  $('#uroSelect').hidden = false; $('#uroResult').hidden = true;
  ui.selectedColor = null; $('#showResult').disabled = true;
  $$('#colorGrid button').forEach(x => x.classList.remove('selected'));
});

/* ---------- Settings ---------- */
const TARGET_MIN = 500, TARGET_MAX = 6000, TARGET_STEP = 100;
let draftTarget = data.target;
function renderTarget() {
  $('#targetVal').textContent = draftTarget;
  $$('#targetPresets button').forEach(b => b.classList.toggle('selected', +b.dataset.v === draftTarget));
}
const setDraft = v => { draftTarget = Math.min(TARGET_MAX, Math.max(TARGET_MIN, v)); renderTarget(); };
$('#targetMinus').addEventListener('click', () => setDraft(draftTarget - TARGET_STEP));
$('#targetPlus').addEventListener('click', () => setDraft(draftTarget + TARGET_STEP));
$$('#targetPresets button').forEach(b => b.addEventListener('click', () => setDraft(+b.dataset.v)));
$('#saveTarget').addEventListener('click', () => {
  data.target = draftTarget; data.targetUpdatedAt = Date.now(); commit(); render();
  toast('Target harian disimpan ✓'); showPage('home');
});
$$('[data-page="settings"]').forEach(b => b.addEventListener('click', () => { draftTarget = data.target; renderTarget(); }));

/* ---------- Account & sync ---------- */
// Guest mode works fully offline. When signed in, the whole document is pushed to
// the server, which merges it with other devices' copies and returns the result.
const Sync = {
  email: null, busy: false, again: false, timer: null, status: 'off',
  api(path, body) {
    return fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || 'gagal'), { status: r.status });
      return j;
    });
  },
  schedule() {
    if (!this.email) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 1500);
  },
  async run() {
    if (!this.email) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true; this.again = false;
    this.setStatus('syncing');
    try {
      const { data: merged } = await this.api('sync', { data });
      if (this.again) { this.busy = false; return this.run(); }  // edited mid-flight: resend, don't clobber
      const reminders = merged.reminders || data.reminders;
      reminders.fired = data.reminders.fired || {};
      Object.assign(data, merged, { reminders });
      Store.save(data);
      draftTarget = data.target;
      renderTarget(); renderReminders(); renderUrination(); render();
      this.setStatus('ok');
    } catch (e) {
      if (e.status === 401) { this.email = null; this.setStatus('off'); toast('Sesi berakhir, silakan masuk lagi'); }
      else this.setStatus('error');
    } finally { this.busy = false; }
  },
  setStatus(s) {
    this.status = s;
    const guest = !this.email;
    $('#authGuest').hidden = !guest;
    $('#authUser').hidden = guest;
    if (!guest) {
      $('#authEmail').textContent = this.email;
      $('#syncState').textContent = { syncing: 'Menyinkronkan…', ok: 'Tersinkron ✓', error: 'Offline — akan dicoba lagi', off: '' }[s];
    }
  },
  async boot() {
    try { this.email = (await this.api('me')).email; } catch { /* offline or no backend: stay in guest mode */ }
    this.setStatus(this.email ? 'syncing' : 'off');
    if (this.email) this.run();
  },
};
window.addEventListener('online', () => Sync.run());
document.addEventListener('visibilitychange', () => { if (!document.hidden) Sync.run(); });

async function authSubmit(kind) {
  const email = $('#authEmailInput').value, password = $('#authPassInput').value;
  $('#authError').textContent = '';
  try {
    const r = await Sync.api(kind, { email, password });
    Sync.email = r.email; $('#authPassInput').value = '';
    toast(kind === 'register' ? 'Akun dibuat ✓' : 'Berhasil masuk ✓');
    await Sync.run();
  } catch (e) { $('#authError').textContent = e.status ? e.message : 'Tidak dapat terhubung ke server'; }
}
$('#loginBtn').addEventListener('click', () => authSubmit('login'));
$('#registerBtn').addEventListener('click', () => authSubmit('register'));
$('#syncNow').addEventListener('click', () => Sync.run());
$('#logoutBtn').addEventListener('click', async () => {
  await Sync.run();                         // push last changes first
  await Sync.api('logout', {}).catch(() => {});
  Sync.email = null;
  // Clear this device's copy so the next person on a shared device starts clean.
  Object.assign(data, DEFAULTS()); Store.save(data);
  draftTarget = data.target;
  Sync.setStatus('off'); renderTarget(); renderReminders(); renderUrination(); render();
  toast('Keluar. Data tetap tersimpan di akunmu.');
});
$('#deleteAccountBtn').addEventListener('click', async () => {
  const password = prompt('Masukkan kata sandi untuk menghapus akun dan semua datanya di server:');
  if (!password) return;
  try {
    await Sync.api('delete-account', { password });
    Sync.email = null; Sync.setStatus('off'); toast('Akun dihapus');
  } catch (e) { toast(e.message); }
});

/* ---------- Boot ---------- */
// Keep views correct if the tab stays open across midnight.
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); renderUrination(); } });
Sync.setStatus('off'); Sync.boot();
updateSaveAmount(); renderTarget(); renderReminders(); renderUrination(); render(); checkReminders();
