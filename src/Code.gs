/**
 * Google Drive "ScanSnap" folder watcher -> LINE notifier
 * - Polls the target folder for new files since the last check
 * - Sends a plain-text message to a LINE user/group via Messaging API
 *
 * Setup flow:
 * 1) Set Script Properties: FOLDER_ID, LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID.
 * 2) Run setConfig() once to initialize baseline and install a 5-min trigger.
 * 3) New files added after initialization will be announced to LINE.
 */

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_RETRIES = 3;
// Total retry sleep budget per request to respect GAS 6-minute per-execution limit.
const MAX_RETRY_SLEEP_MS = 30 * 1000;
// Wall-clock budget for one checkForNewFiles run. Stopping early leaves room before
// the GAS 6-minute per-execution kill, which would skip the state save at the end.
const MAX_RUN_MS = 4 * 60 * 1000;

/**
 * One-time configuration.
 * - Use Script Properties for Drive folder ID and LINE credentials, then run this.
 * - Initializes the baseline timestamp to "now" so existing files are not announced.
 * - Installs the time-driven trigger.
 * - The false argument preserves all other Script Properties (do not delete them).
 */
function setConfig() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty("FOLDER_ID");
  const lineToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  const lineTargetId = props.getProperty("LINE_TARGET_ID");
  if (!folderId || !lineToken || !lineTargetId) {
    throw new Error(
      "Script Properties の FOLDER_ID と、通知先 (LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID) が未設定です。",
    );
  }
  const now = new Date().toISOString();
  props.setProperties({ LAST_CHECK: now, PROCESSED_IDS: JSON.stringify([]) }, false);
  installTrigger();
  console.log("Configuration verified from Script Properties. Baseline set to %s. Trigger installed.", now);
}

/**
 * Ensures a single 5-min time-driven trigger exists for checkForNewFiles.
 */
function installTrigger() {
  const handler = "checkForNewFiles";
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(5).create();
}

/**
 * Main job: finds new files added since the last run and posts to LINE.
 *
 * Concurrency: a script lock keeps overlapping triggers from running in parallel.
 * LAST_CHECK is captured BEFORE the Drive query so files created during the run
 *   are not silently skipped next time.
 * Budget: once the run passes MAX_RUN_MS the send loop breaks and is treated like
 *   a delivery failure, so the state below is still saved and the remaining files
 *   wait for the next run instead of being lost to the execution timeout.
 * Errors: LINE delivery failure logs the error and leaves LAST_CHECK untouched,
 *   so failed files are retried on the next run. Files from successfully delivered
 *   batches are recorded in PROCESSED_IDS to avoid duplicate notifications.
 */
function checkForNewFiles() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log("Another instance is already running. Skipping this execution.");
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const folderId = props.getProperty("FOLDER_ID");
    const lineToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
    const lineTargetId = props.getProperty("LINE_TARGET_ID");
    if (!folderId || !lineToken || !lineTargetId) {
      throw new Error(
        "Missing configuration. Run setConfig() to initialize (FOLDER_ID + LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID).",
      );
    }

    let lastCheck = props.getProperty("LAST_CHECK");
    if (!lastCheck) {
      lastCheck = new Date().toISOString();
      props.setProperty("LAST_CHECK", lastCheck);
      return; // Initialize baseline silently
    }

    // Capture "now" BEFORE querying Drive so files created during this run
    // are included next execution rather than silently dropped.
    const now = new Date().toISOString();

    let processed = [];
    const raw = props.getProperty("PROCESSED_IDS");
    if (raw) {
      try {
        processed = JSON.parse(raw) || [];
      } catch (_) {
        processed = [];
      }
    }

    const query = `('${folderId}' in parents) and trashed = false and createdTime > '${lastCheck}'`;
    const newFiles = listAllFiles(query);

    const pendingFiles = [];
    for (const f of newFiles) {
      if (!processed.includes(f.id)) {
        pendingFiles.push(f);
      }
    }

    // ponytail: Discord が削除され LINE 単独となったため、追加のカーソルを持たずに
    // 送信成功したバッチのみ PROCESSED_IDS に記録し、失敗時は LAST_CHECK を進めないことで
    // 最小限の状態管理で未送信ファイルの再送を実現する。
    let hasFailure = false;
    const startedAt = Date.now(); // Drive クエリ後のここから計る（クエリ時間も予算に含める）
    if (pendingFiles.length) {
      for (let i = 0; i < pendingFiles.length; i += 5) {
        if (Date.now() - startedAt > MAX_RUN_MS) {
          hasFailure = true;
          console.warn(
            "実行時間予算 (%d ms) を使い切ったので残り %d 件は次回実行に回します。",
            MAX_RUN_MS,
            pendingFiles.length - i,
          );
          break;
        }
        const batchFiles = pendingFiles.slice(i, i + 5);
        const batchMessages = batchFiles.map(buildFileMessage);
        try {
          postToLine(lineToken, lineTargetId, batchMessages);
          for (const f of batchFiles) {
            processed.push(f.id);
          }
          if (processed.length > 200) processed = processed.slice(-200);
        } catch (e) {
          hasFailure = true;
          console.error("LINE への通知に失敗しました (%d件): %s", batchFiles.length, e.message);
        }
      }
    }

    if (hasFailure) {
      props.setProperty("PROCESSED_IDS", JSON.stringify(processed));
    } else {
      props.setProperties(
        { LAST_CHECK: now, PROCESSED_IDS: JSON.stringify(processed) },
        false,
      );
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Lists files matching the query, ordered by createdTime asc.
 * @returns {object[]}
 */
function listAllFiles(q) {
  const files = [];
  let pageToken;
  do {
    const resp = Drive.Files.list({
      q,
      orderBy: "createdTime asc",
      pageSize: 100,
      fields: "nextPageToken, files(id,name,createdTime,webViewLink,mimeType,size)",
      pageToken,
    });
    if (resp && resp.files && resp.files.length) files.push(...resp.files);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Formats a byte count into a human-readable string (B / KB / MB).
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 新規ファイル通知メッセージを構築 (LINE 向けプレーンテキスト)。
 * @param {object} file Drive.Files.list の file 要素
 * @returns {string}
 */
function buildFileMessage(file) {
  const createdJst = Utilities.formatDate(new Date(file.createdTime), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
  const lines = ["【ScanSnap 新着ファイル】", `- ファイル名: ${file.name || "(無名)"}`];
  lines.push(`- 作成日時: ${createdJst} JST`);
  if (file.size) lines.push(`- サイズ: ${formatFileSize(Number(file.size))}`);
  if (file.webViewLink) lines.push(`- リンク: ${file.webViewLink}`);
  lines.push("- 送信元: ScanSnap Drive Watcher");
  return lines.join("\n");
}

/**
 * LINE Messaging API の push エンドポイントへ送信（429 時は Retry-After に従いリトライ）。
 * @param {string} channelAccessToken LINE_CHANNEL_ACCESS_TOKEN
 * @param {string} targetId LINE_TARGET_ID (ユーザー/グループ/トークルーム ID)
 * @param {string[]} messages 1 push に含めるテキストメッセージ配列 (最大 5)
 */
function postToLine(channelAccessToken, targetId, messages) {
  fetchWithRetry(LINE_PUSH_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    payload: JSON.stringify({ to: targetId, messages: messages.map((text) => ({ type: "text", text })) }),
    muteHttpExceptions: true,
  }, LINE_RETRIES, [400, 401]);
}

/**
 * UrlFetch with 429/5xx retry + Retry-After honoring. 2xx returns the response;
 * fatalCodes and any other non-2xx throw immediately. Retries back off
 * exponentially 1s -> 2s -> 4s unless Retry-After says otherwise, and give up
 * once the per-request sleep budget MAX_RETRY_SLEEP_MS is used up.
 */
function fetchWithRetry(url, params, maxRetries, fatalCodes) {
  let accumulatedSleepMs = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = UrlFetchApp.fetch(url, params);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) return resp;
    if (fatalCodes && fatalCodes.includes(code)) {
      throw new Error(`Fatal HTTP ${code}: ${resp.getContentText()}`);
    }

    const isRetryable = code === 429 || (code >= 500 && code < 600);
    if (!isRetryable || attempt === maxRetries - 1) {
      throw new Error(`HTTP ${code}: ${resp.getContentText()}`);
    }

    const headers = resp.getHeaders();
    const retryAfter = headers["Retry-After"] || headers["retry-after"];
    let delayMs;
    if (retryAfter && !isNaN(Number(retryAfter))) {
      delayMs = Number(retryAfter) * 1000 + 100;
    } else if (code === 429) {
      delayMs = 1100;
    } else {
      delayMs = 1000 * Math.pow(2, attempt);
    }

    if (accumulatedSleepMs + delayMs > MAX_RETRY_SLEEP_MS) {
      throw new Error(`HTTP ${code}: ${resp.getContentText()}`);
    }

    console.warn("HTTP %d: retrying in %d ms, attempt %d/%d", code, delayMs, attempt + 1, maxRetries);
    Utilities.sleep(delayMs);
    accumulatedSleepMs += delayMs;
  }
  throw new Error("fetchWithRetry requires maxRetries >= 1");
}

// ===== 設定検証ユーティリティ =====
/**
 * 現在のセットアップ状態を検証し、結果を返します。
 * 家族が「なぜ通知が届かないのか」を診断するのに便利です。
 *
 * @returns {{ready: boolean, warnings: string[], config: object}}
 */
function validateSetup() {
  const warnings = [];
  const config = {};

  const props = PropertiesService.getScriptProperties();

  // フォルダID
  const folderId = (props.getProperty("FOLDER_ID") || "").trim();
  config.folderConfigured = !!folderId;
  if (!folderId) {
    warnings.push("FOLDER_ID が未設定です。setConfig() を実行してください。");
  }

  // LINE設定
  const lineChannelAccessToken = (props.getProperty("LINE_CHANNEL_ACCESS_TOKEN") || "").trim();
  const lineTargetId = (props.getProperty("LINE_TARGET_ID") || "").trim();
  config.lineConfigured = !!(lineChannelAccessToken && lineTargetId);

  // 通知先の確認
  if (!config.lineConfigured) {
    warnings.push("通知先が未設定です。LINE の設定を行ってください。");
  }

  // トリガー状態
  const triggers = ScriptApp.getProjectTriggers();
  const hasTrigger = triggers.some(t => t.getHandlerFunction() === "checkForNewFiles");
  config.triggerActive = hasTrigger;
  if (!hasTrigger) {
    warnings.push("5分間隔のトリガーが未設定です。setConfig() を実行してください。");
  }

  const result = { ready: warnings.length === 0, warnings: warnings, config: config };
  // エディタから手動実行しただけでは戻り値が見えないため、実行ログにも結果を出す
  console.log("validateSetup: %s", JSON.stringify(result));
  return result;
}
