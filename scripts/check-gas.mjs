import fs from "node:fs";
import path from "node:path";

const GAS_DIR = fs.existsSync("gas") ? "gas" : "src";
const files = fs
  .readdirSync(GAS_DIR)
  .filter((f) => f.endsWith(".gs"))
  .sort();

console.log(`Checking ${files.length} GAS files in ${GAS_DIR}/: ${files.join(", ")}`);

let hasError = false;
const declaredFunctions = new Set();
const declaredVariables = new Set();

// 1. 各ファイルの構文検査 & トップレベル宣言の収集
for (const file of files) {
  const filePath = path.join(GAS_DIR, file);
  const code = fs.readFileSync(filePath, "utf-8");

  // 単体構文チェック
  try {
    new Function(code);
  } catch (err) {
    console.error(`Syntax error in ${filePath}:`, err.message);
    hasError = true;
  }

  // トップレベル関数と変数宣言の収集
  const fnMatches = code.matchAll(/^function\s+([a-zA-Z0-9_$]+)\s*\(/gm);
  for (const m of fnMatches) {
    const fnName = m[1];
    if (declaredFunctions.has(fnName)) {
      console.error(`Duplicate function declaration: "${fnName}" in ${filePath}`);
      hasError = true;
    }
    declaredFunctions.add(fnName);
  }

  const varMatches = code.matchAll(/^(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/gm);
  for (const m of varMatches) {
    const varName = m[1];
    if (declaredVariables.has(varName)) {
      console.error(`Duplicate variable declaration: "${varName}" in ${filePath}`);
      hasError = true;
    }
    declaredVariables.add(varName);
  }
}

// 2. 連結した全体の構文チェック (GAS はプロジェクト内の全 .gs が同一グローバルスコープで共有される)
const combinedCode = files
  .map((f) => fs.readFileSync(path.join(GAS_DIR, f), "utf-8"))
  .join("\n\n");

try {
  new Function(combinedCode);
} catch (err) {
  console.error("Syntax error in combined GAS files:", err.message);
  hasError = true;
}

// 3. 呼び出し箇所の静的未定義検査
const KNOWN_GLOBALS = new Set([
  "Logger",
  "PropertiesService",
  "Utilities",
  "UrlFetchApp",
  "ScriptApp",
  "Session",
  "LockService",
  "CalendarApp",
  "DriveApp",
  "GmailApp",
  "SpreadsheetApp",
  "DocumentApp",
  "Maps",
  "LanguageApp",
  "CacheService",
  "ContentService",
  "HtmlService",
  "XmlService",
  "JSON",
  "Math",
  "Date",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Map",
  "Set",
  "Promise",
  "console",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "undefined",
  "NaN",
  "Infinity",
  "Intl",
  "setTimeout",
  "clearTimeout",
  "BigInt",
  "Symbol",
  "eval",
  "globalThis",
]);

const callMatches = combinedCode.matchAll(/\b([a-zA-Z0-9_$]+)\s*\(/g);
const unknownCalls = new Set();
for (const m of callMatches) {
  const name = m[1];
  if (
    [
      "if",
      "for",
      "while",
      "switch",
      "catch",
      "function",
      "return",
      "typeof",
      "delete",
      "throw",
      "import",
      "export",
      "new",
    ].includes(name)
  ) {
    continue;
  }
  if (!declaredFunctions.has(name) && !declaredVariables.has(name) && !KNOWN_GLOBALS.has(name)) {
    const idx = m.index;
    if (idx > 0 && combinedCode[idx - 1] === ".") {
      continue;
    }
    unknownCalls.add(name);
  }
}

if (unknownCalls.size > 0) {
  console.warn(`Warning: Potential undeclared function calls: ${[...unknownCalls].join(", ")}`);
}

if (hasError) {
  console.error("GAS check failed.");
  process.exit(1);
} else {
  console.log(
    `GAS check passed: ${declaredFunctions.size} functions, ${declaredVariables.size} top-level variables verified.`,
  );
}
