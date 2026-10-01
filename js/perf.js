// perf.js - Lightweight gameplay performance profiler
// Toggle overlay: F3 | Dump report to console: F4

const HISTORY_SIZE = 600; // ~10 seconds at 60fps

export class PerfProfiler {
  constructor() {
    this.enabled = false;
    this.sections = [
      'controls', 'player', 'particles', 'weapons', 'waves',
      'vfx', 'hud', 'collision', 'worldAnim', 'render',
    ];

    // Ring buffer per section: stores last HISTORY_SIZE frame times (ms)
    this.history = {};
    for (const s of this.sections) {
      this.history[s] = new Float32Array(HISTORY_SIZE);
    }
    this.frameTimes = new Float32Array(HISTORY_SIZE); // total frame time
    this.head = 0;
    this.sampleCount = 0;

    // Per-frame scratch
    this._marks = {};
    this._frameTotals = {};

    // Entity / GPU counters snapshot (written externally each frame)
    this.counters = {
      enemies: 0,
      particles: 0,
      drawCalls: 0,
      triangles: 0,
      damageNumbers: 0,
      pickups: 0,
      lights: 0,
    };

    // Spike log - frames > budget
    this.spikes = []; // { frame, total, breakdown, counters, timestamp }
    this.spikeBudgetMs = 16.67;
    this.maxSpikes = 100;

    // DOM
    this._overlay = null;
    this._built = false;

    // Frame timing
    this._frameStart = 0;
  }

  // --- Timing API (called from game loop) ---

  frameBegin() {
    if (!this.enabled) return;
    this._frameStart = performance.now();
    for (const s of this.sections) this._frameTotals[s] = 0;
  }

  sectionBegin(name) {
    if (!this.enabled) return;
    this._marks[name] = performance.now();
  }

  sectionEnd(name) {
    if (!this.enabled) return;
    const start = this._marks[name];
    if (start !== undefined) {
      this._frameTotals[name] = (this._frameTotals[name] || 0) + (performance.now() - start);
    }
  }

  frameEnd() {
    if (!this.enabled) return;
    const total = performance.now() - this._frameStart;
    const i = this.head;

    this.frameTimes[i] = total;
    for (const s of this.sections) {
      this.history[s][i] = this._frameTotals[s] || 0;
    }

    this.head = (this.head + 1) % HISTORY_SIZE;
    if (this.sampleCount < HISTORY_SIZE) this.sampleCount++;

    // Spike detection
    if (total > this.spikeBudgetMs) {
      const breakdown = {};
      for (const s of this.sections) breakdown[s] = +(this._frameTotals[s] || 0).toFixed(2);
      this.spikes.push({
        frame: this.sampleCount,
        total: +total.toFixed(2),
        breakdown,
        counters: { ...this.counters },
        timestamp: performance.now(),
      });
      if (this.spikes.length > this.maxSpikes) this.spikes.shift();
    }
  }

  // --- Overlay ---

  toggle() {
    this.enabled = !this.enabled;
    if (!this._built) this._buildOverlay();
    this._overlay.style.display = this.enabled ? 'block' : 'none';
    if (this.enabled) this._startOverlayLoop();
  }

  _buildOverlay() {
    this._built = true;
    const el = document.createElement('div');
    el.id = 'perf-overlay';
    el.style.cssText = `
      position: fixed; top: 8px; left: 8px; z-index: 99999;
      background: rgba(0,0,0,0.82); color: #0f0; font: 11px/1.5 monospace;
      padding: 8px 12px; border-radius: 4px; pointer-events: none;
      border: 1px solid rgba(0,255,100,0.3); min-width: 280px;
      white-space: pre; user-select: none;
    `;
    document.body.appendChild(el);
    this._overlay = el;
  }

  _startOverlayLoop() {
    const update = () => {
      if (!this.enabled) return;
      this._renderOverlay();
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  _renderOverlay() {
    const n = this.sampleCount;
    if (n === 0) { this._overlay.textContent = 'PERF: collecting...'; return; }

    const recent = Math.min(n, 120); // last ~2 sec
    const stats = this._computeStats(recent);
    const fps = 1000 / stats.frame.avg;
    const fpsP1 = 1000 / stats.frame.p99; // 1% low fps

    let text = '';
    text += `FPS  ${fps.toFixed(0).padStart(4)}  (1%low ${fpsP1.toFixed(0).padStart(3)})   frame ${stats.frame.avg.toFixed(1)}ms  p95 ${stats.frame.p95.toFixed(1)}ms  max ${stats.frame.max.toFixed(1)}ms\n`;
    text += '─'.repeat(52) + '\n';

    for (const s of this.sections) {
      const st = stats.sections[s];
      const bar = this._bar(st.avg, stats.frame.avg);
      text += `${s.padEnd(11)} ${st.avg.toFixed(2).padStart(6)}ms  p95 ${st.p95.toFixed(2).padStart(6)}ms  ${bar}\n`;
    }

    text += '─'.repeat(52) + '\n';
    const c = this.counters;
    text += `enemies ${String(c.enemies).padStart(3)}  particles ${String(c.particles).padStart(5)}  draws ${String(c.drawCalls).padStart(4)}  tris ${this._fmtK(c.triangles)}\n`;
    text += `dmgNums ${String(c.damageNumbers).padStart(3)}  pickups ${String(c.pickups).padStart(3)}  lights ${String(c.lights).padStart(2)}  spikes ${String(this.spikes.length).padStart(3)}\n`;

    this._overlay.textContent = text;
  }

  _bar(val, total) {
    const pct = total > 0 ? val / total : 0;
    const width = 16;
    const filled = Math.round(pct * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  }

  _fmtK(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n).padStart(5);
  }

  _computeStats(windowSize) {
    const result = { frame: null, sections: {} };
    result.frame = this._statsForBuffer(this.frameTimes, windowSize);
    for (const s of this.sections) {
      result.sections[s] = this._statsForBuffer(this.history[s], windowSize);
    }
    return result;
  }

  _statsForBuffer(buf, windowSize) {
    const vals = [];
    for (let k = 0; k < windowSize; k++) {
      const idx = (this.head - 1 - k + HISTORY_SIZE) % HISTORY_SIZE;
      vals.push(buf[idx]);
    }
    vals.sort((a, b) => a - b);
    const n = vals.length;
    return {
      avg: vals.reduce((a, b) => a + b, 0) / n,
      p95: vals[Math.floor(n * 0.95)] || 0,
      p99: vals[Math.floor(n * 0.99)] || 0,
      max: vals[n - 1] || 0,
      min: vals[0] || 0,
    };
  }

  // --- Console Report (F4) ---

  dumpReport() {
    const n = this.sampleCount;
    if (n < 10) { console.log('[PERF] Not enough samples yet.'); return; }

    const full = this._computeStats(Math.min(n, HISTORY_SIZE));
    const recent = this._computeStats(Math.min(n, 120));

    console.group('%c[PERF REPORT]', 'color: #0f0; font-weight: bold; font-size: 14px');

    console.log(`Samples: ${n} frames (buffer: ${HISTORY_SIZE})`);
    console.log(`FPS: ${(1000 / full.frame.avg).toFixed(1)} avg, ${(1000 / full.frame.p99).toFixed(1)} 1%low`);
    console.log('');

    // Section table
    const tableData = {};
    for (const s of this.sections) {
      const sf = full.sections[s];
      const sr = recent.sections[s];
      tableData[s] = {
        'avg(ms)': +sf.avg.toFixed(3),
        'p95(ms)': +sf.p95.toFixed(3),
        'max(ms)': +sf.max.toFixed(3),
        'recent_avg(ms)': +sr.avg.toFixed(3),
        'recent_p95(ms)': +sr.p95.toFixed(3),
        '%_of_frame': +((sf.avg / full.frame.avg) * 100).toFixed(1),
      };
    }
    console.table(tableData);

    // Frame time distribution
    const buckets = { '<8ms': 0, '8-12ms': 0, '12-16ms': 0, '16-20ms': 0, '20-33ms': 0, '>33ms': 0 };
    const count = Math.min(n, HISTORY_SIZE);
    for (let k = 0; k < count; k++) {
      const idx = (this.head - 1 - k + HISTORY_SIZE) % HISTORY_SIZE;
      const t = this.frameTimes[idx];
      if (t < 8) buckets['<8ms']++;
      else if (t < 12) buckets['8-12ms']++;
      else if (t < 16) buckets['12-16ms']++;
      else if (t < 20) buckets['16-20ms']++;
      else if (t < 33) buckets['20-33ms']++;
      else buckets['>33ms']++;
    }
    console.log('Frame time distribution:');
    for (const [range, cnt] of Object.entries(buckets)) {
      const pct = ((cnt / count) * 100).toFixed(1);
      console.log(`  ${range.padEnd(8)} ${String(cnt).padStart(5)} (${pct}%)`);
    }

    // Top spikes
    if (this.spikes.length > 0) {
      console.log('');
      console.log(`Spikes (>${this.spikeBudgetMs.toFixed(1)}ms): ${this.spikes.length} total`);
      const worst = [...this.spikes].sort((a, b) => b.total - a.total).slice(0, 10);
      for (const spike of worst) {
        const top3 = Object.entries(spike.breakdown)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => `${k}=${v}ms`)
          .join(', ');
        console.log(`  ${spike.total}ms — ${top3} | enemies=${spike.counters.enemies} particles=${spike.counters.particles} draws=${spike.counters.drawCalls}`);
      }
    }

    // Bottleneck summary
    console.log('');
    console.log('--- BOTTLENECK SUMMARY ---');
    const ranked = this.sections
      .map(s => ({ name: s, avg: full.sections[s].avg, p95: full.sections[s].p95 }))
      .sort((a, b) => b.avg - a.avg);

    for (let i = 0; i < Math.min(3, ranked.length); i++) {
      const r = ranked[i];
      const pct = ((r.avg / full.frame.avg) * 100).toFixed(1);
      console.log(`  #${i + 1} ${r.name}: ${r.avg.toFixed(2)}ms avg (${pct}% of frame), ${r.p95.toFixed(2)}ms p95`);
    }

    console.groupEnd();
  }
}
