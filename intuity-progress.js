/* ============================================================================
   INTUITY — Progress spine
   ----------------------------------------------------------------------------
   One store that every mode writes to: Learn, Quiz, Practice, Match, and the
   two games. Nothing in here renders anything; it holds item state, decides
   what to serve next, and hands out numbers for the UI to draw.

   Usage
   -----
     Progress.init();
     const id = Progress.id('take', 'through');          // "take|through"
     Progress.record(id, true, {mode:'quiz', latencyMs:1840});
     Progress.state(id);                                  // 'learning'
     Progress.due(6, {mixFamilies:true});                 // next six items
     Progress.mastery('take');                            // per-verb summary
     Progress.exportJSON();                               // pilot data dump

   Storage falls back to memory if localStorage is unavailable (private mode,
   sandboxed preview), so nothing throws — you just lose persistence.
============================================================================ */

(function (root) {
  'use strict';

  /* --- tuning ------------------------------------------------------------ */

  /* Leitner boxes. Index = box, value = hours until the item is due again.
     Box 0 is "never seen". The 10-minute box 1 exists so a fresh miss comes
     back inside the same session — that's where most of the repair happens. */
  const INTERVALS = [0, 0.17, 24, 72, 168, 336, 720];
  const MAX_BOX = INTERVALS.length - 1;

  /* An item counts as fluent — i.e. eligible for the timed game — once it's
     survived a couple of spaced reps AND is being retrieved fast. Accuracy
     alone doesn't mean automatic; speed is the thing the timed mode trains. */
  const FLUENT_BOX = 3;
  const FLUENT_MS = 3500;
  const LATENCY_ALPHA = 0.3;          // EMA weight on the newest response

  const SHAKY_WINDOW_H = 48;          // a lapse this recent still counts as shaky
  const H = 3600e3;

  /* --- storage ----------------------------------------------------------- */

  function makeStore(key) {
    let mem = null;
    let usable = true;
    try {
      const probe = '__intuity_probe__';
      root.localStorage.setItem(probe, '1');
      root.localStorage.removeItem(probe);
    } catch (e) { usable = false; }

    return {
      persistent: usable,
      read() {
        if (!usable) return mem;
        try { const raw = root.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
        catch (e) { return null; }
      },
      write(data) {
        mem = data;
        if (!usable) return;
        try { root.localStorage.setItem(key, JSON.stringify(data)); }
        catch (e) { usable = false; }        // quota blown — carry on in memory
      },
      clear() {
        mem = null;
        if (usable) { try { root.localStorage.removeItem(key); } catch (e) {} }
      }
    };
  }

  /* --- module ------------------------------------------------------------ */

  const Progress = {

    _store: null,
    _data: null,
    _listeners: [],
    _sessionStart: null,

    init(opts) {
      opts = opts || {};
      this._store = makeStore(opts.storageKey || 'intuity.progress.v1');
      this._data = this._store.read() || {
        version: 1,
        created: Date.now(),
        items: {},          // id -> record
        log: [],            // append-only attempt log (for the pilot)
        days: [],           // 'YYYY-MM-DD' strings, for the day streak
        sessions: 0
      };
      this._sessionStart = Date.now();
      this._data.sessions++;
      this._touchDay();
      this._save();
      return this;
    },

    onChange(fn) { this._listeners.push(fn); return this; },
    _emit() { this._listeners.forEach(fn => { try { fn(this); } catch (e) {} }); },
    _save() { this._store.write(this._data); this._emit(); },

    /* --- identity -------------------------------------------------------- */

    /* Stable across shuffles, JSON edits and reordering — unlike an array
       index, which is what the current build keys results on. */
    id(verb, particle) {
      return String(verb).toLowerCase().trim() + '|' + String(particle).toLowerCase().trim();
    },
    verbOf(id) { return id.split('|')[0]; },
    particleOf(id) { return id.split('|')[1]; },

    _rec(id) {
      if (!this._data.items[id]) {
        this._data.items[id] = {
          box: 0, reps: 0, correct: 0, lapses: 0,
          first: null, last: null, due: 0,
          ema: null,              // exponential moving average latency, ms
          best: null,             // fastest correct retrieval, ms
          confusions: {}          // wrongId -> count
        };
      }
      return this._data.items[id];
    },

    /* --- recording ------------------------------------------------------- */

    /**
     * @param {string}  id       from Progress.id()
     * @param {boolean} correct
     * @param {object}  meta     {mode, latencyMs, chosen}  — chosen = the id
     *                           the learner picked when wrong, if known
     */
    record(id, correct, meta) {
      meta = meta || {};
      const r = this._rec(id);
      const now = Date.now();

      r.reps++;
      if (r.first === null) r.first = now;
      r.last = now;

      if (correct) {
        r.correct++;
        r.box = Math.min(MAX_BOX, Math.max(1, r.box + 1));
        if (typeof meta.latencyMs === 'number' && meta.latencyMs > 0) {
          r.ema = r.ema === null ? meta.latencyMs
                                 : Math.round(r.ema + LATENCY_ALPHA * (meta.latencyMs - r.ema));
          if (r.best === null || meta.latencyMs < r.best) r.best = meta.latencyMs;
        }
      } else {
        r.lapses++;
        /* Drop two boxes, never below 1. A full reset to zero over-punishes an
           item that's mostly known and floods the queue with things the
           learner would have got right on the next attempt. */
        r.box = Math.max(1, r.box - 2);
        if (meta.chosen && meta.chosen !== id) {
          r.confusions[meta.chosen] = (r.confusions[meta.chosen] || 0) + 1;
        }
      }

      r.due = now + INTERVALS[r.box] * H;

      this._data.log.push({
        t: now, id, ok: !!correct,
        mode: meta.mode || null,
        ms: meta.latencyMs || null,
        chose: meta.chosen || null,
        box: r.box
      });
      if (this._data.log.length > 5000) this._data.log.splice(0, 1000);

      this._touchDay();
      this._save();
      return r;
    },

    /* --- state ----------------------------------------------------------- */

    /* unseen → never attempted
       learning → early boxes, still being built
       shaky → recently lapsed, needs repair before anything timed
       solid → spaced-survived and stable */
    state(id) {
      const r = this._data.items[id];
      if (!r || r.reps === 0) return 'unseen';
      const recentLapse = r.lapses > 0 && r.box <= 2 && (Date.now() - r.last) < SHAKY_WINDOW_H * H;
      if (recentLapse) return 'shaky';
      if (r.box >= 4) return 'solid';
      return 'learning';
    },

    /* Gate for the timed game. Serving un-fluent items under time pressure
       trains guessing speed, not retrieval speed. */
    isFluent(id) {
      const r = this._data.items[id];
      if (!r) return false;
      return r.box >= FLUENT_BOX && r.ema !== null && r.ema <= FLUENT_MS;
    },

    isDue(id, at) {
      const r = this._data.items[id];
      if (!r || r.reps === 0) return false;
      return (at || Date.now()) >= r.due;
    },

    record_(id) { return this._data.items[id] || null; },

    /* --- the queue ------------------------------------------------------- */

    /**
     * Next items to serve, most overdue first.
     * @param {number} n
     * @param {object} opts
     *   pool        array of ids to consider (default: everything seen)
     *   mixFamilies avoid adjacent items sharing a verb (default true)
     *   includeNew  top up with unseen ids from opts.pool (default true)
     *   fluentOnly  restrict to items that passed the fluency gate
     */
    due(n, opts) {
      opts = opts || {};
      const now = Date.now();
      const mix = opts.mixFamilies !== false;
      const pool = opts.pool || Object.keys(this._data.items);

      let ranked = pool
        .filter(id => {
          if (opts.fluentOnly && !this.isFluent(id)) return false;
          const r = this._data.items[id];
          return r && r.reps > 0 && now >= r.due;
        })
        .map(id => {
          const r = this._data.items[id];
          /* Overdue-ness is scaled by the interval it was waiting on, so a
             10-minute item an hour late doesn't outrank a month-long item a
             week late. Lapses nudge an item forward on top of that. */
          const span = Math.max(1, INTERVALS[r.box] * H);
          return { id, score: (now - r.due) / span + r.lapses * 0.4 };
        })
        .sort((a, b) => b.score - a.score)
        .map(x => x.id);

      if (opts.includeNew !== false && ranked.length < n && opts.pool) {
        const fresh = opts.pool.filter(id => this.state(id) === 'unseen');
        ranked = ranked.concat(shuffle(fresh));
      }

      return mix ? interleaveFamilies(ranked, this.verbOf).slice(0, n) : ranked.slice(0, n);
    },

    /* Items the learner has actually confused, most-confused first. Feeds the
       drill rounds in both games — a distractor set built from real errors is
       worth more than a random one. */
    confusionPairs(limit) {
      const out = [];
      Object.entries(this._data.items).forEach(([id, r]) => {
        Object.entries(r.confusions).forEach(([wrong, count]) => {
          out.push({ target: id, chosen: wrong, count });
        });
      });
      out.sort((a, b) => b.count - a.count);
      return limit ? out.slice(0, limit) : out;
    },

    /* --- summaries for the UI -------------------------------------------- */

    /* Pass the full id list for a family so unseen items are counted. */
    mastery(family, allIds) {
      const ids = allIds || Object.keys(this._data.items).filter(id => this.verbOf(id) === family);
      const tally = { unseen: 0, learning: 0, shaky: 0, solid: 0, total: ids.length };
      ids.forEach(id => tally[this.state(id)]++);
      tally.pct = tally.total ? Math.round((tally.solid / tally.total) * 100) : 0;
      tally.touched = tally.total - tally.unseen;
      return tally;
    },

    /* Same shape, grouped by particle instead of verb. This is the axis the
       verb tabs don't expose, and the one where the pattern lives. */
    particleMastery(particle, allIds) {
      const ids = (allIds || Object.keys(this._data.items))
        .filter(id => this.particleOf(id) === particle);
      return this.mastery(null, ids);
    },

    overall(allIds) {
      const ids = allIds || Object.keys(this._data.items);
      const m = this.mastery(null, ids);
      const seen = Object.values(this._data.items);
      const withEma = seen.filter(r => r.ema !== null);
      m.reps = seen.reduce((s, r) => s + r.reps, 0);
      m.accuracy = m.reps ? Math.round(seen.reduce((s, r) => s + r.correct, 0) / m.reps * 100) : 0;
      m.meanLatency = withEma.length
        ? Math.round(withEma.reduce((s, r) => s + r.ema, 0) / withEma.length) : null;
      m.dayStreak = this.dayStreak();
      m.sessions = this._data.sessions;
      return m;
    },

    /* --- day streak ------------------------------------------------------ */

    _touchDay() {
      const d = new Date().toISOString().slice(0, 10);
      const days = this._data.days;
      if (days[days.length - 1] !== d) days.push(d);
      if (days.length > 400) days.splice(0, days.length - 400);
    },

    dayStreak() {
      const days = this._data.days;
      if (!days.length) return 0;
      const oneDay = 864e5;
      let streak = 1;
      for (let i = days.length - 1; i > 0; i--) {
        const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / oneDay;
        if (gap === 1) streak++; else break;
      }
      /* Broken if the last recorded day is older than yesterday. */
      const lastGap = (Date.parse(new Date().toISOString().slice(0, 10)) -
                       Date.parse(days[days.length - 1])) / oneDay;
      return lastGap > 1 ? 0 : streak;
    },

    /* --- pilot instrumentation ------------------------------------------- */

    /* Everything the study design needs: per-attempt records with latency,
       plus the derived item states. Anonymous by construction — no name is
       ever stored, so tag the file at collection time. */
    exportJSON(label) {
      return JSON.stringify({
        label: label || null,
        exported: new Date().toISOString(),
        sessions: this._data.sessions,
        days: this._data.days,
        items: Object.fromEntries(
          Object.entries(this._data.items).map(([id, r]) => [id, {
            box: r.box, reps: r.reps, correct: r.correct, lapses: r.lapses,
            emaMs: r.ema, bestMs: r.best, state: this.state(id),
            fluent: this.isFluent(id), confusions: r.confusions
          }])
        ),
        attempts: this._data.log
      }, null, 2);
    },

    download(label) {
      const blob = new Blob([this.exportJSON(label)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (label || 'intuity') + '-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },

    reset() {
      this._store.clear();
      this._data = { version: 1, created: Date.now(), items: {}, log: [], days: [], sessions: 1 };
      this._save();
    },

    get data() { return this._data; },
    get persistent() { return this._store.persistent; }
  };

  /* --- helpers ----------------------------------------------------------- */

  function shuffle(a) {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }

  /* Greedy interleave: keep order as far as possible, but never put two items
     from the same verb family back to back. Similar items presented together
     cross-associate, which is precisely what the verb-tab layout encourages. */
  function interleaveFamilies(ids, familyOf) {
    const out = [];
    const pending = ids.slice();
    let lastFam = null;
    while (pending.length) {
      let idx = pending.findIndex(id => familyOf(id) !== lastFam);
      if (idx === -1) idx = 0;                 // only one family left — accept it
      const [picked] = pending.splice(idx, 1);
      out.push(picked);
      lastFam = familyOf(picked);
    }
    return out;
  }

  /* --- export ------------------------------------------------------------ */

  root.INTUITY = root.INTUITY || {};
  root.INTUITY.Progress = Progress;
  if (typeof module !== 'undefined' && module.exports) module.exports = Progress;

})(typeof window !== 'undefined' ? window : globalThis);
