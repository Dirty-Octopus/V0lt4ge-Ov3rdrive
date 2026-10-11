import "./style.css";
import { GameAudio } from "./audio.js";
import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { copy } from "./i18n.js";
import { TextScramble } from "./text-scramble.js";

const $ = (s) => document.querySelector(s);
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("voltage-save") || "{}");
  } catch {
    return {};
  }
})();
const prefs = {
  lang: "zh",
  difficulty: "normal",
  menuMusic: 0.7,
  gameMusic: 0.5,
  sfx: 0.8,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  ...saved.prefs,
};
// The former shared volume must not overwrite the two new defaults.
delete prefs.music;
if (!["zh", "en"].includes(prefs.lang)) prefs.lang = "zh";
let best = Number(saved.best) || 0;
const achievements = new Set(saved.achievements || []);
const persist = () => {
  try {
    localStorage.setItem(
      "voltage-save",
      JSON.stringify({ prefs, best, achievements: [...achievements] }),
    );
  } catch {
    /* Private mode still allows play. */
  }
};
let mode = "menu",
  menuAudio = false,
  starting = false,
  loading = true,
  loadFailed = false,
  loadProgress = 0,
  introTiming = null,
  lastFrame = performance.now(),
  touchMove = 0,
  fireHeld = false,
  ultimateQueued = false;
let modalReturn = null,
  focusReturn = null,
  phaseTimer,
  toastTimer;
const keys = new Set();
const audio = new GameAudio();
const t = (key) => copy[prefs.lang][key] || key;
const logoLetters = (word) =>
  [...word]
    .map((letter) => {
      const alternate = letter === "4" ? "A" : letter === "3" ? "E" : null;
      if (!alternate) return `<span class="logo-letter">${letter}</span>`;
      return `<span class="logo-cube ${letter === "3" ? "cube-horizontal" : "cube-vertical"}" data-from="${letter}" data-to="${alternate}"><span class="cube-sizer">${letter}</span><span class="cube-window"><span class="cube-stage"><span class="cube-rotor"><span class="cube-face cube-front"><span class="cube-glyph">${letter}</span></span><span class="cube-face cube-alternate"><span class="cube-glyph">${alternate}</span></span></span></span></span></span>`;
    })
    .join("");
const app = $("#app");
app.innerHTML = `
  <canvas id="world" aria-label="像素管道战场"></canvas>
  <div class="print-grain" aria-hidden="true"></div>
  <section id="menu" class="menu">
    <header class="masthead"><span class="publisher">DIRTY OCTOPUS<span class="publisher-mark">↯</span></span><div class="top-actions"><button id="audio-toggle" class="micro-button"></button><button id="lang-toggle" class="micro-button" aria-label="切换语言 / Change language">EN / 中</button><button id="fullscreen" class="micro-button">↗ <span data-i18n="fullscreen"></span></button></div></header>
    <img class="hero-art" src="./art/fire-mage.png" alt="" draggable="false" />
    <div class="menu-content"><div class="edition"><span class="slash">//</span><span data-i18n="brand"></span><span class="edition-rule"></span></div>
      <h1 id="game-logo" class="logo-build" aria-label="V0LT4GE OV3RDRIVE"><span class="voltage" aria-hidden="true">${logoLetters("V0LT4GE")}</span><span class="overdrive" aria-hidden="true">${logoLetters("OV3RDRIVE")}</span></h1>
      <nav class="main-nav" aria-label="主菜单"><button id="play" class="play-button" disabled><span class="play-arrow">▶</span><span data-i18n="play"></span><kbd>ENTER</kbd></button>
      <button data-open="settings" class="menu-link"><span data-i18n="settings"></span><span>↗</span></button>
      <button data-open="guide" class="menu-link"><span data-i18n="guide"></span><span>↗</span></button>
      <button data-open="records" class="menu-link"><span data-i18n="records"></span><span id="record-count"></span></button></nav>
      <div class="load-status"><span id="load-label"></span><span class="load-track"><i id="load-bar"></i></span></div>
    </div>
    <footer class="menu-footer"><div class="control-summary"><span><kbd>WASD</kbd> / <kbd>← →</kbd> <b data-i18n="move"></b></span><span><kbd>J / Z</kbd> <b data-i18n="attack"></b></span><span><kbd>K / X</kbd> <b data-i18n="ultimate"></b></span></div><div class="best-score"><span data-i18n="best"></span><strong id="menu-best">000000</strong></div></footer>
  </section>
  <section id="hud" class="hud" hidden>
    <div class="hud-top"><div class="health-block"><div class="hud-label"><span data-i18n="hp"></span><strong id="hp-number">100</strong><small>/ 100</small></div><div class="health-track"><i id="hp-fill"></i></div><span id="invincible" data-i18n="fullHeal" hidden></span></div>
    <div class="score-block"><span data-i18n="score"></span><strong id="score-number">000000</strong><small><span data-i18n="kills"></span> <b id="kills-number">0</b></small></div><button id="pause-button" class="pause-button" aria-label="暂停 / Pause">Ⅱ</button></div>
    <div class="phase-hud"><strong id="phase-number">01</strong><div><span id="phase-name"></span><div id="phase-pips" class="phase-pips"></div></div></div>
    <div class="hud-bottom"><div class="desktop-hint"><kbd>A D / ← →</kbd><span data-i18n="move"></span><kbd>J / Z</kbd><span data-i18n="attack"></span></div><div class="ultimate-block"><span class="ultimate-key">K / X</span><div class="ultimate-meta"><strong data-i18n="ultimate"></strong><span id="ultimate-status"></span><div class="ultimate-track"><i id="ultimate-fill"></i></div></div><strong id="ultimate-number">100%</strong></div></div>
    <div class="touch-controls"><span data-i18n="swipe"></span><button id="touch-fire" class="touch-fire"><b>✦</b><span data-i18n="attack"></span></button><button id="touch-ultimate" class="touch-ultimate"><b>↯</b><span data-i18n="ultimate"></span></button></div>
  </section>
  <div id="phase-banner" class="phase-banner" aria-live="polite"></div>
  <div id="achievement-toast" class="achievement-toast" role="status"></div>
  <dialog id="overlay"><div id="dialog-content"></div></dialog>
`;
$(".hero-art").addEventListener("error", () =>
  $(".hero-art").classList.add("unavailable"),
);
const renderer = new Renderer($("#world"));
const game = new Game({ onEvent: onGameEvent });
const textScramble = new TextScramble(app);
function applyVolumes() {
  audio.setVolumes({
    menuMusic: prefs.menuMusic,
    gameMusic: prefs.gameMusic,
    sfx: prefs.sfx,
  });
}
applyVolumes();

function updateCopy() {
  if (prefs.reducedMotion) textScramble.cancel();
  document.documentElement.lang = prefs.lang === "zh" ? "zh-CN" : "en";
  document
    .querySelectorAll("[data-i18n]")
    .forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $("#audio-toggle").textContent = t(menuAudio ? "soundReady" : "soundOn");
  $("#menu-best").textContent = String(best).padStart(6, "0");
  $("#record-count").textContent = `${achievements.size} / 5`;
  $("#load-label").textContent = loadFailed
    ? t("loadError")
    : loading
      ? `${t("loading")} ${Math.round(loadProgress * 100)}%`
      : t("ready");
  document.documentElement.dataset.motion = prefs.reducedMotion
    ? "reduced"
    : "full";
}
function changeLanguage() {
  audio.playSfx("change");
  const focusedId = document.activeElement?.id;
  textScramble.transition(
    () => {
      prefs.lang = prefs.lang === "zh" ? "en" : "zh";
      updateCopy();
      if (mode !== "menu") updateHud();
      if ($("#overlay").open) showDialog($("#overlay").dataset.kind);
      if (focusedId)
        document.getElementById(focusedId)?.focus({ preventScroll: true });
    },
    { reducedMotion: prefs.reducedMotion },
  );
  persist();
}
async function enableAudio() {
  try {
    await audio.unlock();
    if (
      !menuAudio &&
      !loading &&
      !loadFailed &&
      audio.ready &&
      mode === "menu"
    ) {
      menuAudio = Boolean(audio.playMenu());
      updateCopy();
    }
  } catch (e) {
    console.warn("Audio unlock:", e);
  }
}
async function loadAudio() {
  loading = true;
  loadFailed = false;
  updateCopy();
  try {
    await audio.init((progress) => {
      loadProgress = progress;
      $("#load-bar").style.transform = `scaleX(${progress})`;
      updateCopy();
    });
    loading = false;
    $("#play").disabled = false;
    updateCopy();
    // Attempt normal autoplay when this origin already has browser permission.
    // In a fresh Chrome profile resume() stays pending until a trusted gesture;
    // loading and the interface must never wait on that promise.
    void enableAudio();
  } catch (error) {
    loading = false;
    loadFailed = true;
    updateCopy();
    console.error(error);
  }
}
document.addEventListener(
  "pointerdown",
  () => {
    void enableAudio();
  },
  { passive: true },
);
document.addEventListener(
  "keydown",
  () => {
    void enableAudio();
  },
  { capture: true },
);
document.addEventListener(
  "click",
  (event) => {
    if (
      event.target.closest("button, input, label[for]") &&
      !event.target.closest(".touch-controls")
    )
      audio.playSfx("click");
  },
  true,
);
$("#audio-toggle").onclick = () =>
  loadFailed ? loadAudio().then(enableAudio) : enableAudio();
$("#load-label").onclick = () => {
  if (loadFailed) void loadAudio();
};
$("#lang-toggle").onclick = changeLanguage;
$("#fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await app.requestFullscreen();
  } catch {
    /* Unavailable on some mobile browsers. */
  }
};

function banner(html, duration = 1600) {
  clearTimeout(phaseTimer);
  $("#phase-banner").innerHTML = html;
  $("#phase-banner").classList.add("visible");
  phaseTimer = setTimeout(
    () => $("#phase-banner").classList.remove("visible"),
    duration,
  );
}
function unlockAchievement(id) {
  if (achievements.has(id)) return;
  achievements.add(id);
  persist();
  audio.playSfx("achievement");
  updateCopy();
  clearTimeout(toastTimer);
  $("#achievement-toast").innerHTML =
    `<span>✦ ${t("unlocked")}</span><strong>${t(id)}</strong>`;
  $("#achievement-toast").classList.add("visible");
  toastTimer = setTimeout(
    () => $("#achievement-toast").classList.remove("visible"),
    3500,
  );
}
function onGameEvent(event) {
  renderer?.onEvent(event);
  if (event.type === "shot") audio.playSfx("attack");
  if (event.type === "kill") {
    audio.playSfx("killed");
    if (!event.obstacle) unlockAchievement("first");
    if (game.kills >= 25) unlockAchievement("ten");
  }
  if (event.type === "damage") audio.playSfx("damage");
  if (event.type === "phase") {
    audio.setPhase(game.phase);
    banner(
      `<small>${t("phase")} / 0${game.phase}</small><strong>${t("phaseNames")[game.phase - 1]}</strong>`,
    );
    if (game.phase === 5) unlockAchievement("depth");
  }
  if (event.type === "ultimate-request") {
    game.setUltimate(audio.playUltimate());
    unlockAchievement("overload");
  }
  if (event.type === "ultimate-burst")
    banner(`<small>ULTIMATE</small><strong>${t("ultimate")}</strong>`, 550);
  if (event.type === "gameover") finishRun();
}
async function startRun() {
  if (loading || loadFailed || starting || mode === "intro") return;
  starting = true;
  closeDialog();
  await audio.unlock();
  keys.clear();
  fireHeld = false;
  ultimateQueued = false;
  touchMove = 0;
  game.start(prefs.difficulty);
  introTiming = await audio.startGame();
  menuAudio = false;
  mode = "intro";
  transitionLayer($("#menu"), false);
  transitionLayer($("#hud"), true);
  app.dataset.mode = "playing";
  banner(
    `<small>V0LT4GE OV3RDRIVE</small><strong>${t("intro")}</strong>`,
    1100,
  );
  starting = false;
}
function finishRun() {
  mode = "gameover";
  keys.clear();
  fireHeld = false;
  audio.stopGame();
  if (game.score > best) {
    best = game.score;
    persist();
  }
  showDialog("gameover");
}
function pauseRun() {
  if (!["playing", "intro"].includes(mode)) return;
  modalReturn = mode;
  mode = "paused";
  keys.clear();
  fireHeld = false;
  touchMove = 0;
  void audio.pause();
  showDialog("pause");
}
async function resumeRun() {
  await audio.resume();
  mode = modalReturn || "playing";
  modalReturn = null;
  closeDialog();
  lastFrame = performance.now();
}
async function returnMenu() {
  closeDialog();
  audio.stopGame();
  await audio.resume();
  mode = "menu";
  introTiming = null;
  menuAudio = false;
  modalReturn = null;
  keys.clear();
  fireHeld = false;
  touchMove = 0;
  transitionLayer($("#hud"), false);
  transitionLayer($("#menu"), true);
  playLogoReveal();
  app.dataset.mode = "menu";
  $("#phase-banner").classList.remove("visible");
  await enableAudio();
  updateCopy();
}
function closeDialog() {
  if ($("#overlay").open) $("#overlay").close();
  focusReturn?.focus({ preventScroll: true });
}
function transitionLayer(element, visible) {
  element.getAnimations().forEach((animation) => animation.cancel());
  element.inert = !visible;
  element.hidden = false;
  if (prefs.reducedMotion) {
    element.hidden = !visible;
    return;
  }
  const animation = element.animate(
    visible
      ? [
          { opacity: 0, transform: "translateY(12px)" },
          { opacity: 1, transform: "translateY(0)" },
        ]
      : [
          { opacity: 1, transform: "translateY(0)" },
          { opacity: 0, transform: "translateY(-16px)" },
        ],
    {
      duration: visible ? 420 : 300,
      easing: "cubic-bezier(.16,1,.3,1)",
      fill: "both",
    },
  );
  animation.finished
    .then(() => {
      element.hidden = !visible;
      animation.cancel();
    })
    .catch(() => {});
}
function playLogoReveal() {
  const logo = $("#game-logo");
  logo.classList.remove("logo-build");
  void logo.offsetWidth;
  logo.classList.add("logo-build");
}
function dialogHeader(title, kind) {
  const index = { settings: "01", guide: "02", records: "03" }[kind] || "//";
  return `<header class="dialog-heading" data-entry><span class="dialog-index" aria-hidden="true">${index}</span><div class="dialog-title-wrap"><h2 id="dialog-title">${title}</h2></div></header>`;
}
function showDialog(kind) {
  const overlay = $("#overlay");
  if (!overlay.open) focusReturn = document.activeElement;
  let html = "";
  if (kind === "settings")
    html =
      dialogHeader(t("settings"), kind) +
      `
    <div class="settings-layout">
      <div class="setting-row difficulty-row" data-entry><label>${t("difficulty")}</label><div class="segmented">${["easy", "normal", "hard"].map((d) => `<button data-difficulty="${d}" class="${prefs.difficulty === d ? "selected" : ""}" aria-pressed="${prefs.difficulty === d}" ${mode === "paused" ? "disabled" : ""}>${t(d)}</button>`).join("")}</div><p>${t("difficultyNote")}</p></div>
      <div class="volume-bank">
        ${["menuMusic", "gameMusic", "sfx"].map((channel) => `<div class="setting-row volume-row" data-entry><label for="${channel}-volume"><span>${t(channel)}</span><output id="${channel}-value">${Math.round(prefs[channel] * 100)}%</output></label><input id="${channel}-volume" type="range" min="0" max="100" value="${prefs[channel] * 100}"></div>`).join("")}
      </div>
      <div class="preference-bank">
        <div class="setting-row inline" data-entry><label>${t("language")}</label><button id="settings-lang" class="flat-button">${prefs.lang === "zh" ? "中文 → ENGLISH" : "ENGLISH → 中文"}</button></div>
        <div class="setting-row inline" data-entry><label for="reduce-motion">${t("motion")}</label><input type="checkbox" id="reduce-motion" ${prefs.reducedMotion ? "checked" : ""}></div>
      </div>
    </div><footer class="dialog-actions" data-entry><button id="dialog-back" class="action-button">← ${t("close")}</button></footer>`;
  if (kind === "guide")
    html =
      dialogHeader(t("guideTitle"), kind) +
      `<div class="guide-list">${[
        ["WASD", "← ↑ ↓ →", "move", "guideMove"],
        ["J / Z", "", "attack", "guideFire"],
        ["K / X", "", "ultimate", "guideUltimate"],
        ["100 HP", "", "hp", "guideHealth"],
        ["ESC", "", "pause", "guidePause"],
      ]
        .map(
          ([key, alternate, label, description]) =>
            `<div class="guide-item" data-entry><div class="guide-key"><kbd>${key}</kbd>${alternate ? `<span>${alternate}</span>` : ""}</div><div class="guide-copy"><h3>${t(label)}</h3><p>${t(description)}</p></div></div>`,
        )
        .join(
          "",
        )}</div><footer class="dialog-actions" data-entry><button id="dialog-back" class="action-button">← ${t("close")}</button></footer>`;
  if (kind === "records")
    html =
      dialogHeader(t("records"), kind) +
      `<div class="archive-progress" data-entry><span>${t("obtained")}</span><strong>${achievements.size}<small>/ 5</small></strong></div><div class="achievement-list">${["first", "ten", "overload", "depth", "survivor"].map((id) => `<div class="achievement-item ${achievements.has(id) ? "obtained" : ""}" data-entry><span class="achievement-symbol" aria-hidden="true">${achievements.has(id) ? "✦" : "◇"}</span><div class="achievement-copy"><strong>${t(id)}</strong><p>${t(id + "Desc")}</p></div><small>${t(achievements.has(id) ? "obtained" : "locked")}</small></div>`).join("")}</div><footer class="dialog-actions" data-entry><button id="dialog-back" class="action-button">← ${t("close")}</button></footer>`;
  if (kind === "pause")
    html =
      dialogHeader(t("paused"), kind) +
      `<button id="resume" class="action-button">▶ ${t("resume")}</button><button data-open="settings" class="secondary-button">${t("settings")}</button><button id="quit" class="secondary-button">${t("quit")}</button>`;
  if (kind === "gameover")
    html =
      dialogHeader(t("lost"), kind) +
      `<div class="result-score"><span>${t("score")}</span><strong>${String(game.score).padStart(6, "0")}</strong></div><div class="result-stats"><div>${t("kills")}<strong>${game.kills}</strong></div><div>${t("phase")}<strong>0${game.phase}</strong></div><div>${t("best")}<strong>${best}</strong></div></div><button id="retry" class="action-button">↯ ${t("retry")}</button><button id="quit" class="secondary-button">${t("quit")}</button>`;
  $("#dialog-content").innerHTML = `<div class="dialog-sheet">${html}</div>`;
  $("#dialog-content")
    .querySelectorAll("button")
    .forEach((button) => button.classList.add("comic-control"));
  $("#dialog-content")
    .querySelectorAll("[data-entry]")
    .forEach((element, index) =>
      element.style.setProperty(
        "--entry-delay",
        `${Math.min(index, 6) * 24}ms`,
      ),
    );
  overlay.setAttribute("aria-labelledby", "dialog-title");
  overlay.dataset.kind = kind;
  if (!overlay.open) overlay.showModal();
  $("#dialog-back")?.addEventListener("click", () =>
    mode === "paused" ? showDialog("pause") : closeDialog(),
  );
  $("#resume")?.addEventListener("click", resumeRun);
  $("#quit")?.addEventListener("click", returnMenu);
  $("#retry")?.addEventListener("click", startRun);
  $("#settings-lang")?.addEventListener("click", changeLanguage);
  document.querySelectorAll("[data-difficulty]").forEach(
    (button) =>
      (button.onclick = () => {
        prefs.difficulty = button.dataset.difficulty;
        audio.playSfx("change");
        persist();
        showDialog("settings");
      }),
  );
  for (const channel of ["menuMusic", "gameMusic", "sfx"])
    $(`#${channel}-volume`)?.addEventListener("input", (e) => {
      prefs[channel] = Number(e.target.value) / 100;
      $(`#${channel}-value`).textContent =
        `${Math.round(prefs[channel] * 100)}%`;
      applyVolumes();
      persist();
    });
  $("#reduce-motion")?.addEventListener("change", (e) => {
    prefs.reducedMotion = e.target.checked;
    persist();
    updateCopy();
  });
}
document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-open]");
  if (button) showDialog(button.dataset.open);
});
$("#overlay").addEventListener("cancel", (e) => {
  e.preventDefault();
  if (mode === "paused" && $("#overlay").dataset.kind === "pause")
    void resumeRun();
  else if (mode === "paused") showDialog("pause");
  else if (mode !== "gameover") closeDialog();
});
$("#play").onclick = startRun;
$("#pause-button").onclick = pauseRun;
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,select,textarea")) return;
  const key = e.key.toLowerCase();
  if ((key === "enter" || key === " ") && e.target.closest("button")) return;
  if (
    [
      "arrowleft",
      "arrowright",
      "arrowup",
      "arrowdown",
      " ",
      "j",
      "z",
      "k",
      "x",
    ].includes(key) &&
    !$("#overlay").open
  )
    e.preventDefault();
  if (key === "escape") {
    if (!$("#overlay").open) {
      e.preventDefault();
      pauseRun();
    }
    return;
  }
  if ($("#overlay").open) return;
  if (key === "enter" && mode === "menu") {
    audio.playSfx("click");
    void startRun();
    return;
  }
  if (["k", "x"].includes(key) && !e.repeat) ultimateQueued = true;
  keys.add(key);
  void enableAudio();
});
document.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => {
  keys.clear();
  fireHeld = false;
  touchMove = 0;
  if (["playing", "intro"].includes(mode)) pauseRun();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseRun();
});
let swipePointer = null,
  swipeX = 0;
$("#world").addEventListener("pointerdown", (e) => {
  if (mode !== "playing") return;
  swipePointer = e.pointerId;
  swipeX = e.clientX;
  $("#world").setPointerCapture(e.pointerId);
});
$("#world").addEventListener("pointermove", (e) => {
  if (e.pointerId !== swipePointer) return;
  touchMove += ((e.clientX - swipeX) / window.innerWidth) * Math.PI * 2;
  swipeX = e.clientX;
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
  $("#world").addEventListener(type, () => {
    swipePointer = null;
  });
$("#touch-fire").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  fireHeld = true;
  e.currentTarget.setPointerCapture(e.pointerId);
  audio.playSfx("click");
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
  $("#touch-fire").addEventListener(type, () => {
    fireHeld = false;
  });
$("#touch-ultimate").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  ultimateQueued = true;
  audio.playSfx("click");
});
window.addEventListener("resize", () => renderer.resize());

function updateHud() {
  const p = game.player,
    hp = Math.max(0, Math.ceil(p.hp)),
    charge = Math.round(p.charge);
  $("#hp-number").textContent = hp;
  $("#hp-fill").style.transform = `scaleX(${hp / 100})`;
  $(".health-block").classList.toggle("critical", hp < 25);
  $("#invincible").hidden = !p.invulnerable;
  $("#invincible").textContent = game.ultimate
    ? t("fullHeal")
    : prefs.lang === "zh"
      ? "受击保护 / 无敌"
      : "DAMAGE SHIELD / INVINCIBLE";
  $("#score-number").textContent = String(game.score).padStart(6, "0");
  $("#kills-number").textContent = game.kills;
  $("#phase-number").textContent = String(game.phase).padStart(2, "0");
  $("#phase-name").textContent = t("phaseNames")[game.phase - 1];
  $("#phase-pips").innerHTML = Array.from(
    { length: 5 },
    (_, i) => `<i class="${i < game.phase ? "active" : ""}"></i>`,
  ).join("");
  $("#ultimate-fill").style.transform = `scaleX(${charge / 100})`;
  $("#ultimate-number").textContent = `${charge}%`;
  $("#ultimate-status").textContent = t(charge >= 100 ? "charged" : "charging");
  $(".ultimate-block").classList.toggle("ready", charge >= 100);
  $("#touch-ultimate").classList.toggle("ready", charge >= 100);
}
let hudTick = 0;
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  const audioNow = audio.now || 0;
  let introProgress = 1;
  if (mode === "intro" && introTiming) {
    const start = introTiming.startedAt ?? introTiming.startAt ?? audioNow;
    const duration = introTiming.introDuration || 1.333333;
    introProgress = Math.max(0, Math.min(1, (audioNow - start) / duration));
    if (introProgress >= 1) mode = "playing";
  }
  if (mode === "playing") {
    const move =
      Number(["d", "w", "arrowright", "arrowup"].some((k) => keys.has(k))) -
      Number(["a", "s", "arrowleft", "arrowdown"].some((k) => keys.has(k)));
    game.update(
      dt,
      {
        move,
        angleDelta: touchMove,
        fire: fireHeld || keys.has("j") || keys.has("z"),
        ultimate: ultimateQueued,
      },
      audioNow,
    );
    touchMove = 0;
    ultimateQueued = false;
    if (game.elapsed >= 120) unlockAchievement("survivor");
  }
  renderer.render(game, dt, {
    mode,
    introProgress,
    audioNow,
    reducedMotion: prefs.reducedMotion,
    menuPortrait: $(".hero-art").classList.contains("unavailable"),
  });
  if (mode !== "menu" && (hudTick += dt) > 0.08) {
    updateHud();
    hudTick = 0;
  }
  requestAnimationFrame(frame);
}
if (import.meta.env.DEV && new URLSearchParams(location.search).has("qa"))
  window.__gameQA = {
    game,
    audio,
    renderer,
    get mode() {
      return mode;
    },
    startRun,
    pauseRun,
    resumeRun,
    returnMenu,
    prefs,
    showDialog,
  };
updateCopy();
void loadAudio();
requestAnimationFrame(frame);
