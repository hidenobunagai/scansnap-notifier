/**
 * Google Drive "ScanSnap" folder watcher -> Discord notifier
 * - Polls the target folder for new files since the last check
 * - Posts a rich embed message to a Discord channel via Webhook
 *
 * Setup flow:
 * 1) Set Script Properties: FOLDER_ID and DISCORD_WEBHOOK_URL.
 * 2) Run setConfig() once to initialize baseline and install a 5-min trigger.
 * 3) New files added after initialization will be announced to Discord.
 */

const PROP_KEYS = {
  FOLDER_ID: "FOLDER_ID",
  WEBHOOK: "DISCORD_WEBHOOK_URL",
  LAST_CHECK: "LAST_CHECK",
  PROCESSED_IDS: "PROCESSED_IDS",
};

/** Maximum number of pages to fetch per run (100 files/page × 10 = 1,000 files max). */
const MAX_PAGES = 10;

/** Maximum Discord webhook retry attempts on rate-limit (429). */
const MAX_WEBHOOK_RETRIES = 3;

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
  if (!folderId || !webhook) {
    throw new Error("Script Properties の FOLDER_ID / DISCORD_WEBHOOK_URL が未設定です。");
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
 * Main job: finds new files added since the last run and posts to Discord.
 * Uses Advanced Drive Service (Drive v3) with metadata.readonly scope.
 *
 * Concurrency: acquires a script lock so overlapping triggers cannot run in parallel.
 * LAST_CHECK: captured before the Drive query so files created during the run
 *   are not silently skipped on the next execution.
 * Error handling: on Discord failure the run aborts without advancing LAST_CHECK,
 *   so the failed file is retried on the next trigger while already-delivered
 *   files are protected by PROCESSED_IDS.
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
    if (!folderId || !webhook) {
      throw new Error("Missing configuration. Run setConfig() to initialize.");
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
    let hasError = false;
    for (const f of newFiles) {
      if (processed.includes(f.id)) continue;
      try {
        postToDiscord(webhook, f);
      } catch (e) {
        console.error("Discord への通知に失敗しました (id=%s): %s", f.id, e.message);
        hasError = true;
        break;
      }
      processed.push(f.id);
      if (processed.length > 200) {
        processed = processed.slice(-200);
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

  const fields = [
    { name: "📅 作成日時", value: `${createdJst} JST`, inline: true },
  ];
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
  console.log("Set Script Properties: FOLDER_ID / DISCORD_WEBHOOK_URL.");
  console.log("Then run setConfig() once to initialize and install trigger.");
  console.log("Use manualCheck() to test.");
}
