// Adapted from Towbar's Apache-2.0 docs header. See NOTICE.md.
(() => {
  window.__vitalogHeaderCleanup?.();
  let frame;
  const observer = new MutationObserver(schedule);
  window.__vitalogHeaderCleanup = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
  function update() {
    observer.disconnect();
    for (const logo of document.querySelectorAll("#navbar a:has(.nav-logo)")) {
      if (!logo.querySelector("[data-vitalog-wordmark]")) {
        const wordmark = document.createElement("span");
        wordmark.dataset.vitalogWordmark = "";
        wordmark.setAttribute("aria-hidden", "true");
        wordmark.textContent = "Vitalog";
        logo.append(wordmark);
      }
      logo.setAttribute("aria-label", "Vitalog documentation");
    }
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else schedule();
})();
