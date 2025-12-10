window.__tabs__ = new Map();

function applyPopupViews(func, args) {
  const views = browser.extension.getViews({ type: "popup" });
  for (const view of views) {
    view[func].apply(view, args);
  }
}
// ---------- SERIAL SUPPORT (paste after window.__tabs__ = new Map()) ----------

/**
 * Serial helper for sending JSON lines over a serial port.
 * Works with native firefox-webserial add-on (provides navigator.serial).
 *
 * Usage:
 *  - call requestSerialPortFromUser() once (e.g. from popup UI) to pick a port,
 *  - or call ensureSerialOpen() to try to open previously selected port.
 */

let serialPort = null;
let serialWriter = null;

/**
 * Request a serial port from user (shows prompt). Call this from UI (popup/button).
 */
async function requestSerialPortFromUser(options = { filters: [] }) {
  if (!("serial" in navigator)) {
    console.warn("Web Serial API not available. Install the WebSerial for Firefox add-on.");
    // Optionally show user a notification or open the addon's page.
    return { ok: false, reason: "no-webserial" };
  }

  try {
    const port = await navigator.serial.requestPort(options); // polyfill provides this in Firefox
    // store the chosen port in memory for the session
    serialPort = port;
    await openSerialPortIfNeeded();
    return { ok: true };
  } catch (err) {
    console.error("User cancelled or failed to pick serial port:", err);
    return { ok: false, reason: err };
  }
}

/**
 * Open serial port (if selected) with given options. Re-uses writer if already open.
 */
async function openSerialPortIfNeeded(openOptions = { baudRate: 115200 }) {
  if (!serialPort) throw new Error("No serial port selected");
  if (!("serial" in navigator)) throw new Error("Web Serial not available");

  if (serialWriter) {
    // Already open
    return;
  }

  try {
    await serialPort.open(openOptions);
    // Create a writer we will use to send data
    const writable = serialPort.writable;
    if (!writable) throw new Error("Port has no writable stream");
    serialWriter = writable.getWriter();
    console.log("Serial port opened", openOptions);
  } catch (err) {
    console.error("Failed to open serial port:", err);
    // If port.open() fails the port might be in use or permissions denied.
    throw err;
  }
}

/**
 * Close the serial writer/port
 */
async function closeSerialPort() {
  try {
    if (serialWriter) {
      await serialWriter.releaseLock();
      serialWriter = null;
    }
    if (serialPort && serialPort.readable === null && serialPort.writable === null) {
      // some polyfills may not expose close() directly; try call if available
      if (typeof serialPort.close === "function") await serialPort.close();
    }
    serialPort = null;
    console.log("Serial port closed");
  } catch (err) {
    console.warn("Error closing serial port:", err);
  }
}

/**
 * Send JSON as a newline-terminated line over serial.
 * Example payload: { title, artist, paused, muted, url }
 */
async function sendSerialLine(obj) {
  try {
    if (!serialWriter) {
      // try to open if we have a selected port
      if (serialPort) {
        await openSerialPortIfNeeded();
      } else {
        // no port selected
        console.debug("No serial writer available - not sending", obj);
        return false;
      }
    }
    const line = JSON.stringify(obj) + "\n";
    const data = new TextEncoder().encode(line);
    await serialWriter.write(data);
    return true;
  } catch (err) {
    console.error("Failed to send over serial:", err);
    // If we get an error, tear down writer so next send tries reconnection
    try { if (serialWriter) { await serialWriter.releaseLock(); serialWriter = null; } } catch(e){}
    return false;
  }
}

/**
 * Convenience wrapper for your media object (tab.media)
 */
async function sendMediaOverSerial(tab) {
  if (!tab || !tab.media) return;
  // choose fields you want to send
  const m = tab.media;
  const payload = {
    title: m.title ?? null,
    artist: m.artist ?? null,
    album: m.album ?? null,
    url: tab.url ?? null,
    paused: !!m.paused,
    muted: !!m.muted,
    // you can add more fields, e.g. position/duration if you track them
    ts: Date.now()
  };
  await sendSerialLine(payload);
}

// Optional helper to attempt to (re)open saved port automatically (not recommended without user gesture)
async function ensureSerialOpenIfAvailable() {
  if (!serialPort) return;
  try {
    await openSerialPortIfNeeded();
  } catch (err) {
    console.warn("ensureSerialOpenIfAvailable failed:", err);
  }
}


async function init(tab) {
  if (typeof tab === "number") {
    tab = await browser.tabs.get(tab);
  }
  const url = new URL(tab.url);
  const thumbnail = await (async () => {
    if (url.hostname.match(/^(www|music)\.youtube\.com$/)) {
      const vid = tab.url.match(/\/(?:watch\?v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/)[1];
      return `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
    }
    return (
      await browser.tabs.executeScript(tab.id, {
        code: `document.querySelector("meta[property='og:image']")?.getAttribute("content");`,
      })
    )[0];
  })();
  const color = await (async (src) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        canvas.width = image.width;
        canvas.height = image.height;
        context.drawImage(image, 0, 0, 1, 1);
        resolve(context.getImageData(0, 0, 1, 1).data);
        // returns [r, g, b, a]
      };
      image.src = src;
    });
  })(thumbnail || tab.favIconUrl);
  return {
    id: tab.id,
    wid: tab.windowId,
    media: null,
    title: tab.title,
    favicon: tab.favIconUrl,
    hostname: url.hostname,
    thumbnail: thumbnail,
    color: color,
  };
}

async function register(tid) {
  window.__tabs__.set(tid, await init(tid));
  applyPopupViews("add", [window.__tabs__.get(tid)]);
  await browser.browserAction.enable();
  await browser.browserAction.setBadgeText({
    text: String(window.__tabs__.size),
  });
  await browser.tabs.executeScript(tid, { file: "inject.js" });
}

async function unregister(tid) {
  window.__tabs__.delete(tid);
  applyPopupViews("del", [tid]);
  const size = window.__tabs__.size;
  size === 0 && (await browser.browserAction.disable());
  await browser.browserAction.setBadgeText({
    text: size > 0 ? String(size) : null,
  });
  await browser.tabs.sendMessage(tid, "@unhook");
}

browser.browserAction.disable();
browser.browserAction.setBadgeTextColor({ color: "white" });
browser.browserAction.setBadgeBackgroundColor({ color: "gray" });

browser.tabs.query({ audible: true, status: "complete" }).then(async (tabs) => {
  for (const { id } of tabs) {
    await register(id);
  }
});

browser.tabs.onUpdated.addListener(
  async (tid, { audible }) => {
    if (audible && !window.__tabs__.has(tid)) {
      await register(tid);
    }
  },
  { properties: ["audible"] }
);

browser.tabs.onUpdated.addListener(
  async (tid) => {
    if (window.__tabs__.has(tid)) {
      await unregister(tid);
      await new Promise((r) => setTimeout(r, 4500));
      const tab = await browser.tabs.get(tid);
      if (tab.audible) {
        await register(tid);
      }
    }
  },
  { properties: ["url", "status"] }
);

browser.tabs.onUpdated.addListener(
  async (tid, { title }) => {
    if (window.__tabs__.has(tid)) {
      window.__tabs__.get(tid).title = title;
      applyPopupViews("update", [window.__tabs__.get(tid)]);
    }
  },
  { properties: ["title"] }
);

browser.tabs.onUpdated.addListener(
  async (tid, { discarded }) => {
    if (discarded && window.__tabs__.has(tid)) {
      await unregister(tid);
    }
  },
  { properties: ["discarded"] }
);

browser.tabs.onRemoved.addListener(async (tid) => {
  if (window.__tabs__.has(tid)) {
    await unregister(tid);
  }
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  const tid = sender.tab.id;
  const tab = window.__tabs__.get(tid);
  if (message.type === "@hook") {
    tab.media = message.media;
    await browser.tabs.executeScript(tid, { file: "hook.js" });
  } else if (message.type === "play") {
    tab.media.paused = false;
  } else if (message.type === "pause") {
    tab.media.paused = true;
  } else if (message.type === "volumechange") {
    tab.media.muted = message.volume === null;
  } else return;
  applyPopupViews("update", [tab]);
});
