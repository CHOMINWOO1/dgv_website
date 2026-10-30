"use strict";
// Same-origin pinned runtime; camera pixels remain local to this dedicated
// worker and are never uploaded or persisted. Termination releases its models.
importScripts(new URL("attendance-face.js?v=20261030-3",self.location.href).href);
