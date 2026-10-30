(function (root) {
  "use strict";
  // Dedicated storage; never reads or modifies the website's Auth/session data.
  const DATABASE = "hana-attendance-v1";
  let opening;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      if (!root.indexedDB || !root.crypto?.subtle) return reject(new Error("암호화 저장을 지원하는 HTTPS 브라우저가 필요합니다. / Cần trình duyệt HTTPS hỗ trợ lưu mã hóa."));
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("key"); request.result.createObjectStore("records"); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("다른 출퇴근 탭을 닫아 주세요. / Đóng các thẻ chấm công khác."));
    });
    return opening;
  }
  async function transaction(store, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode); let value;
      const request = action(tx.objectStore(store));
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("기기에 저장하지 못했습니다. / Không lưu được trên thiết bị."));
    });
  }
  async function key() {
    const existing = await transaction("key", "readonly", s => s.get("aes"));
    if (existing) return existing;
    const generated = await crypto.subtle.generateKey({name:"AES-GCM",length:256}, false, ["encrypt","decrypt"]);
    // Recheck within one write transaction to avoid replacing another tab's key.
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("key", "readwrite"), store = tx.objectStore("key"), request = store.get("aes"); let selected;
      request.onsuccess = () => { selected = request.result || generated; if (!request.result) store.put(selected,"aes"); };
      tx.oncomplete = () => resolve(selected); tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async function put(id, value, current = () => true) {
    const secret = await key(), iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    try {
      const cipher = await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:new TextEncoder().encode(id)}, secret, plaintext);
      // Recheck inside the transaction, after async encryption. A revoked
      // device or superseded selection must not leave a late shared cache.
      await transaction("records","readwrite",s=>current()?s.put({iv,cipher},id):s.get(id));
    } finally { plaintext.fill(0); }
  }
  async function get(id) {
    const record = await transaction("records","readonly",s=>s.get(id));
    if (!record) return null;
    const plain = new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:record.iv,additionalData:new TextEncoder().encode(id)},await key(),record.cipher));
    try { return JSON.parse(new TextDecoder().decode(plain)); } finally { plain.fill(0); }
  }
  const remove = id => transaction("records","readwrite",s=>s.delete(id));
  async function records(prefix) {
    const ids = await transaction("records","readonly",s=>s.getAllKeys());
    const keys=ids.filter(id=>String(id).startsWith(prefix)),results=await Promise.allSettled(keys.map(get));
    return {faces:results.filter(item=>item.status==="fulfilled").map(item=>item.value).filter(Boolean),errors:results.flatMap((item,index)=>item.status==="rejected"?[{id:String(keys[index]),error:item.reason}]:[])};
  }
  // Legacy enrollments remain intact until the server validates their original
  // device and enrollment IDs. Shared caches use separate encrypted records.
  const readFaces = () => records("face:");
  const readSharedFaces = () => records("shared-face:");
  const faces = async () => (await readFaces()).faces;
  const sharedFaces = async () => (await readSharedFaces()).faces;
  const putSharedFace = (face,current) => put(`shared-face:${face.employeeId}`,face,current);
  async function clearSharedFaces() {
    const ids = await transaction("records","readonly",s=>s.getAllKeys());
    await Promise.all(ids.filter(id=>String(id).startsWith("shared-face:")).map(remove));
  }
  async function clear() {
    // Keep the non-extractable key so an already-open tab cannot leave ciphertext
    // encrypted with a discarded key. All attendance credentials/templates go.
    await transaction("records","readwrite",s=>s.clear());
  }
  root.DGV_ATTENDANCE_STORE = Object.freeze({get,put,remove,faces,readFaces,sharedFaces,readSharedFaces,putSharedFace,clearSharedFaces,clear});
})(window);
