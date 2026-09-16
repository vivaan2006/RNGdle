// One join-QR implementation for every game.
//
// The subtle part is which origin to encode. location.origin is right on the
// deployed site, but a host running at localhost:3000 would produce a QR
// pointing at "localhost" — which resolves to the *phone* when scanned, so it
// never reaches the host machine. On localhost we ask the server for a
// LAN-reachable address instead.
(function (global) {

  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  let cached = null;     // resolved once per page, then reused
  let inFlight = null;

  /** An origin a phone on the same network can actually reach. */
  function joinOrigin() {
    if (!LOCAL_HOSTS.includes(location.hostname)) return Promise.resolve(location.origin);
    if (cached) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    inFlight = fetch('/api/lan-origin')
      .then(r => r.json())
      .then(info => {
        if (!info.origin) throw new Error('no LAN address');
        cached = info.origin;
        return cached;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  /**
   * Draw a join QR into `box`.
   * @param box   container element
   * @param path  the game's page path, e.g. "/horsrng" or "/mafia.html"
   * @param code  room code
   * @param opts  { caption, quiet }
   */
  function render(box, path, code, opts) {
    if (!box || !code) return;
    opts = opts || {};
    const caption = opts.caption === undefined ? 'Scan to join' : opts.caption;
    box.textContent = 'Finding phone join address…';
    joinOrigin().then(origin => {
      const url = origin + path + (path.includes('?') ? '&' : '?') + 'room=' + code;
      box.innerHTML = global.RNGPARTY_QR.svg(url, { quiet: opts.quiet == null ? 3 : opts.quiet })
                    + (caption ? `<span>${caption}</span>` : '');
      box.dataset.joinUrl = url;          // so "copy link" can share the same address
    }).catch(() => {
      box.textContent = "Open this page at your computer's Wi-Fi address to show a scannable code.";
      delete box.dataset.joinUrl;
    });
  }

  global.RNGPARTY_JOINQR = { render, joinOrigin };

})(typeof window !== 'undefined' ? window : globalThis);
