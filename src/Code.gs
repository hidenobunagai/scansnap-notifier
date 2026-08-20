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

const MAX_WEBHOOK_RETRIES = 3;
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_RETRIES = 3;

/**
 * One-time configuration.
 * - Use Script Properties for Drive folder ID and Discord Webhook URL, then run this.
 * - Initializes the baseline timestamp to "now" so existing files are not announced.
 * - Installs the time-driven trigger.
 * - The false argument preserves all other Script Properties (do not delete them).
 */
function setConfig() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty("FOLDER_ID");
  const webhook = props.getProperty("DISCORD_WEBHOOK_URL");
  const lineToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  const lineTargetId = props.getProperty("LINE_TARGET_ID");
  const hasDiscord = !!folderId && !!webhook;
  const hasLine = !!folderId && !!lineToken && !!lineTargetId;
  if (!folderId || (!hasDiscord && !hasLine)) {
    throw new Error(
      "Script Properties の FOLDER_ID と、通知先 (DISCORD_WEBHOOK_URL または LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID) が未設定です。",
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
 * Main job: finds new files added since the last run and posts to Discord / LINE.
 *
 * Concurrency: a script lock keeps overlapping triggers from running in parallel.
 * LAST_CHECK is captured BEFORE the Drive query so files created during the run
 *   are not silently skipped next time.
 * Errors: a Discord failure aborts before advancing LAST_CHECK, so the failed
 *   file is retried next run while already-delivered files are protected by PROCESSED_IDS.
 * LINE is sent after Discord in batches of <=5 messages (the Messaging API cap).
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
    const webhook = props.getProperty("DISCORD_WEBHOOK_URL");
    const lineToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
    const lineTargetId = props.getProperty("LINE_TARGET_ID");
    const hasDiscord = !!folderId && !!webhook;
    const hasLine = !!folderId && !!lineToken && !!lineTargetId;
    if (!folderId || (!hasDiscord && !hasLine)) {
      throw new Error(
        "Missing configuration. Run setConfig() to initialize (FOLDER_ID + at least one of DISCORD_WEBHOOK_URL / LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID).",
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

    let hasError = false;
    const lineMessages = [];
    for (const f of newFiles) {
      if (processed.includes(f.id)) continue;

      if (hasDiscord) {
        try {
          postToDiscord(webhook, f);
        } catch (e) {
          console.error("Discord への通知に失敗しました (id=%s): %s", f.id, e.message);
          hasError = true;
          break;
        }
      }

      if (hasLine) lineMessages.push(buildFileMessage(f));

      processed.push(f.id);
      if (processed.length > 200) processed = processed.slice(-200);
    }

    if (hasLine && !hasError && lineMessages.length) {
      for (let i = 0; i < lineMessages.length; i += 5) {
        postToLine(lineToken, lineTargetId, lineMessages.slice(i, i + 5));
      }
    }

    // Do not advance LAST_CHECK on error; unprocessed files retry next run.
    props.setProperties(
      { LAST_CHECK: hasError ? lastCheck : now, PROCESSED_IDS: JSON.stringify(processed) },
      false,
    );
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
 * Posts a rich embed message to Discord via webhook, retrying on rate-limit (429).
 */
function postToDiscord(webhookUrl, file) {
  const createdJst = Utilities.formatDate(new Date(file.createdTime), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
  const fields = [{ name: "📅 作成日時", value: `${createdJst} JST`, inline: true }];
  if (file.size) fields.push({ name: "📦 サイズ", value: formatFileSize(Number(file.size)), inline: true });

  const embed = {
    title: file.name,
    url: file.webViewLink,
    color: 0x5865f2, // Discord Blurple
    fields,
    footer: { text: "ScanSnap Drive Watcher" },
    timestamp: file.createdTime,
  };

  fetchWithRetry(webhookUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ embeds: [embed] }),
    muteHttpExceptions: true,
  }, MAX_WEBHOOK_RETRIES);
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
 * UrlFetch with 429 retry + Retry-After honoring. 2xx returns the response;
 * fatalCodes throw immediately (no retry); any other non-2xx throws after retries.
 */
function fetchWithRetry(url, params, maxRetries, fatalCodes) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = UrlFetchApp.fetch(url, params);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) return resp;
    if (fatalCodes && fatalCodes.includes(code)) {
      throw new Error(`Fatal HTTP ${code}: ${resp.getContentText()}`);
    }
    if (code === 429) {
      const headers = resp.getHeaders();
      const retryAfter = headers["Retry-After"] || headers["retry-after"] || 1;
      console.warn("Rate limit (429). Retry-After: %d s (attempt %d/%d)", retryAfter, attempt + 1, maxRetries);
      Utilities.sleep(Number(retryAfter) * 1000 + 100);
      continue;
    }
    throw new Error(`HTTP ${code}: ${resp.getContentText()}`);
  }
  throw new Error("Max retries exceeded due to rate limiting.");
}
