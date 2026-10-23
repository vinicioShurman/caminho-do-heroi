(() => {
  'use strict';

  // aparência da linha
  const BASE = [50, 210, 141];      // #32d28d, a cor padrão do mod
  const HI = [216, 255, 238];       // brilho que corre pela linha
  const BUCKETS = 16;               // faixas de cor por quadro (uma path por faixa)
  const WAVE_PX = 140;              // comprimento de uma onda do gradiente (px de tela)
  const WAVE_SPEED = 90;            // px de tela por segundo, no sentido do caminho

  const $ = (id) => document.getElementById(id);
  const canvas = $('trail');
  const ctx = canvas.getContext('2d');
  const slider = $('slider');
  const bar = document.querySelector('.bar');

  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Carregando caminho…';
  document.body.appendChild(loading);

  const player = new Image();
  player.src = 'assets/player.png';

  let D, N, X, Y, T, M, CUM;
  let map, nativeZoom;
  let cur = 0;                      // tempo de jogo atual (s)
  let playing = false;
  let lastFrame = performance.now();
  let heading = 0;

  fetch('data/path.json').then((r) => r.json()).then(init).catch((e) => {
    loading.textContent = 'Não foi possível carregar data/path.json';
    console.error(e);
  });

  function init(data) {
    D = data;
    N = data.x.length;
    X = Float32Array.from(data.x);
    Y = Float32Array.from(data.y);
    T = Float64Array.from(data.t);
    M = Uint8Array.from(data.m);
    CUM = new Float64Array(N);       // distância acumulada (px do mapa), anima o gradiente
    for (let i = 1; i < N; i++) {
      CUM[i] = CUM[i - 1] + (M[i] === 1 ? 0 : Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]));
    }
    nativeZoom = data.maxZoom;

    map = L.map('map', {
      crs: L.CRS.Simple,
      zoomControl: true,
      zoomAnimation: false,          // o canvas acompanha o mapa quadro a quadro
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      maxZoom: nativeZoom + 2,
      attributionControl: false,
    });
    map.zoomControl.setPosition('topright');
    const size = data.mapPx;
    const bounds = L.latLngBounds(map.unproject([0, size], nativeZoom), map.unproject([size, 0], nativeZoom));
    L.tileLayer('tiles/{z}/{x}/{y}.jpg', {
      tileSize: 256, noWrap: true, bounds,
      minNativeZoom: 0, maxNativeZoom: nativeZoom, minZoom: -2, maxZoom: nativeZoom + 2,
    }).addTo(map);
    map.setMaxBounds(bounds.pad(0.25));

    // enquadra a área percorrida
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < N; i++) {
      if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i];
      if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i];
    }
    const pathBounds = L.latLngBounds(map.unproject([x0, y1], nativeZoom), map.unproject([x1, y0], nativeZoom));
    map.fitBounds(pathBounds, { padding: [40, 40] });
    map.setMinZoom(Math.min(map.getZoom(), map.getBoundsZoom(bounds)) - 0.5);
    map.on('move zoom', () => redraw(lastSec));
    map.on('dragstart', () => { if ($('follow').checked) $('follow').checked = false; });

    slider.max = Math.ceil(D.total);
    buildTicks();
    buildDays();

    const fromHash = parseFloat((location.hash.match(/t=(\d+(\.\d+)?)/) || [])[1]);
    setTime(Number.isFinite(fromHash) ? fromHash : D.total);

    wireControls();
    window.addEventListener('resize', () => { resize(); buildTicks(); });
    resize();
    loading.remove();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ tempo

  // último ponto com T <= t
  function indexAt(t) {
    let lo = 0, hi = N - 1;
    if (t < T[0]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (T[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function sessionAt(t) {
    const s = D.sessions;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function setTime(t) {
    cur = Math.max(0, Math.min(D.total, t));
    slider.value = Math.round(cur);
    slider.style.setProperty('--p', (cur / D.total * 100) + '%');
    $('clock').textContent = fmtDur(cur);
    $('statTime').textContent = fmtDur(cur);
    const s = D.sessions[sessionAt(cur)];
    const date = new Date(s.date.replace(' ', 'T'));
    date.setSeconds(date.getSeconds() + (cur - s.t));
    $('statDate').textContent = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '') +
      ' · ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const i = indexAt(cur);
    const km = i < 0 ? 0 : D.distanceKm * CUM[i] / CUM[N - 1];
    $('statDist').textContent = km.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';
    const away = i < 0 || (cur - T[i] > 20 && (i + 1 >= N || T[i + 1] - cur > 20));
    $('where').hidden = !away || cur >= D.total;
    if (days.length) markDay();
  }

  function fmtDur(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }

  // tempo de jogo somado por dia (data real em que o trecho começou)
  let days = [];
  function buildDays() {
    const s = D.sessions;
    const byDay = new Map();
    for (let k = 0; k < s.length; k++) {
      const day = s[k].date.slice(0, 10);
      const dur = (k + 1 < s.length ? s[k + 1].t : D.total) - s[k].t;
      if (!byDay.has(day)) byDay.set(day, { day, t: s[k].t, dur: 0 });
      byDay.get(day).dur += dur;
    }
    days = [...byDay.values()];
    const max = Math.max(...days.map((d) => d.dur));
    const list = $('days');
    for (const d of days) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${d.day.slice(8, 10)}/${d.day.slice(5, 7)}</span>` +
        `<span class="meter"><i style="width:${(d.dur / max * 100).toFixed(1)}%"></i></span>` +
        `<span class="h">${fmtDur(d.dur)}</span>`;
      li.title = 'Ir para o começo do dia';
      li.addEventListener('click', () => { pause(); setTime(d.t); });
      d.el = li;
      list.appendChild(li);
    }
    const total = document.createElement('li');
    total.className = 'total';
    total.innerHTML = `<span>Total</span><span></span><span class="h">${fmtDur(D.total)}</span>`;
    list.appendChild(total);

    const toggle = $('daysToggle');
    const setOpen = (open) => {
      list.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      try { localStorage.setItem('heropath.days', open ? '1' : '0'); } catch (e) { /* sem storage */ }
    };
    toggle.addEventListener('click', () => setOpen(list.hidden));
    let saved = null;
    try { saved = localStorage.getItem('heropath.days'); } catch (e) { /* sem storage */ }
    setOpen(saved === '1');
  }

  function markDay() {
    const day = D.sessions[sessionAt(cur)].date.slice(0, 10);
    for (const d of days) d.el.classList.toggle('now', d.day === day);
  }

  function buildTicks() {
    const box = $('ticks');
    box.textContent = '';
    const minGap = 44 / Math.max(1, box.clientWidth) * 100;   // % mínimo entre rótulos
    let lastDay = '';
    let lastPct = -100;
    for (const s of D.sessions) {
      const day = s.date.slice(0, 10);
      if (day === lastDay) continue;
      lastDay = day;
      const pct = s.t / D.total * 100;
      if (pct - lastPct < minGap) continue;   // evita rótulos encavalados
      lastPct = pct;
      const el = document.createElement('span');
      el.style.left = pct + '%';
      el.textContent = day.slice(8, 10) + '/' + day.slice(5, 7);
      el.title = 'Ir para ' + el.textContent;
      el.addEventListener('click', () => { pause(); setTime(s.t); });
      box.appendChild(el);
    }
  }

  // ------------------------------------------------------------------ controles

  function play() {
    if (cur >= D.total - 1) setTime(0);
    playing = true;
    bar.classList.add('playing');
    $('play').setAttribute('aria-label', 'Pausar');
  }
  function pause() {
    playing = false;
    bar.classList.remove('playing');
    $('play').setAttribute('aria-label', 'Reproduzir');
    history.replaceState(null, '', '#t=' + Math.round(cur));
  }

  function jumpSession(dir) {
    pause();
    const s = D.sessions;
    let k = sessionAt(cur);
    if (dir < 0 && cur - s[k].t < 2) k--;       // já no começo: vai para o anterior
    if (dir > 0) k++;
    while (k >= 0 && k < s.length && !s[k].world) k += dir < 0 ? -1 : 1;
    if (k < 0) setTime(0);
    else if (k >= s.length) setTime(D.total);
    else setTime(s[k].t);
  }

  function wireControls() {
    $('play').addEventListener('click', () => (playing ? pause() : play()));
    $('prev').addEventListener('click', () => jumpSession(-1));
    $('next').addEventListener('click', () => jumpSession(1));
    slider.addEventListener('input', () => { if (playing) pause(); setTime(+slider.value); });
    slider.addEventListener('change', () => history.replaceState(null, '', '#t=' + Math.round(cur)));
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'SELECT') return;
      if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); playing ? pause() : play(); }
      else if (e.target === slider) return;
      else if (e.code === 'ArrowLeft') { pause(); setTime(cur - (e.shiftKey ? 600 : 60)); }
      else if (e.code === 'ArrowRight') { pause(); setTime(cur + (e.shiftKey ? 600 : 60)); }
    });
  }

  // ------------------------------------------------------------------ desenho

  let dpr = 1, W = 0, H = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
  }

  const solid = Array.from({ length: BUCKETS }, () => []);
  const dashed = Array.from({ length: BUCKETS }, () => []);
  const colors = Array.from({ length: BUCKETS }, (_, b) => {
    const w = 0.5 + 0.5 * Math.cos((b / BUCKETS) * Math.PI * 2);   // 0..1, pico em b = 0
    const f = Math.pow(w, 2.2);
    const c = BASE.map((v, i) => Math.round(v + (HI[i] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  });

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (playing) {
      setTime(cur + dt * +$('speed').value);
      if (cur >= D.total) pause();
    }
    redraw(now / 1000);
    requestAnimationFrame(frame);
  }

  // também redesenha em cada movimento do mapa (arrastar, inércia, limites), no mesmo
  // instante em que o Leaflet move os tiles, para a linha nunca ficar um quadro atrás
  let drawing = false;
  let lastSec = 0;
  function redraw(sec) {
    if (drawing) return;
    drawing = true;
    lastSec = sec;
    try { draw(sec); } finally { drawing = false; }
  }

  function draw(sec) {
    const end = indexAt(cur);

    // ponta parcial entre o último ponto e o próximo
    let hx = 0, hy = 0, tip = false;
    if (end >= 0) {
      hx = X[end]; hy = Y[end];
      if (end + 1 < N && M[end + 1] !== 1 && T[end + 1] > T[end]) {
        const f = Math.min(1, (cur - T[end]) / (T[end + 1] - T[end]));
        hx = X[end] + (X[end + 1] - X[end]) * f;
        hy = Y[end] + (Y[end + 1] - Y[end]) * f;
        tip = true;
      }
    }

    const z = map.getZoom();
    const k = Math.pow(2, z - nativeZoom);

    // seguir: move o mapa ANTES de calcular a posição da linha, senão ela fica um quadro atrás
    if (end >= 0 && $('follow').checked) {
      const o0 = map.latLngToContainerPoint(map.unproject([0, 0], nativeZoom));
      const c = map.getSize();
      const dx = hx * k + o0.x - c.x / 2, dy = hy * k + o0.y - c.y / 2;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        const step = Math.max(0.12, Math.min(1, Math.hypot(dx, dy) / 400));
        map.panBy([Math.round(dx * step), Math.round(dy * step)], { animate: false });
      }
    }

    const o = map.latLngToContainerPoint(map.unproject([0, 0], nativeZoom));
    const ox = o.x, oy = o.y;
    const lw = Math.max(1.6, Math.min(5.5, 2.4 * Math.pow(k * 4, 0.45)));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pad = 20;
    const vis = (ax, ay, bx, by) =>
      !((ax < -pad && bx < -pad) || (ax > W + pad && bx > W + pad) ||
        (ay < -pad && by < -pad) || (ay > H + pad && by > H + pad));

    // futuro (opcional, bem apagado)
    if ($('ghost').checked && end < N - 1) {
      ctx.beginPath();
      for (let i = Math.max(1, end + 1); i < N; i++) {
        if (M[i] === 1) continue;
        const ax = X[i - 1] * k + ox, ay = Y[i - 1] * k + oy, bx = X[i] * k + ox, by = Y[i] * k + oy;
        if (!vis(ax, ay, bx, by)) continue;
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.strokeStyle = 'rgba(233,226,212,0.16)';
      ctx.lineWidth = Math.max(1, lw * 0.6);
      ctx.setLineDash([]);
      ctx.stroke();
    }
    if (end < 0) return;

    for (let b = 0; b < BUCKETS; b++) { solid[b].length = 0; dashed[b].length = 0; }
    const shift = sec * WAVE_SPEED;
    const outline = new Path2D();
    const segs = (i, ax, ay, bx, by, cum) => {
      let ph = ((cum * k - shift) / WAVE_PX) % 1;
      if (ph < 0) ph += 1;
      const b = Math.floor(ph * BUCKETS) % BUCKETS;
      (M[i] === 2 ? dashed : solid)[b].push(ax, ay, bx, by);
      if (M[i] !== 2) { outline.moveTo(ax, ay); outline.lineTo(bx, by); }
    };
    for (let i = 1; i <= end; i++) {
      if (M[i] === 1) continue;
      const ax = X[i - 1] * k + ox, ay = Y[i - 1] * k + oy, bx = X[i] * k + ox, by = Y[i] * k + oy;
      if (!vis(ax, ay, bx, by)) continue;
      segs(i, ax, ay, bx, by, (CUM[i - 1] + CUM[i]) / 2);
    }
    if (tip) {
      const ax = X[end] * k + ox, ay = Y[end] * k + oy;
      segs(end + 1, ax, ay, hx * k + ox, hy * k + oy, CUM[end]);
    }

    // contorno escuro para destacar a linha sobre o mapa
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(8,10,9,0.55)';
    ctx.lineWidth = lw + 2.5;
    ctx.stroke(outline);

    ctx.lineWidth = lw;
    for (let pass = 0; pass < 2; pass++) {
      const set = pass === 0 ? solid : dashed;
      ctx.setLineDash(pass === 0 ? [] : [lw * 0.6, lw * 2.4]);
      for (let b = 0; b < BUCKETS; b++) {
        const s = set[b];
        if (!s.length) continue;
        ctx.beginPath();
        for (let j = 0; j < s.length; j += 4) { ctx.moveTo(s[j], s[j + 1]); ctx.lineTo(s[j + 2], s[j + 3]); }
        ctx.strokeStyle = colors[b];
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // o herói, virado para onde estava andando
    for (let i = end + (tip ? 1 : 0); i > 0 && i > end - 30; i--) {
      if (M[i] === 1) break;
      const dx = (i === end + 1 ? hx : X[i]) - X[i - 1], dy = (i === end + 1 ? hy : Y[i]) - Y[i - 1];
      if (dx * dx + dy * dy > 1) { heading = Math.atan2(dy, dx); break; }
    }
    const px = hx * k + ox, py = hy * k + oy;
    const pulse = (sec % 1.6) / 1.6;
    ctx.beginPath();
    ctx.arc(px, py, 10 + pulse * 22, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(50,210,141,${0.7 * (1 - pulse)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (player.complete && player.naturalWidth) {
      const s = 34;
      ctx.save();
      ctx.translate(px, py);
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(50,210,141,0.85)';
      ctx.fill();
      ctx.rotate(heading + Math.PI / 2);
      ctx.shadowColor = 'rgba(50,210,141,0.7)';
      ctx.shadowBlur = 12;
      ctx.drawImage(player, -s / 2, -s * 0.605, s, s);   // gira em volta do centro do anel
      ctx.restore();
    }
  }
})();
