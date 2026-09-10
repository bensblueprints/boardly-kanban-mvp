import { animate, inView, scroll, stagger } from "framer-motion/dom";

// Progressive enhancement: the entire page remains readable if this module cannot load.
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const motionButton = document.querySelector(".motion-toggle");
let manualPause = false;
try {
  manualPause =
    localStorage.getItem("boardly-marketing-motion-paused") === "true";
} catch {}
let motionEnabled = false;
let cleanup = [];
const entranceTargets = ".hero-enter, .reveal, .preview-shell, .desktop-shot";
const ease = [0.22, 1, 0.36, 1];
const track = (control) => {
  cleanup.push(() => control.cancel());
  return control;
};
function stopMotion() {
  cleanup
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  document.querySelectorAll(entranceTargets).forEach((el) => {
    el.style.removeProperty("opacity");
    el.style.removeProperty("transform");
  });
}
function configureMotion() {
  stopMotion();
  motionEnabled = !manualPause && !reduced.matches;
  document.documentElement.dataset.motion = motionEnabled
    ? "enabled"
    : "paused";
  motionButton.setAttribute("aria-pressed", String(!motionEnabled));
  motionButton.querySelector(".motion-label").textContent = reduced.matches
    ? "Reduced motion on"
    : motionEnabled
      ? "Pause motion"
      : "Resume motion";
  motionButton.disabled = reduced.matches;
  if (!motionEnabled) return;
  track(
    animate(
      ".hero-enter",
      { opacity: [0, 1], y: [22, 0] },
      { duration: 0.9, delay: stagger(0.085), ease },
    ),
  );
  cleanup.push(
    inView(
      ".reveal",
      (el) => {
        track(
          animate(
            el,
            { opacity: [0, 1], y: [27, 0] },
            { duration: 0.85, ease },
          ),
        );
      },
      { amount: 0.12, margin: "0px 0px -28px 0px" },
    ),
  );
  const progress = track(
    animate(".scroll-progress", { scaleX: [0, 1] }, { ease: "linear" }),
  );
  cleanup.push(scroll(progress));
  if (matchMedia("(min-width: 821px)").matches) {
    const preview = track(
      animate(
        ".preview-shell",
        { rotateX: [5, 0], y: [18, -10] },
        { ease: "linear" },
      ),
    );
    cleanup.push(
      scroll(preview, {
        target: document.querySelector(".product-stage"),
        offset: ["start end", "center center"],
      }),
    );
    const desktop = track(
      animate(
        ".desktop-shot",
        { rotateY: [-7, 0], rotateZ: [2, 0], y: [24, -10] },
        { ease: "linear" },
      ),
    );
    cleanup.push(
      scroll(desktop, {
        target: document.querySelector(".desktop-stage"),
        offset: ["start end", "end center"],
      }),
    );
  }
}
motionButton.addEventListener("click", () => {
  manualPause = !manualPause;
  try {
    localStorage.setItem(
      "boardly-marketing-motion-paused",
      String(manualPause),
    );
  } catch {}
  configureMotion();
});
reduced.addEventListener("change", configureMotion);
matchMedia("(min-width: 821px)").addEventListener("change", configureMotion);
configureMotion();

// Preview tabs have keyboard navigation and use real, isolated demonstration screenshots.
const previewTabs = [...document.querySelectorAll("[data-preview]")];
let previewTransition;
function selectPreview(tab, focus = false) {
  if (previewTransition) previewTransition.cancel();
  previewTabs.forEach((button) => {
    const selected = button === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(button.getAttribute("aria-controls"));
    panel.hidden = !selected;
    panel.style.removeProperty("opacity");
    panel.style.removeProperty("transform");
  });
  const panel = document.getElementById(tab.getAttribute("aria-controls"));
  if (motionEnabled)
    previewTransition = animate(
      panel,
      { opacity: [0, 1], y: [8, 0] },
      { duration: 0.38, ease },
    );
  if (focus) tab.focus();
}
previewTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectPreview(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % previewTabs.length;
    if (event.key === "ArrowLeft")
      next = (index - 1 + previewTabs.length) % previewTabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = previewTabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectPreview(previewTabs[next], true);
    }
  });
});
const examples = {
  ask: [
    "What should I focus on next?",
    "Your launch page is ready for review. Next up: confirm the copy and check the signup flow.",
    "The next step, with context.",
  ],
  plan: [
    "Help me plan the launch.",
    "First, review the page. Then test signup on mobile. Finish with the launch checklist and a final team review.",
    "A clear route from idea to action.",
  ],
  work: [
    "Check the launch page on mobile.",
    "An assignment keeps the request, progress and results with this project. If something blocks the work, the next action stays visible.",
    "An example of assigning project work.",
  ],
};
let aiTransition;
document.querySelectorAll("[data-ai-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    if (aiTransition) aiTransition.cancel();
    document
      .querySelectorAll("[data-ai-mode]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    const [question, answer, context] = examples[button.dataset.aiMode];
    document.querySelector(".ai-question").textContent = question;
    document.querySelector(".ai-answer").textContent = answer;
    const label = document.querySelector(".ai-context");
    label.replaceChildren(
      Object.assign(document.createElement("i"), { ariaHidden: "true" }),
      document.createTextNode(context),
    );
    if (motionEnabled)
      aiTransition = animate(
        ".ai-example",
        { opacity: [0.15, 1], y: [5, 0] },
        { duration: 0.32, ease },
      );
  });
});

const header = document.querySelector(".site-header");
let headerScrolled = false;
function syncHeader() {
  const next = scrollY > 12;
  if (next !== headerScrolled) {
    header.classList.toggle("scrolled", next);
    headerScrolled = next;
  }
}
addEventListener("scroll", syncHeader, { passive: true });
syncHeader();
const menuToggle = document.querySelector(".menu-toggle");
const menu = document.querySelector("#mobile-nav");
function setMenu(open) {
  menu.hidden = !open;
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute(
    "aria-label",
    open ? "Close navigation" : "Open navigation",
  );
}
menuToggle.addEventListener("click", () => setMenu(menu.hidden));
menu
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menu.hidden) {
    setMenu(false);
    menuToggle.focus();
  }
});
document.addEventListener("click", (e) => {
  if (!menu.hidden && !header.contains(e.target)) setMenu(false);
});
matchMedia("(min-width: 821px)").addEventListener("change", (e) => {
  if (e.matches) setMenu(false);
});

// Short spring responses add tactility; continuous decorative motion can be paused above.
if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
  document.querySelectorAll(".bento, .computer-plan").forEach((card) => {
    let hoverAnimation;
    function lift(y) {
      if (!motionEnabled) {
        card.style.removeProperty("transform");
        return;
      }
      if (hoverAnimation) hoverAnimation.stop();
      hoverAnimation = animate(
        card,
        { y },
        { type: "spring", stiffness: 290, damping: 25 },
      );
    }
    card.addEventListener("pointerenter", () => lift(-4));
    card.addEventListener("pointerleave", () => lift(0));
  });
}
document.querySelectorAll(".faq details").forEach((item) =>
  item.addEventListener("toggle", () => {
    if (item.open && motionEnabled)
      animate(
        item.querySelector("p"),
        { opacity: [0, 1], y: [-4, 0] },
        { duration: 0.3, ease },
      );
  }),
);
document.documentElement.dataset.marketingReady = "true";
