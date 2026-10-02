// Code.gs（GAS）を bun test から読み込むための最小ハーネス。
// トップレベルは定数と関数宣言だけで GAS API を呼ばないので、
// new Function にスタブのグローバルを差して評価できる（scripts/check-gas.mjs と同じ流儀）。
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../src/Code.gs", import.meta.url), "utf8");

// テストから呼ぶ関数だけを返す（足すときはここに 1 行足す）
const EXPORTS = [
  "checkForNewFiles",
  "fetchWithRetry",
  "postToLine",
  "buildFileMessage",
  "formatFileSize",
  "listAllFiles",
  "validateSetup",
];

/** UrlFetchApp の応答を模したオブジェクト */
export function resp(code, { headers = {}, text = "" } = {}) {
  return { getResponseCode: () => code, getContentText: () => text, getHeaders: () => headers };
}

/**
 * GAS のグローバルを差し替えて Code.gs を読み込む。
 * `fetch` は UrlFetchApp.fetch、`files` は Drive.Files.list の戻り値（呼び出しごとに変える場合は関数）。
 * `sleep` は Utilities.sleep、`log` は console.log / warn / error。
 * `now` は Date.now の初期値。仮想時計は Utilities.sleep のぶんだけ進み、渡した `sleep` が
 * throw した（= タイムアウトを模したもの）ときは進まない。返り値の `clock` で経過 ms を読める。
 */
export function loadGas({
  properties = {},
  fetch,
  files = [],
  sleep = () => {},
  log = () => {},
  now = "2026-09-17T00:00:00.000Z",
  source = SOURCE,
} = {}) {
  const store = new Map(Object.entries(properties));
  const clock = { ms: Date.parse(now) };
  const gas = {
    console: { log, warn: log, error: log },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (store.has(key) ? store.get(key) : null),
        setProperty: (key, value) => void store.set(key, String(value)),
        setProperties: (obj) => void Object.entries(obj).forEach(([k, v]) => store.set(k, String(v))),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [] },
    Drive: {
      Files: {
        list: typeof files === "function"
          ? files
          : () => ({ files, nextPageToken: undefined }),
      },
    },
    UrlFetchApp: {
      // 応答オブジェクトを直接渡された場合は「毎回それを返す」スタブとして扱う
      fetch: typeof fetch === "function" ? fetch : () => fetch,
    },
    Utilities: {
      sleep: (ms) => {
        sleep(ms);
        clock.ms += ms;
      },
      formatDate: (d) => new Date(d).toISOString(),
    },
  };
  const names = Object.keys(gas);
  // GAS の Date.now を仮想時計に差し替える。素 Date は傷つけず Date.now だけ差し替える
  const clockedDate = Object.assign(function (...a) {
    return a.length ? new Date(...a) : new Date(clock.ms);
  }, Date);
  clockedDate.now = () => clock.ms;
  const api = new Function(
    ...names,
    "Date",
    `${source}
return { ${EXPORTS.join(", ")} };`,
  )(...names.map((name) => gas[name]), clockedDate);
  return { api, get: (key) => store.get(key), store, clock };
}

/** Code.gs の通知に必要な Script Properties */
export const LINE_PROPS = {
  FOLDER_ID: "folder",
  LINE_CHANNEL_ACCESS_TOKEN: "token",
  LINE_TARGET_ID: "U123",
};

/** Drive v3 の file 要素 */
export const file = (id, over = {}) => ({
  id,
  name: `${id}.pdf`,
  createdTime: "2026-09-16T10:00:00.000Z",
  webViewLink: `https://drive.google.com/file/d/${id}`,
  mimeType: "application/pdf",
  size: "2048",
  ...over,
});