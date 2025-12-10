(() => {
  if (window.listeners === undefined) {
    window.listeners = {};
    ["play", "pause", "volumechange"].forEach((type) => {
      if (!(type in window.listeners))
        window.listeners[type] = async () => {
          const message = { type };
          if (type === "volumechange") {
            message.volume = window.$media.muted ? null : window.$media.volume;
          }
          await browser.runtime.sendMessage(message);
        };
    });
  }

  if (window.$media === undefined) {
    window.$media = document.querySelector("[mcx-media]");
    for (const [type, listener] of Object.entries(window.listeners)) {
      window.$media.addEventListener(type, listener);
    }
    browser.runtime.onMessage.addListener((message) => {
      // from popup
if (msg.type === "serial-connect") {
  openSerialByIndex(msg.idx).then((ok) => {
    browser.runtime.sendMessage({
      type: "serial-state",
      connected: ok,
      info: ok ? serialPort.getInfo() : null
    });
  });
  return;
}

if (msg.type === "serial-disconnect") {
  closeSerial().then(() => {
    browser.runtime.sendMessage({
      type: "serial-state",
      connected: false
    });
  });
  return;
}

if (msg.type === "serial-query") {
  return Promise.resolve({
    connected: !!serialPort,
    info: serialPort ? serialPort.getInfo() : null
  });
}

      if (message === "@unhook") {
        const $media = document.querySelector("[mcx-media]");
        if ($media !== null) {
          for (const [type, listener] of Object.entries(window.listeners)) {
            $media.removeEventListener(type, listener);
          }
          $media.toggleAttribute("mcx-media", false);
          window.$media = undefined;
        }
      }
    });
  }
})();
