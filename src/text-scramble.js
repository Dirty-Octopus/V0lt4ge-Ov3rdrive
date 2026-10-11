const DURATION = 600;
const ASCII_START = 33;
const ASCII_COUNT = 94;

function installStyles(document) {
  if (document.getElementById("text-scramble-style")) return;
  const style = document.createElement("style");
  style.id = "text-scramble-style";
  style.textContent = `
    [data-scramble-run] { display: inline; }
    .scramble-glyph { position: relative; display: inline-grid; vertical-align: baseline; }
    .scramble-source { grid-area: 1 / 1; opacity: 0; }
    .scramble-code {
      position: absolute; inset: 0; display: block;
      width: 100%; min-width: 0; overflow-x: clip; overflow-y: visible; text-align: center; pointer-events: none;
      user-select: none; white-space: pre; font: inherit;
      letter-spacing: inherit; line-height: inherit;
    }
  `;
  document.head.append(style);
}

function textKey(node, root) {
  const parts = [
    Array.prototype.indexOf.call(node.parentNode.childNodes, node),
  ];
  for (
    let element = node.parentElement;
    element && element !== root;
    element = element.parentElement
  ) {
    if (element.id) {
      parts.unshift(`#${element.id}`);
      break;
    }
    parts.unshift(
      `${element.localName}:${Array.prototype.indexOf.call(element.parentNode.children, element)}`,
    );
  }
  return parts.join("/");
}

function visibleText(root) {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const entries = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      !node.data.trim() ||
      !parent ||
      parent.closest(
        "script,style,svg,canvas,textarea,option,[hidden],.cube-sizer,[data-scramble-run],.phase-banner:not(.visible),.achievement-toast:not(.visible)",
      )
    )
      continue;
    const dialog = parent.closest("dialog");
    if (dialog && !dialog.open) continue;
    // An open dialog may currently be at opacity zero in its entrance animation.
    // Include it now so its text is already scrambling as that entrance appears.
    if (
      parent.checkVisibility &&
      !parent.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > innerHeight ||
      rect.left > innerWidth
    )
      continue;
    entries.push({ node, text: node.data, key: textKey(node, root) });
  }
  return entries;
}

/**
 * A decorative layer over stable, accessible target characters. It never writes
 * random text into controls' semantic labels, rebuilds elements, or owns HUD data.
 */
export class TextScramble {
  constructor(root) {
    this.root = root;
    this.runs = [];
    this.frame = null;
    this.previousBusy = null;
    installStyles(root.ownerDocument);
  }

  cancel() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const run of this.runs) {
      // A live HUD or dialog may already have replaced its text. Never restore
      // that detached run, which would overwrite a newer value or language.
      if (run.host.isConnected) run.host.replaceWith(run.node);
    }
    this.runs = [];
    if (this.root.hasAttribute("data-text-scramble-active")) {
      if (this.previousBusy === null) this.root.removeAttribute("aria-busy");
      else this.root.setAttribute("aria-busy", this.previousBusy);
      this.root.removeAttribute("data-text-scramble-active");
    }
  }

  transition(update, { reducedMotion = false } = {}) {
    this.cancel();
    const before = new Map(
      visibleText(this.root).map((entry) => [entry.key, entry.text]),
    );
    update();
    if (reducedMotion) return;

    const entries = visibleText(this.root);
    if (!entries.length) return;
    this.previousBusy = this.root.getAttribute("aria-busy");
    this.root.setAttribute("aria-busy", "true");
    this.root.setAttribute("data-text-scramble-active", "true");
    const document = this.root.ownerDocument;
    const glyphs = [];
    for (const [runIndex, entry] of entries.entries()) {
      const host = document.createElement("scramble-run");
      host.setAttribute("data-scramble-run", "");
      const target = Array.from(entry.text);
      const previous = Array.from(before.get(entry.key) ?? entry.text);
      for (const [index, character] of target.entries()) {
        if (/\s/u.test(character)) {
          host.append(document.createTextNode(character));
          continue;
        }
        const glyph = document.createElement("scramble-glyph");
        glyph.className = "scramble-glyph";
        const source = document.createElement("scramble-source");
        source.className = "scramble-source";
        source.textContent = character;
        const code = document.createElement("scramble-code");
        code.className = "scramble-code";
        code.setAttribute("aria-hidden", "true");
        const seed =
          (previous[index]?.codePointAt(0) ?? 0) +
          Math.floor(Math.random() * ASCII_COUNT);
        code.textContent = String.fromCharCode(
          ASCII_START + (seed % ASCII_COUNT),
        );
        glyph.append(source, code);
        host.append(glyph);
        glyphs.push({
          source,
          code,
          seed,
          done: false,
          resolveAt:
            DURATION *
            (0.32 +
              (0.48 * index) / Math.max(1, target.length - 1) +
              (0.12 * runIndex) / Math.max(1, entries.length - 1) +
              Math.random() * 0.08),
        });
      }
      entry.node.replaceWith(host);
      this.runs.push({ host, node: entry.node });
    }

    const started = performance.now();
    let previousTick = -1;
    const animate = (now) => {
      const elapsed = now - started;
      if (elapsed >= DURATION) {
        this.cancel();
        return;
      }
      const tick = Math.floor(elapsed / 34);
      if (tick !== previousTick) {
        previousTick = tick;
        for (const glyph of glyphs) {
          if (glyph.done || !glyph.code.isConnected) continue;
          if (elapsed >= glyph.resolveAt) {
            glyph.source.style.opacity = "1";
            glyph.code.remove();
            glyph.done = true;
          } else {
            // Prime stepping traverses printable ASCII before each target settles.
            glyph.code.textContent = String.fromCharCode(
              ASCII_START + ((glyph.seed + tick * 31) % ASCII_COUNT),
            );
          }
        }
      }
      this.frame = requestAnimationFrame(animate);
    };
    this.frame = requestAnimationFrame(animate);
  }
}
