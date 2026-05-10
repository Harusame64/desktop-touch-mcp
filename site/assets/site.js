document.addEventListener("DOMContentLoaded", () => {
  // Footer year
  const yearTarget = document.querySelector("[data-year]");
  if (yearTarget) {
    yearTarget.textContent = String(new Date().getFullYear());
  }

  // Mobile hamburger nav — inject button next to .nav-links so existing
  // HTML pages do not need to be touched.
  const header = document.querySelector(".site-header");
  const nav = header && header.querySelector(".nav-links");
  if (header && nav && !header.querySelector(".nav-toggle")) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "nav-toggle";
    toggle.setAttribute("aria-label", "Toggle navigation");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "site-nav");
    toggle.innerHTML = '<span class="nav-toggle-bars"><span></span></span>';

    if (!nav.id) nav.id = "site-nav";

    nav.parentNode.insertBefore(toggle, nav);

    const setOpen = (open) => {
      header.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(!header.classList.contains("nav-open"));
    });

    // Tap-outside to close
    document.addEventListener("click", (event) => {
      if (!header.classList.contains("nav-open")) return;
      if (header.contains(event.target)) return;
      setOpen(false);
    });

    // Tap a link → close (so users land on the new section, not on an
    // overlay still covering the page)
    nav.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (link) setOpen(false);
    });

    // Esc closes
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && header.classList.contains("nav-open")) {
        setOpen(false);
        toggle.focus();
      }
    });

    // If viewport grows back over the mobile breakpoint, close the
    // overlay state to avoid a stuck "open" flag.
    const desktopQuery = window.matchMedia("(min-width: 641px)");
    const onDesktopChange = (event) => { if (event.matches) setOpen(false); };
    if (desktopQuery.addEventListener) {
      desktopQuery.addEventListener("change", onDesktopChange);
    } else if (desktopQuery.addListener) {
      desktopQuery.addListener(onDesktopChange);
    }
  }
});
