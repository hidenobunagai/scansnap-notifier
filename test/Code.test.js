// src/Code.gs（GAS）のリトライとブックキーピングのテスト。
// GAS API は test/gas-harness.mjs が差し替えるので、bun test からそのまま呼べる。
import { describe, expect, test } from "bun:test";
import { LINE_PROPS, file, loadGas, resp } from "./gas-harness.mjs";

const PUSH = "https://api.line.me/v2/bot/message/push";
const FATAL = [400, 401];

/** UrlFetchApp.fetch の呼び出しを記録し、渡した応答を順に返す */
function stubFetch(responses) {
  const calls = [];
  const sleeps = [];
  const fetch = (url, params) => {
    calls.push({ url, params });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === "function" ? next() : next;
  };
  return { calls, sleeps, fetch };
}

/** LINE へ送られた 1 件あたりのテキストを返す */
function sentTexts(calls) {
  return calls
    .filter((c) => c.url === PUSH)
    .flatMap((c) => JSON.parse(c.params.payload).messages.map((m) => m.text));
}

function driveStub(list) {
  return (opts) =>
    loadGas({ ...opts, fetch: list.fetch, sleep: (ms) => list.sleeps.push(ms) });
}

describe("fetchWithRetry", () => {
  test("503 → 2 回目 204 で 1000ms sleep して成功", () => {
    const calls = [];
    const sleeps = [];
    const { api } = loadGas({
      sleep: (ms) => sleeps.push(ms),
      fetch: (url, params) => {
        calls.push(params);
        return resp(calls.length === 1 ? 503 : 204);
      },
    });
    const ret = api.fetchWithRetry(PUSH, {}, 3, FATAL);
    expect(ret.getResponseCode()).toBe(204);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  test("5xx の Retry-After を尊重する", () => {
    const sleeps = [];
    const { api } = loadGas({
      sleep: (ms) => sleeps.push(ms),
      fetch: (() => {
        let n = 0;
        return () => resp(++n === 1 ? 503 : 200, { headers: { "Retry-After": "5" } });
      })(),
    });
    api.fetchWithRetry(PUSH, {}, 3, FATAL);
    expect(sleeps).toEqual([5100]);
  });

  test("429 の既定バックオフは Retry-After + 100ms、無い 429 は 1100ms", () => {
    const sleeps = [];
    const { api } = loadGas({
      sleep: (ms) => sleeps.push(ms),
      fetch: (() => {
        let n = 0;
        return () => resp(++n === 1 ? 429 : 204, { headers: { "Retry-After": "2" } });
      })(),
    });
    api.fetchWithRetry(PUSH, {}, 3, FATAL);
    expect(sleeps).toEqual([2100]);

    const b = [];
    const g = loadGas({
      sleep: (ms) => b.push(ms),
      fetch: (() => {
        let n = 0;
        return () => resp(++n === 1 ? 429 : 204);
      })(),
    });
    g.api.fetchWithRetry(PUSH, {}, 3, FATAL);
    expect(b).toEqual([1100]);
  });

  test("sleep 予算超過は sleep せず throw する", () => {
    const sleeps = [];
    const { api } = loadGas({
      sleep: (ms) => sleeps.push(ms),
      fetch: resp(503, { headers: { "Retry-After": "999" }, text: "over" }),
    });
    expect(() => api.fetchWithRetry(PUSH, {}, 3, FATAL)).toThrow("HTTP 503: over");
    expect(sleeps).toEqual([]);
  });

  test("404 と fatalCodes は即 throw（sleep 0・1 回目）", () => {
    const mk = (first) => {
      const sleeps = [];
      let calls = 0;
      const { api } = loadGas({
        sleep: (ms) => sleeps.push(ms),
        fetch: () => {
          calls++;
          return calls === 1 ? resp(first, { text: "nope" }) : resp(200);
        },
      });
      return { api, sleeps, calls: () => calls };
    };
    const a = mk(404);
    expect(() => a.api.fetchWithRetry(PUSH, {}, 3, FATAL)).toThrow("HTTP 404: nope");
    expect(a.calls()).toBe(1);
    expect(a.sleeps).toEqual([]);

    const b = mk(401);
    expect(() => b.api.fetchWithRetry(PUSH, {}, 3, FATAL)).toThrow("Fatal HTTP 401: nope");
    expect(b.calls()).toBe(1);
    expect(b.sleeps).toEqual([]);
  });

  test("上限回数を使い切ると throw（sleep は試行回数ぶんの指数バックオフ）", () => {
    const sleeps = [];
    let calls = 0;
    const { api } = loadGas({
      sleep: (ms) => sleeps.push(ms),
      fetch: () => {
        calls++;
        return resp(500, { text: "boom" });
      },
    });
    expect(() => api.fetchWithRetry(PUSH, {}, 3, FATAL)).toThrow("HTTP 500: boom");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });
});

describe("checkForNewFiles", () => {
  const base = {
    ...LINE_PROPS,
    LAST_CHECK: "2026-09-16T00:00:00.000Z",
    PROCESSED_IDS: "[]",
  };

  test("通知成功なら LAST_CHECK を進めて PROCESSED_IDS に記録する", () => {
    const list = stubFetch([resp(200)]);
    const { api, get } = driveStub(list)({ properties: base, files: [file("a1")] });
    api.checkForNewFiles();
    expect(get("PROCESSED_IDS")).toBe('["a1"]');
    expect(get("LAST_CHECK")).not.toBe(base.LAST_CHECK);
    expect(sentTexts(list.calls)).toHaveLength(1);
  });

  test("LINE 失敗はログのみで状態は保存し、成功分は記録して再送しない", () => {
    // 6 件 = 2 バッチ。1 番目 (a1-a5) は 400 で失敗、2 番目 (a6) は 200 で成功。
    const list = stubFetch([resp(400, { text: "bad" }), resp(200), resp(200), resp(200), resp(200)]);
    const logs = [];
    const { api, get } = loadGas({
      properties: { ...base, PROCESSED_IDS: "[]" },
      files: [file("a1"), file("a2"), file("a3"), file("a4"), file("a5"), file("a6")],
      fetch: list.fetch,
      sleep: (ms) => list.sleeps.push(ms),
      log: (m) => logs.push(String(m)),
    });
    api.checkForNewFiles();

    // 失敗した a1-a5 は未記録 / a6 だけ記録 / LAST_CHECK は進めない / 例外は投げない
    expect(get("PROCESSED_IDS")).toBe('["a6"]');
    expect(get("LAST_CHECK")).toBe(base.LAST_CHECK);
    expect(logs.some((l) => l.includes("LINE への通知に失敗しました"))).toBe(true);

    // 2 回目: a6 は skip され、失敗した a1-a5 が 1 バッチだけ再送される（二重投稿しない）
    const before = list.calls.length;
    api.checkForNewFiles();
    const second = sentTexts(list.calls.slice(before));
    expect(second).toHaveLength(5);
    expect(second.every((t) => !t.includes("a6.pdf"))).toBe(true);
    expect(get("PROCESSED_IDS")).toBe('["a6","a1","a2","a3","a4","a5"]');
    expect(get("LAST_CHECK")).not.toBe(base.LAST_CHECK);
  });

  test("同一実行内で回復した一時失敗は正常終了し、再投稿しない", () => {
    // 1 バッチ目が 503 → 2 回目 204 で回復する（同一実行内で sleep して再試行）
    const list = stubFetch([resp(503), resp(200)]);
    const { api, get } = loadGas({
      properties: base,
      files: [file("a1")],
      fetch: list.fetch,
      sleep: (ms) => list.sleeps.push(ms),
    });
    api.checkForNewFiles();
    expect(list.sleeps).toEqual([1000]);
    expect(get("PROCESSED_IDS")).toBe('["a1"]');
    expect(get("LAST_CHECK")).not.toBe(base.LAST_CHECK);

    const before = list.calls.length;
    api.checkForNewFiles();
    expect(sentTexts(list.calls.slice(before))).toHaveLength(0);
  });

  test("設定不足は throw し、ロックは解放される", () => {
    const { api } = loadGas({ properties: { FOLDER_ID: "folder" } });
    expect(() => api.checkForNewFiles()).toThrow("Missing configuration");
  });

  test("実行時間予算を超えたら打ち切って状態を保存し、残りだけ次回に残す", () => {
    // LINE が 429 + Retry-After 25 を返し続ける状況（= 家族が見ていないとき）。
    // fetchWithRetry は 1 push あたり sleep 予算 30 秒 (MAX_RETRY_SLEEP_MS) なので、
    // 25 + 5.1 秒で諦めて throw する（1 バッチ = push 1 通 = ファイル 5 件）。
    // 50 バッチ（250 ファイル）なら sleep だけで 25.1 x 50 = 1255 秒 = 20 分超。
    // 打ち切りが効かなければ GAS の 6 分上限で強制終了され、末尾の状態保存に
    // 到達せず次回実行が二重投稿する。今回足した予算 (MAX_RUN_MS) で、
    // 6 分未満に打ち切って状態を保存できることを確認する。
    const many = Array.from({ length: 250 }, (_, i) => file(`a${i + 1}`));
    const rateLimited = () => resp(429, { headers: { "Retry-After": "25" } });
    const list = stubFetch([rateLimited]);
    const { api, get, clock } = loadGas({
      properties: { ...base, PROCESSED_IDS: "[]" },
      files: many,
      fetch: list.fetch,
      now: "1970-01-01T00:00:00.000Z",
      sleep: (ms) => {
        if (clock.ms + ms >= 6 * 60 * 1000) throw new Error("execution timed out");
      },
      log: () => {},
    });

    // 1 バッチ = 2 push = 25.1 秒。9 バッチ（45 ファイル）で 4 分を超えて打ち切られる。
    // 6 分上限の throw は一度も起きないので、状態は保存されて実行は正常に終わる。
    api.checkForNewFiles();
    expect(clock.ms).toBe(10 * 25_100);
    expect(list.calls).toHaveLength(20);

    // 状態は保存されている（強制終了で失われない）＝次回も二重投稿しない
    expect(get("PROCESSED_IDS")).toBe("[]");
    expect(get("LAST_CHECK")).toBe(base.LAST_CHECK);
  });
});
