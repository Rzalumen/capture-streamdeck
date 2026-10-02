/* Property Inspector for "Fixtures: Setup" (plain JS, no network access needed). The table itself is in setup-core.js. */
(function () {
  "use strict";
  let ws, uuid, actionUUID = "";
  let core;

  function toPlugin(payload) {
    ws.send(JSON.stringify({ event: "sendToPlugin", action: actionUUID, context: uuid, payload }));
  }

  window.connectElgatoStreamDeckSocket = function (port, inUUID, registerEvent, _info, actionInfoJson) {
    uuid = inUUID;
    actionUUID = (JSON.parse(actionInfoJson) || {}).action || "";
    core = window.SetupCore.start({ send: toPlugin });
    ws = new WebSocket("ws://127.0.0.1:" + port);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: registerEvent, uuid }));
      toPlugin({ cmd: "get" });
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.event === "sendToPropertyInspector" && msg.payload && msg.payload.event === "setup") core.receive(msg.payload.view, msg.payload.error);
    };
  };
})();
