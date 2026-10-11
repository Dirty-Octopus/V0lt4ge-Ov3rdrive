import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GameAudio } from "../src/audio.js";

const manifest = JSON.parse(
  await readFile(
    new URL("../public/audio/manifest.json", import.meta.url),
    "utf8",
  ),
);

class Param {
  constructor() {
    this.value = 1;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.value = value;
    this.events.push({ method: "set", value, time });
  }
  linearRampToValueAtTime(value, time) {
    this.events.push({ method: "ramp", value, time });
  }
  setTargetAtTime(value, time) {
    this.value = value;
    this.events.push({ method: "target", value, time });
  }
  cancelScheduledValues() {}
  cancelAndHoldAtTime() {}
}
class Node {
  connect(node) {
    this.destination = node;
  }
  disconnect() {
    this.disconnected = true;
  }
}
class Context {
  constructor() {
    this.currentTime = 10;
    this.sampleRate = 44100;
    this.state = "suspended";
    this.destination = {};
    this.sources = [];
  }
  createGain() {
    const node = new Node();
    node.gain = new Param();
    return node;
  }
  createDynamicsCompressor() {
    const node = new Node();
    for (const key of ["threshold", "knee", "ratio", "attack", "release"])
      node[key] = new Param();
    return node;
  }
  createBufferSource() {
    const node = new Node();
    node.start = (when, offset = 0) => {
      node.startedAt = when;
      node.offset = offset;
    };
    node.stop = (when) => {
      node.stoppedAt = when;
    };
    this.sources.push(node);
    return node;
  }
  createBuffer() {
    return { duration: 1 / this.sampleRate, sampleRate: this.sampleRate };
  }
  async decodeAudioData(data) {
    return JSON.parse(new TextDecoder().decode(data));
  }
  async resume() {
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
  async close() {
    this.state = "closed";
  }
}

function setup(fetchOverride) {
  const contexts = [];
  const fetcher = async (url) => {
    const override = fetchOverride?.(url);
    if (override) return override;
    if (url.endsWith("manifest.json"))
      return { ok: true, json: async () => manifest };
    const asset = Object.values(manifest.assets).find((entry) =>
      url.endsWith(entry.file),
    );
    assert.ok(asset, `Unknown audio URL: ${url}`);
    return {
      ok: true,
      arrayBuffer: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            duration: asset.duration,
            sampleRate: asset.sampleRate,
          }),
        ).buffer,
    };
  };
  const audio = new GameAudio({
    baseUrl: "/test/audio/",
    fetcher,
    contextFactory: () => {
      const context = new Context();
      contexts.push(context);
      return context;
    },
  });
  return { audio, contexts };
}

test("menu and game music use independent defaults and buses during the menu fade", async () => {
  const { audio, contexts } = setup();
  assert.deepEqual(audio.debugState.volumes, {
    menuMusic: 0.7,
    gameMusic: 0.5,
    sfx: 0.8,
  });
  await audio.init();
  audio.playMenu();
  const [menuFill, menuLoop] = contexts[0].sources;
  const menuGroup = menuFill.destination;
  assert.equal(menuGroup.destination, audio.menuMusicGain);
  assert.equal(menuLoop.destination, menuGroup);
  const timing = audio.startGame();
  const intro = contexts[0].sources[2];
  assert.equal(intro.destination.destination, audio.gameMusicGain);
  assert.notEqual(menuGroup.destination, intro.destination.destination);
  assert.equal(audio.menuMusicGain.gain.value, 0.7);
  assert.equal(audio.gameMusicGain.gain.value, 0.5);
  assert.deepEqual(menuGroup.gain.events.at(-1), {
    method: "ramp",
    value: 0,
    time: 10.35,
  });

  audio.setVolumes({ gameMusic: 0.22 });
  assert.equal(audio.gameMusicGain.gain.value, 0.22);
  assert.equal(
    audio.menuMusicGain.gain.value,
    0.7,
    "game slider must not change the fading menu level",
  );
  assert.equal(audio.menuMusicGain.gain.events.length, 0);
  audio.setVolumes({ menuMusic: 0.91 });
  assert.equal(audio.menuMusicGain.gain.value, 0.91);
  assert.equal(
    audio.gameMusicGain.gain.value,
    0.22,
    "menu slider must not change gameplay music",
  );
  assert.equal(audio.gameMusicGain.gain.events.length, 1);
  assert.ok(menuFill.stoppedAt === 10.35 && menuLoop.stoppedAt === 10.35);
  assert.equal(
    contexts[0].sources.length,
    8,
    "volume controls must not replace musical sources",
  );
  assert.ok(
    audio.debugState.game.phaseStarts.every(
      (start) => start === timing.phaseAt,
    ),
  );
  assert.equal(audio.sfxGain.gain.value, 0.8);
  assert.equal(audio.uiGain.gain.value, 0.8);
});

test("saved split volumes can be restored before initialization and partial updates preserve other controls", async () => {
  const { audio } = setup();
  audio.setVolumes({ menuMusic: 0.31, gameMusic: 0.46, sfx: 0.62 });
  await audio.init();
  assert.equal(audio.menuMusicGain.gain.value, 0.31);
  assert.equal(audio.gameMusicGain.gain.value, 0.46);
  assert.equal(audio.sfxGain.gain.value, 0.62);
  assert.equal(audio.uiGain.gain.value, 0.62);
  audio.setVolumes({ menuMusic: 2, gameMusic: -1 });
  assert.deepEqual(audio.debugState.volumes, {
    menuMusic: 1,
    gameMusic: 0,
    sfx: 0.62,
  });
});

test("menu fill and repeating menu are scheduled once at their exact sample boundary", async () => {
  const { audio, contexts } = setup();
  await audio.init();
  const timing = audio.playMenu();
  assert.equal(timing.loopAt, timing.startedAt + 26460 / 44100);
  const [fill, loop] = contexts[0].sources;
  assert.equal(fill.startedAt + fill.buffer.duration, loop.startedAt);
  assert.equal(loop.loop, true);
  assert.equal(loop.loopEnd, 846720 / 44100);
  audio.playMenu();
  assert.equal(
    contexts[0].sources.length,
    2,
    "repeated UI activation must not layer menu loops",
  );
});

test("every phase stays on one transport across loop wrap and rapid phase changes", async () => {
  const { audio, contexts } = setup();
  await audio.init();
  audio.playMenu();
  const menuSources = [...contexts[0].sources];
  const timing = audio.startGame();
  assert.equal(timing.phaseAt, timing.startedAt + 58800 / 44100);
  assert.ok(menuSources.every((source) => source.stoppedAt === 10.35));
  const phases = contexts[0].sources.filter(
    (source) => source.loop && source.buffer.duration === 940800 / 44100,
  );
  assert.equal(phases.length, 5);
  assert.ok(
    phases.every(
      (source) => source.startedAt === timing.phaseAt && source.offset === 0,
    ),
  );
  const sourceCount = contexts[0].sources.length;
  contexts[0].currentTime = timing.phaseAt + 2 * (940800 / 44100) + 3.2;
  audio.setPhase(2);
  contexts[0].currentTime += 0.12;
  audio.setPhase(5);
  assert.equal(
    contexts[0].sources.length,
    sourceCount,
    "switching phases must never restart a loop",
  );
  const { game, phaseTransitions } = audio.debugState;
  assert.equal(game.phase, 5);
  assert.ok(Math.abs(phaseTransitions[0].offset - 3.21) < 1e-8);
  assert.ok(
    phaseTransitions.every(
      (transition) => Math.abs(transition.end - transition.start - 0.65) < 1e-8,
    ),
  );
  const targetGains = phases.map(
    (source) => source.destination.gain.events.at(-1).value,
  );
  assert.deepEqual(targetGains, [0, 0, 0, 0, 1]);
});

test("ultimate boundaries contain zero scheduling gaps and expose recovery separately", async () => {
  const { audio, contexts } = setup();
  await audio.init();
  const timing = audio.playUltimate();
  const [charge, burst, explosion] = contexts[0].sources;
  assert.equal(charge.startedAt + charge.buffer.duration, burst.startedAt);
  assert.equal(burst.startedAt + burst.buffer.duration, explosion.startedAt);
  assert.equal(
    timing.audioEnd,
    explosion.startedAt + explosion.buffer.duration,
  );
  assert.equal(timing.endAt, timing.audioEnd + 0.65);
  assert.equal(timing.startAt, timing.start);
  assert.equal(timing.endAt, timing.end);
});

test("pausing freezes the game context while UI interactions remain audible", async () => {
  const { audio, contexts } = setup();
  await audio.init();
  await audio.unlock();
  await audio.pause();
  assert.equal(contexts[0].state, "suspended");
  assert.equal(contexts[1].state, "running");
  const mainCount = contexts[0].sources.length;
  const uiCount = contexts[1].sources.length;
  audio.playSfx("click");
  assert.equal(contexts[1].sources.length, uiCount + 1);
  assert.equal(audio.playSfx("attack"), null);
  assert.equal(contexts[0].sources.length, mainCount);
  await audio.unlock();
  assert.equal(
    contexts[0].state,
    "suspended",
    "UI unlock must not accidentally unpause the game",
  );
  await audio.resume();
  assert.equal(contexts[0].state, "running");
});

test("a failed fetch can be retried and previous decoded assets stay usable", async () => {
  let fail = true;
  const { audio } = setup((url) =>
    url.endsWith("phase3.flac") && fail ? { ok: false, status: 503 } : null,
  );
  await assert.rejects(audio.init(), /phase3 failed/);
  assert.equal(audio.ready, false);
  const previouslyLoaded = audio.buffers.size;
  assert.ok(previouslyLoaded > 0);
  fail = false;
  const progress = [];
  await audio.init((value) => progress.push(value));
  assert.equal(audio.ready, true);
  assert.equal(audio.buffers.size, 20);
  assert.equal(progress.at(-1), 1);
});
