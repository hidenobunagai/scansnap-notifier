/**
 * Google Drive "ScanSnap" folder watcher -> Discord / LINE notifier
 * - Polls the target folder for new files since the last check
 * - Posts a rich embed message to a Discord channel via Webhook
 * - Also sends a plain-text message to a LINE user/group via Messaging API
 * - Discord / LINE はそれぞれ個別に有効化でき、両方同時にも送信可能です
 *
 * Setup flow:
 * 1) Set Script Properties: FOLDER_ID, and at least one of
 *    DISCORD_WEBHOOK_URL / LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID.
 * 2) Run setConfig() once to initialize baseline and install a 5-min trigger.
 * 3) New files added after initialization will be announced to Discord and/or LINE.
 */

const PROP_KEYS = {
  FOLDER_ID: "FOLDER_ID",
  WEBHOOK: "DISCORD_WEBHOOK_URL",
  LINE_TOKEN: "LINE_CHANNEL_ACCESS_TOKEN",
  LINE_TARGET_ID: "LINE_TARGET_ID",
  LAST_CHECK: "LAST_CHECK",
  PROCESSED_IDS: "PROCESSED_IDS",
};

/** Maximum number of pages to fetch per run (100 files/page × 10 = 1,000 files max). */
const MAX_PAGES = 10;

/** Maximum Discord webhook retry attempts on rate-limit (429). */
const MAX_WEBHOOK_RETRIES = 3;

// LINE Messaging API 関連 (LINE Notify は 2025/3 廃止のため非採用)
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_MAX_RETRIES = 3;
const LINE_MAX_TEXT_LENGTH = 5000; // 1メッセージあたりの文字数上限
const LINE_MAX_MESSAGES_PER_PUSH = 5; // 1 push あたりのメッセージ数上限
const LINE_CHUNK_INTERVAL_MS = 1000; // レート制限対策: push 間待機 (ms)

/**
 * One-time configuration.
 * - Use Script Properties for Drive folder ID and Discord Webhook URL, then run this.
 * - Initializes the baseline timestamp to "now" so existing files are not announced.
 * - Installs the time-driven trigger.
 */
function setConfig() {
  const props = PropertiesService.getScriptProperties();

  // Read required values from Script Properties (do not hardcode in code)
  const folderId = props.getProperty(PROP_KEYS.FOLDER_ID);
  const webhook = props.getProperty(PROP_KEYS.WEBHOOK);
  const lineToken = props.getProperty(PROP_KEYS.LINE_TOKEN);
  const lineTargetId = props.getProperty(PROP_KEYS.LINE_TARGET_ID);
  const hasDiscord = !!folderId && !!webhook;
  const hasLine = !!folderId && !!lineToken && !!lineTargetId;
  if (!folderId || (!hasDiscord && !hasLine)) {
    throw new Error(
      "Script Properties の FOLDER_ID と、通知先 (DISCORD_WEBHOOK_URL または LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID) が未設定です。",
    );
  }

  const now = new Date().toISOString();

  // Initialize baseline and processed list; keep existing FOLDER_ID / WEBHOOK as-is
  // Important: do not delete other script properties (like FOLDER_ID / WEBHOOK)
  // The second argument of setProperties(deleteAllOthers) must be false/omitted
  props.setProperties(
    {
      [PROP_KEYS.LAST_CHECK]: now,
      [PROP_KEYS.PROCESSED_IDS]: JSON.stringify([]),
    },
    false,
  );

  installTrigger();
  console.log(
    "Configuration verified from Script Properties. Baseline set to %s. Trigger installed.",
    now,
  );
}

/**
 * Ensures a single 5-min time-driven trigger exists for checkForNewFiles.
 */
function installTrigger() {
  const handler = "checkForNewFiles";
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(5).create();
}

/**
 * Main job: finds new files added since the last run and posts to Discord / LINE.
 * Uses Advanced Drive Service (Drive v3) with metadata.readonly scope.
 *
 * Concurrency: acquires a script lock so overlapping triggers cannot run in parallel.
 * LAST_CHECK: captured before the Drive query so files created during the run
 *   are not silently skipped on the next execution.
 * Error handling: on Discord failure the run aborts without advancing LAST_CHECK,
 *   so the failed file is retried on the next trigger while already-delivered
 *   files are protected by PROCESSED_IDS. LINE は Discord 成功後に一括送信する。
 * Truncation: when MAX_PAGES is reached, LAST_CHECK is not advanced so the
 *   remaining files in the same time window are retried on the next run.
 */
function checkForNewFiles() {
  // Prevent concurrent executions (e.g. overlapping 5-min triggers)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log("Another instance is already running. Skipping this execution.");
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const folderId = props.getProperty(PROP_KEYS.FOLDER_ID);
    const webhook = props.getProperty(PROP_KEYS.WEBHOOK);
    const lineToken = props.getProperty(PROP_KEYS.LINE_TOKEN);
    const lineTargetId = props.getProperty(PROP_KEYS.LINE_TARGET_ID);
    const hasDiscord = !!folderId && !!webhook;
    const hasLine = !!folderId && !!lineToken && !!lineTargetId;
    if (!folderId || (!hasDiscord && !hasLine)) {
      throw new Error(
        "Missing configuration. Run setConfig() to initialize (FOLDER_ID + at least one of DISCORD_WEBHOOK_URL / LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID).",
      );
    }

    let lastCheck = props.getProperty(PROP_KEYS.LAST_CHECK);
    if (!lastCheck) {
      lastCheck = new Date().toISOString();
      props.setProperty(PROP_KEYS.LAST_CHECK, lastCheck);
      return; // Initialize baseline silently
    }

    // Capture "now" BEFORE querying Drive so that files created during this run
    // are included in the next execution rather than silently dropped.
    const now = new Date().toISOString();

    let processed = [];
    const raw = props.getProperty(PROP_KEYS.PROCESSED_IDS);
    if (raw) {
      try {
        processed = JSON.parse(raw) || [];
      } catch (_) {
        processed = [];
      }
    }

    const query = `('${folderId}' in parents) and trashed = false and createdTime > '${lastCheck}'`;
    const { files: newFiles, truncated } = listAllFiles(query);

    // Post in chronological order; abort on first Discord error so the failed
    // file is retried next run (LAST_CHECK is not advanced on error).
    // LINE は個別ファイル送信ではなく後段でチャンク一括送信するため、
    // ここでは Discord の成否のみで中断判定する。
    let hasError = false;
    const lineMessages = [];
    for (const f of newFiles) {
      if (processed.includes(f.id)) continue;

      // ----- Discord 送信 -----
      if (hasDiscord) {
        try {
          postToDiscord(webhook, f);
        } catch (e) {
          console.error("Discord への通知に失敗しました (id=%s): %s", f.id, e.message);
          hasError = true;
          break;
        }
      }

      // ----- LINE 送信分のメッセージを蓄積 -----
      if (hasLine) {
        lineMessages.push(buildFileMessage(f));
      }

      processed.push(f.id);
      if (processed.length > 200) {
        processed = processed.slice(-200);
      }
    }

    // ----- LINE 一括送信 (チャンク分割) -----
    // Discord 送信が全件成功 (または未使用) の場合のみ送信し、
    // 成功した最新ファイルまでを processed に残す方針を維持する。
    if (hasLine && !hasError && lineMessages.length) {
      try {
        postToLineInChunks(lineToken, lineTargetId, lineMessages);
      } catch (e) {
        console.error("LINE への通知に失敗しました: %s", e.message);
        hasError = true;
      }
    }

    props.setProperties(
      {
        // Do not advance LAST_CHECK when Discord failed or MAX_PAGES was reached;
        // the unprocessed files will be retried on the next run.
        [PROP_KEYS.LAST_CHECK]: hasError || truncated ? lastCheck : now,
        [PROP_KEYS.PROCESSED_IDS]: JSON.stringify(processed),
      },
      false,
    );
  } finally {
    lock.releaseLock();
  }
}

/**
 * Lists files matching the query, ordered by createdTime asc.
 * Stops after MAX_PAGES pages to avoid exceeding the 6-minute execution limit.
 *
 * @returns {{ files: object[], truncated: boolean }}
 */
function listAllFiles(q) {
  const files = [];
  let pageToken;
  let pages = 0;
  let truncated = false;
  do {
    if (pages >= MAX_PAGES) {
      console.warn(
        "listAllFiles: MAX_PAGES (%d) に達しました。残りのファイルは次回実行時に処理されます。",
        MAX_PAGES,
      );
      truncated = true;
      break;
    }
    const resp = Drive.Files.list({
      q,
      orderBy: "createdTime asc",
      pageSize: 100,
      fields: "nextPageToken, files(id,name,createdTime,webViewLink,mimeType,size)",
      pageToken,
    });
    if (resp && resp.files && resp.files.length) {
      files.push(...resp.files);
    }
    pageToken = resp.nextPageToken;
    pages++;
  } while (pageToken);
  return { files, truncated };
}

/**
 * Posts a rich embed message to Discord via webhook.
 * Retries up to MAX_WEBHOOK_RETRIES times on rate-limit (HTTP 429),
 * respecting the Retry-After response header.
 */
function postToDiscord(webhookUrl, file) {
  const createdJst = Utilities.formatDate(
    new Date(file.createdTime),
    "Asia/Tokyo",
    "yyyy-MM-dd HH:mm:ss",
  );

  const fields = [{ name: "📅 作成日時", value: `${createdJst} JST`, inline: true }];
  if (file.size) {
    fields.push({ name: "📦 サイズ", value: formatFileSize(Number(file.size)), inline: true });
  }

  const embed = {
    title: file.name,
    url: file.webViewLink,
    color: 0x5865f2, // Discord Blurple
    fields,
    footer: { text: "ScanSnap Drive Watcher" },
    timestamp: file.createdTime,
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ embeds: [embed] }),
    muteHttpExceptions: true,
  };

  for (let attempt = 0; attempt < MAX_WEBHOOK_RETRIES; attempt++) {
    const resp = UrlFetchApp.fetch(webhookUrl, options);
    const code = resp.getResponseCode();

    if (code === 429) {
      const headers = resp.getHeaders();
      const retryAfterSec = Number(headers["Retry-After"] || headers["retry-after"] || 1);
      console.warn(
        "Discord rate limit (429). Retry-After: %d s (attempt %d/%d)",
        retryAfterSec,
        attempt + 1,
        MAX_WEBHOOK_RETRIES,
      );
      Utilities.sleep(retryAfterSec * 1000 + 100);
      continue;
    }

    if (code >= 300) {
      throw new Error(`Discord webhook error ${code}: ${resp.getContentText()}`);
    }

    Utilities.sleep(200); // gentle delay between consecutive posts
    return;
  }

  throw new Error("Discord webhook: max retries exceeded due to rate limiting.");
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
 * Manual runner to test current configuration.
 */
function manualCheck() {
  checkForNewFiles();
}

/**
 * Quick helper to print guidance in the logs.
 */
function help() {
  console.log(
    "Set Script Properties: FOLDER_ID + (DISCORD_WEBHOOK_URL or LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID).",
  );
  console.log("Then run setConfig() once to initialize and install trigger.");
  console.log("Use manualCheck() to test.");
}

// ===== LINE 通知 =====

/**
 * 新規ファイル通知メッセージを構築 (LINE 向けプレーンテキスト)
 * Markdown 非依存のため LINE でもそのまま表示可能。
 * @param {object} file Drive.Files.list の file 要素
 * @returns {string}
 */
function buildFileMessage(file) {
  const createdJst = Utilities.formatDate(
    new Date(file.createdTime),
    "Asia/Tokyo",
    "yyyy-MM-dd HH:mm:ss",
  );
  const lines = ["【ScanSnap 新着ファイル】", `- ファイル名: ${file.name || "(無名)"}`];
  lines.push(`- 作成日時: ${createdJst} JST`);
  if (file.size) {
    lines.push(`- サイズ: ${formatFileSize(Number(file.size))}`);
  }
  if (file.webViewLink) {
    lines.push(`- リンク: ${file.webViewLink}`);
  }
  lines.push("- 送信元: ScanSnap Drive Watcher");
  return lines.join("\n");
}

/**
 * LINE Messaging API へのメッセージ送信 (push) をチャンク分割で実行
 * @param {string} channelAccessToken LINE_CHANNEL_ACCESS_TOKEN
 * @param {string} targetId LINE_TARGET_ID (ユーザー/グループ/トークルーム ID)
 * @param {string[]} messages 各ファイルの通知メッセージ配列
 */
function postToLineInChunks(channelAccessToken, targetId, messages) {
  const sep = "\n\n";
  const chunks = [];
  let buffer = "";
  for (const rawMsg of messages) {
    const msg = normalizeLineMessage(rawMsg, LINE_MAX_TEXT_LENGTH);
    if (!msg) continue;

    const joined = buffer ? buffer + sep + msg : msg;
    // LINE_MAX_TEXT_LENGTH を超える場合は新しいチャンクへ
    if (joined.length > LINE_MAX_TEXT_LENGTH) {
      if (buffer) chunks.push(buffer);
      buffer = msg;
    } else {
      buffer = joined;
    }
  }
  if (buffer) chunks.push(buffer);

  // LINE_MAX_MESSAGES_PER_PUSH 件ずつ 1 push にまとめて送信
  for (let i = 0; i < chunks.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
    if (i > 0) Utilities.sleep(LINE_CHUNK_INTERVAL_MS);
    const batch = chunks.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH);
    postToLine(channelAccessToken, targetId, batch);
  }
}

/**
 * LINE メッセージを LINE_MAX_TEXT_LENGTH に収まるよう丸める
 */
function normalizeLineMessage(message, maxLen) {
  if (!message) return "";
  if (message.length <= maxLen) return message;
  const ellipsis = "…";
  const limit = Math.max(maxLen - ellipsis.length, 0);
  return `${message.slice(0, limit)}${ellipsis}`;
}

/**
 * LINE Messaging API の push エンドポイントへ送信（429 時は Retry-After に従いリトライ）
 * @param {string} channelAccessToken
 * @param {string} targetId
 * @param {string[]} messageTexts 1 push に含めるテキストメッセージ配列 (最大 LINE_MAX_MESSAGES_PER_PUSH)
 */
function postToLine(channelAccessToken, targetId, messageTexts) {
  const payload = {
    to: targetId,
    messages: messageTexts.map((text) => ({ type: "text", text })),
  };
  const params = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  for (let attempt = 1; attempt <= LINE_MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(LINE_PUSH_URL, params);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return;

    // 401 (認証エラー) / 400 (リクエスト不正) はリトライせず即時例外
    if (code === 401 || code === 400) {
      const body = res.getContentText();
      throw new Error(
        `LINE 認証/リクエストエラー (${code}): ${body} - アクセストークン/ターゲットIDを確認してください`,
      );
    }

    if (code === 429 && attempt < LINE_MAX_RETRIES) {
      let waitMs = LINE_CHUNK_INTERVAL_MS * attempt;
      const retryAfter = res.getHeaders()["Retry-After"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!Number.isNaN(parsed)) waitMs = parsed * 1000;
      }
      console.warn(
        "LINE レート制限 (429)。%d ms 後にリトライ (%d/%d)",
        waitMs,
        attempt,
        LINE_MAX_RETRIES,
      );
      Utilities.sleep(waitMs);
      continue;
    }

    const body = res.getContentText();
    throw new Error(`LINE 送信エラー (${code}): ${body}`);
  }
}
