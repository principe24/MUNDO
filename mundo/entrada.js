"use strict";
// A local copy of this page can open an invitation. Credentials stay in the fragment
// until the player contacts the room on its own origin.
window.MundoEntrada = (() => {
  function invitation(text) {
    const raw = text.trim();
    if (raw.length > 256) return null;
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) return null;
    if (url.username || url.password || url.search || !/^#seat=[0-9a-f]{48}$/.test(url.hash)) return null;
    if (raw !== url.origin + "/mundo/MUNDO.html" + url.hash) return null;
    return url;
  }
  function enter() {
    const form = document.getElementById("entry");
    const input = document.getElementById("invitation");
    const status = document.getElementById("entryStatus");
    const current = invitation(location.href);
    if (current) return current.hash.slice(6);
    document.querySelector(".playstage").hidden = true;
    form.hidden = false;
    if (location.hash) status.textContent = "La invitación está incompleta o ya no tiene el formato esperado.";
    form.onsubmit = event => {
      event.preventDefault();
      const target = invitation(input.value);
      if (!target) { status.textContent = "Pega el enlace individual completo que te dio el anfitrión."; input.focus(); return; }
      input.value = "";
      if (location.origin === target.origin && location.pathname === target.pathname && !location.search) {
        history.replaceState(null,"",target.href);
        location.reload();
      } else location.replace(target.href);
    };
    return null;
  }
  return Object.freeze({enter});
})();
