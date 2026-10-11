const PHASE_CROSSFADE = 0.65;
const MENU_FADE = 0.35;
const LOOKAHEAD = 0.035;
const ULTIMATE_RECOVERY = 0.65;
const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const UI_SOUNDS = new Set(["click", "change", "achievement"]);
const VARIANTS = {
  attack: ["attack1", "attack2", "attack3"],
  killed: ["killed1", "killed2"],
};
const LEVELS = {
  attack: 0.38,
  killed: 0.5,
  damage: 0.7,
  click: 0.65,
  change: 0.7,
  achievement: 0.7,
};

/**
 * Music is one transport on the Web Audio sample clock. All five phase loops
 * start together; changing difficulty only automates their gains, so their
 * musical positions cannot drift. No timer or animation frame starts clips.
 */
export class GameAudio {
  constructor({ baseUrl, contextFactory, fetcher } = {}) {
    this.baseUrl = baseUrl ?? `${import.meta.env?.BASE_URL ?? "/"}audio/`;
    this._contextFactory =
      contextFactory ??
      (() => {
        const AudioContext =
          globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContext)
          throw new Error("This browser does not support Web Audio.");
        return new AudioContext({ latencyHint: "interactive" });
      });
    this._fetch = fetcher ?? ((...args) => fetch(...args));
    this.context = null;
    this.uiContext = null;
    this.buffers = new Map();
    this.manifest = null;
    this._ready = false;
    this._loading = null;
    this._menuMusicVolume = 0.7;
    this._gameMusicVolume = 0.5;
    this._sfxVolume = 0.8;
    this._menu = null;
    this._game = null;
    this._voices = new Set();
    this._lastVariant = {};
    this._lastUltimate = null;
    this._phaseTransitions = [];
    this._paused = false;
    this._transport = "idle";
  }

  get ready() {
    return this._ready;
  }
  get now() {
    return this.context?.currentTime ?? 0;
  }
  get debugState() {
    return {
      ready: this.ready,
      transport: this._transport,
      paused: this._paused,
      contextState: this.context?.state ?? "uninitialized",
      uiContextState: this.uiContext?.state ?? "uninitialized",
      now: this.now,
      loadedAssets: this.buffers.size,
      volumes: {
        menuMusic: this._menuMusicVolume,
        gameMusic: this._gameMusicVolume,
        sfx: this._sfxVolume,
      },
      menu: this._menu
        ? { startedAt: this._menu.startedAt, loopAt: this._menu.loopAt }
        : null,
      game: this._game
        ? {
            startedAt: this._game.startedAt,
            phaseAt: this._game.phaseAt,
            introDuration: this._game.introDuration,
            phase: this._game.phase,
            loopDuration: this._game.loopDuration,
            phaseStarts: this._game.phases.map((phase) => phase.startedAt),
            musicalPosition:
              Math.max(0, this.now - this._game.phaseAt) %
              this._game.loopDuration,
          }
        : null,
      phaseTransitions: this._phaseTransitions.map((transition) => ({
        ...transition,
      })),
      ultimate: this._lastUltimate ? { ...this._lastUltimate } : null,
    };
  }

  _ensureContext() {
    if (this.context) return;
    this.context = this._contextFactory();
    this.menuMusicGain = this.context.createGain();
    this.gameMusicGain = this.context.createGain();
    this.sfxGain = this.context.createGain();
    this.output = this.context.createDynamicsCompressor();
    this.output.threshold.value = -3;
    this.output.knee.value = 3;
    this.output.ratio.value = 16;
    this.output.attack.value = 0.003;
    this.output.release.value = 0.12;
    this.menuMusicGain.gain.value = this._menuMusicVolume;
    this.gameMusicGain.gain.value = this._gameMusicVolume;
    this.sfxGain.gain.value = this._sfxVolume;
    this.menuMusicGain.connect(this.output);
    this.gameMusicGain.connect(this.output);
    this.sfxGain.connect(this.output);
    this.output.connect(this.context.destination);

    // A tiny separate UI transport keeps pause-menu clicks audible while the
    // game clock (including an in-flight ultimate) is genuinely suspended.
    this.uiContext = this._contextFactory();
    this.uiGain = this.uiContext.createGain();
    this.uiGain.gain.value = this._sfxVolume;
    this.uiGain.connect(this.uiContext.destination);
  }

  /** Eager loading is safe before the first gesture. Failed loads may be retried. */
  async init(onProgress) {
    if (this.ready) {
      onProgress?.(1, "ready");
      return this;
    }
    if (this._loading) return this._loading;
    this._ensureContext();
    this._loading = this._load(onProgress);
    try {
      await this._loading;
      this._ready = true;
      return this;
    } finally {
      this._loading = null;
    }
  }

  async _load(onProgress) {
    const response = await this._fetch(`${this.baseUrl}manifest.json`);
    if (!response.ok)
      throw new Error(`Audio manifest failed (${response.status}).`);
    this.manifest = await response.json();
    const assets = Object.entries(this.manifest.assets);
    let cursor = 0;
    let completed = 0;
    onProgress?.(0, "manifest");
    const worker = async () => {
      while (cursor < assets.length) {
        const [key, asset] = assets[cursor++];
        if (!this.buffers.has(key)) {
          const file = await this._fetch(`${this.baseUrl}${asset.file}`);
          if (!file.ok)
            throw new Error(`Audio ${key} failed (${file.status}).`);
          const buffer = await this.context.decodeAudioData(
            await file.arrayBuffer(),
          );
          // decodeAudioData may resample to the device rate; allow one frame.
          if (
            Math.abs(buffer.duration - asset.duration) >
            1.5 / buffer.sampleRate
          ) {
            throw new Error(`Audio duration changed while decoding ${key}.`);
          }
          this.buffers.set(key, buffer);
        }
        completed += 1;
        onProgress?.(completed / assets.length, key);
      }
    };
    // Wait for every worker even on failure, so retry cannot race an old load.
    const results = await Promise.allSettled(Array.from({ length: 4 }, worker));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const durations = [1, 2, 3, 4, 5].map(
      (i) => this.buffers.get(`phase${i}`).duration,
    );
    if (durations.some((duration) => duration !== durations[0])) {
      throw new Error(
        "The five music phases must have identical decoded lengths.",
      );
    }
  }

  /** Call directly in a pointer/key handler; resume happens before any await. */
  async unlock() {
    this._ensureContext();
    const contexts = this._paused
      ? [this.uiContext]
      : [this.context, this.uiContext];
    const resumes = contexts.map((context) => {
      if (context.state === "running") return Promise.resolve();
      const resumed = context.resume();
      const silent = context.createBufferSource();
      silent.buffer = context.createBuffer(1, 1, context.sampleRate);
      silent.connect(context.destination);
      silent.start(0);
      silent.onended = () => silent.disconnect();
      return resumed;
    });
    await Promise.all(resumes);
    return this;
  }

  _source(
    key,
    destination,
    when,
    { loop = false, context = this.context, offset = 0 } = {},
  ) {
    const buffer = this.buffers.get(key);
    if (!buffer) return null;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    if (loop) {
      source.loopStart = 0;
      source.loopEnd = buffer.duration;
    }
    source.connect(destination);
    source.start(when, offset);
    source.onended = () => source.disconnect();
    return source;
  }

  _hold(param, time, fallback = param.value) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(time);
    else {
      param.cancelScheduledValues(time);
      param.setValueAtTime(fallback, time);
    }
  }

  _stopGroup(group, fade = 0) {
    if (!group) return;
    const now = this.now;
    this._hold(group.gain.gain, now);
    group.gain.gain.linearRampToValueAtTime(0, now + fade);
    for (const source of group.sources) {
      try {
        source.stop(now + fade);
      } catch {
        /* Already ended. */
      }
    }
    const last = group.sources[group.sources.length - 1];
    if (last) {
      const cleanup = last.onended;
      last.onended = () => {
        cleanup?.();
        group.gain.disconnect();
      };
    } else group.gain.disconnect();
  }

  _group(channel) {
    const gain = this.context.createGain();
    gain.connect(channel === "menu" ? this.menuMusicGain : this.gameMusicGain);
    return { gain, sources: [] };
  }

  playMenu() {
    if (!this.ready) return null;
    if (this._menu)
      return { startedAt: this._menu.startedAt, loopAt: this._menu.loopAt };
    this.stopGame();
    const group = this._group("menu");
    const startedAt = this.now + LOOKAHEAD;
    const loopAt = startedAt + this.buffers.get("menuFill").duration;
    group.sources.push(this._source("menuFill", group.gain, startedAt));
    group.sources.push(
      this._source("menu", group.gain, loopAt, { loop: true }),
    );
    this._menu = { ...group, startedAt, loopAt };
    this._transport = "menu";
    return { startedAt, loopAt };
  }

  startGame() {
    if (!this.ready)
      throw new Error("Audio must finish loading before starting a game.");
    this._stopGroup(this._menu, MENU_FADE);
    this._menu = null;
    this.stopGame();
    const group = this._group("game");
    const startedAt = this.now + LOOKAHEAD;
    const introDuration = this.buffers.get("gameStart").duration;
    const phaseAt = startedAt + introDuration;
    group.sources.push(this._source("gameStart", group.gain, startedAt));
    const phases = [1, 2, 3, 4, 5].map((phase) => {
      const gain = this.context.createGain();
      gain.gain.value = phase === 1 ? 1 : 0;
      gain.connect(group.gain);
      const source = this._source(`phase${phase}`, gain, phaseAt, {
        loop: true,
      });
      const defaultCleanup = source.onended;
      source.onended = () => {
        defaultCleanup();
        gain.disconnect();
      };
      group.sources.push(source);
      return {
        gain,
        source,
        startedAt: phaseAt,
        ramp: {
          start: 0,
          end: 0,
          from: phase === 1 ? 1 : 0,
          to: phase === 1 ? 1 : 0,
        },
      };
    });
    this._game = {
      ...group,
      phases,
      startedAt,
      introDuration,
      phaseAt,
      phase: 1,
      loopDuration: this.buffers.get("phase1").duration,
    };
    this._phaseTransitions = [];
    this._lastUltimate = null;
    this._transport = "game";
    return { startedAt, phaseAt, introDuration };
  }

  setPhase(value) {
    const phase = Math.max(1, Math.min(5, Math.floor(Number(value) || 1)));
    if (!this._game || this._game.phase === phase) return;
    const start = Math.max(this.now + 0.01, this._game.phaseAt);
    const end = start + PHASE_CROSSFADE;
    for (let i = 0; i < this._game.phases.length; i += 1) {
      const stem = this._game.phases[i];
      const ramp = stem.ramp;
      const progress =
        ramp.end > ramp.start
          ? Math.min(
              1,
              Math.max(0, (start - ramp.start) / (ramp.end - ramp.start)),
            )
          : 1;
      const current = ramp.from + (ramp.to - ramp.from) * progress;
      const target = i + 1 === phase ? 1 : 0;
      // Linear, constant-sum fades preserve correlated shared musical elements.
      this._hold(stem.gain.gain, start, current);
      stem.gain.gain.setValueAtTime(current, start);
      stem.gain.gain.linearRampToValueAtTime(target, end);
      stem.ramp = { start, end, from: current, to: target };
    }
    this._phaseTransitions.push({
      from: this._game.phase,
      to: phase,
      start,
      end,
      offset: (start - this._game.phaseAt) % this._game.loopDuration,
    });
    this._phaseTransitions = this._phaseTransitions.slice(-12);
    this._game.phase = phase;
  }

  playSfx(name) {
    if (!this.ready) return null;
    const category = String(name).toLowerCase();
    const variants = VARIANTS[category];
    let key = category;
    if (variants) {
      const candidates = variants.filter(
        (variant) => variant !== this._lastVariant[category],
      );
      key = candidates[Math.floor(Math.random() * candidates.length)];
      this._lastVariant[category] = key;
    }
    if (!this.buffers.has(key)) return null;
    const isUI = UI_SOUNDS.has(category);
    if (this._paused && !isUI) return null;
    const context = isUI ? this.uiContext : this.context;
    const destination = isUI ? this.uiGain : this.sfxGain;
    const voices = [...this._voices].filter(
      (voice) => voice.category === category,
    );
    const limit = category === "attack" ? 5 : category === "killed" ? 6 : 3;
    if (voices.length >= limit) this._stopVoice(voices[0]);
    const gain = context.createGain();
    gain.gain.value = LEVELS[category] ?? 0.7;
    gain.connect(destination);
    const when = context.currentTime + 0.003;
    const source = this._source(key, gain, when, { context });
    const voice = { source, gain, context, category, isUI };
    this._voices.add(voice);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      this._voices.delete(voice);
    };
    return { key, start: when, duration: this.buffers.get(key).duration };
  }

  _stopVoice(voice) {
    const now = voice.context.currentTime;
    this._hold(voice.gain.gain, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + 0.02);
    try {
      voice.source.stop(now + 0.021);
    } catch {
      /* Already ended. */
    }
    this._voices.delete(voice);
  }

  playUltimate() {
    if (!this.ready || this._paused) return null;
    const start = this.now + LOOKAHEAD;
    const chargeDuration = this.buffers.get("ultimateCharge").duration;
    const burstDuration = this.buffers.get("ultimateBurst").duration;
    const explosionDuration = this.buffers.get("ultimateExplosion").duration;
    const burstAt = start + chargeDuration;
    const explosionAt = burstAt + burstDuration;
    const audioEnd = explosionAt + explosionDuration;
    for (const [key, at] of [
      ["ultimateCharge", start],
      ["ultimateBurst", burstAt],
      ["ultimateExplosion", explosionAt],
    ]) {
      const gain = this.context.createGain();
      gain.gain.value = 0.8;
      gain.connect(this.sfxGain);
      const source = this._source(key, gain, at);
      const voice = {
        source,
        gain,
        context: this.context,
        category: "ultimate",
        isUI: false,
      };
      this._voices.add(voice);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        this._voices.delete(voice);
      };
    }
    this._lastUltimate = {
      start,
      startAt: start,
      burstAt,
      explosionAt,
      audioEnd,
      end: audioEnd + ULTIMATE_RECOVERY,
      endAt: audioEnd + ULTIMATE_RECOVERY,
      chargeDuration,
      burstDuration,
      explosionDuration,
      recoveryDuration: ULTIMATE_RECOVERY,
    };
    return { ...this._lastUltimate };
  }

  stopGame() {
    this._stopGroup(this._game, 0.12);
    this._game = null;
    for (const voice of [...this._voices])
      if (!voice.isUI) this._stopVoice(voice);
    if (!this._menu) this._transport = "idle";
  }

  async pause() {
    this._paused = true;
    if (this.context?.state === "running") await this.context.suspend();
  }

  async resume() {
    this._paused = false;
    if (this.context && this.context.state !== "running")
      await this.context.resume();
  }

  setVolumes({ menuMusic, gameMusic, sfx } = {}) {
    if (menuMusic !== undefined) {
      this._menuMusicVolume = clamp01(menuMusic);
      this.menuMusicGain?.gain.setTargetAtTime(
        this._menuMusicVolume,
        this.now,
        0.025,
      );
    }
    if (gameMusic !== undefined) {
      this._gameMusicVolume = clamp01(gameMusic);
      this.gameMusicGain?.gain.setTargetAtTime(
        this._gameMusicVolume,
        this.now,
        0.025,
      );
    }
    if (sfx !== undefined) {
      this._sfxVolume = clamp01(sfx);
      this.sfxGain?.gain.setTargetAtTime(this._sfxVolume, this.now, 0.025);
      this.uiGain?.gain.setTargetAtTime(
        this._sfxVolume,
        this.uiContext.currentTime,
        0.025,
      );
    }
  }

  async dispose() {
    this._stopGroup(this._menu);
    this._menu = null;
    this.stopGame();
    for (const voice of [...this._voices]) this._stopVoice(voice);
    await Promise.allSettled([this.context?.close(), this.uiContext?.close()]);
    this._ready = false;
  }
}
