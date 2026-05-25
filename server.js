const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const rootDir = __dirname;
const webDir = path.join(rootDir, "web");
const dataDir = path.join(rootDir, "data");
const hotWordsFilePath = path.join(dataDir, "user-hotwords.json");
const settingsFilePath = path.join(dataDir, "user-settings.json");

loadLocalEnv(path.join(rootDir, ".env.local"));

const port = Number(process.env.PORT || 4173);
const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || "";
const dashscopeBaseUrl =
  process.env.DASHSCOPE_BASE_URL ||
  "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const dashscopeModel = process.env.DASHSCOPE_MODEL || "fun-asr-realtime";
const dashscopeLanguage = process.env.DASHSCOPE_LANGUAGE || "zh";
const dashscopeSampleRate = Number(process.env.DASHSCOPE_SAMPLE_RATE || 16000);
const fallbackVocabularyId = process.env.DASHSCOPE_VOCABULARY_ID || "";
const dashscopeHttpBaseUrl =
  process.env.DASHSCOPE_HTTP_BASE_URL ||
  "https://dashscope.aliyuncs.com";
const dashscopeHotWordsTargetModel =
  process.env.DASHSCOPE_HOT_WORDS_TARGET_MODEL ||
  (dashscopeModel.startsWith("fun-asr") ? "fun-asr" : dashscopeModel);
const dashscopeTextModel = process.env.DASHSCOPE_TEXT_MODEL || "qwen-plus";
const dashscopeOpenAiBaseUrl =
  process.env.DASHSCOPE_OPENAI_BASE_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

const DEFAULT_USER_SETTINGS = {
  shortcut: process.env.VOICE_ASSISTANT_SHORTCUT || "CommandOrControl+Space",
  microphoneDeviceId: "",
  microphoneDeviceName: "",
  aiPostProcessEnabled: false,
  aiScenario: "general"
};

const AI_SCENARIOS = {
  general: {
    label: "通用",
    instruction: "适合日常输入。保留用户原意，只做轻量纠错、标点、去重复和去除明显语气助词。"
  },
  office: {
    label: "办公",
    instruction: "适合工作沟通。表达清晰、克制、可直接发给同事，不增加没有说出的结论。"
  },
  tech: {
    label: "技术",
    instruction: "适合技术讨论。保留技术名词、中英文缩写、命令和产品名，不随意翻译或改写专有词。"
  },
  email: {
    label: "邮件",
    instruction: "适合邮件和正式留言。语气礼貌、结构自然，但不要扩写事实，不要替用户添加承诺。"
  }
};

let hotWordsState = loadHotWordsState();
let userSettings = loadUserSettings();

function createTraceId(prefix = "asr") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTranscriptionError(error) {
  const message = String(error?.message || "");
  return /timeout|before task start|ECONNRESET|ETIMEDOUT|socket hang up|closed unexpectedly|Unexpected server response|WebSocket error/i.test(
    message
  );
}

function logTranscription(traceId, stage, details = {}) {
  console.log(
    JSON.stringify({
      scope: "transcribe",
      traceId,
      stage,
      ts: new Date().toISOString(),
      ...details
    })
  );
}

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

async function readRequestBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const current = Buffer.from(chunk);
    total += current.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large");
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(current);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeHotWords(words) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(words) ? words : []) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized.slice(0, 200);
}

function normalizeUserSettings(input = {}) {
  const scenario = AI_SCENARIOS[input.aiScenario] ? input.aiScenario : DEFAULT_USER_SETTINGS.aiScenario;
  return {
    ...DEFAULT_USER_SETTINGS,
    ...input,
    shortcut: String(input.shortcut || DEFAULT_USER_SETTINGS.shortcut),
    microphoneDeviceId: String(input.microphoneDeviceId || ""),
    microphoneDeviceName: String(input.microphoneDeviceName || ""),
    aiPostProcessEnabled: Boolean(input.aiPostProcessEnabled),
    aiScenario: scenario
  };
}

function loadUserSettings() {
  try {
    if (!fs.existsSync(settingsFilePath)) return { ...DEFAULT_USER_SETTINGS };
    return normalizeUserSettings(JSON.parse(fs.readFileSync(settingsFilePath, "utf8")));
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

function saveUserSettings(nextSettings) {
  userSettings = normalizeUserSettings(nextSettings);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFilePath, JSON.stringify(userSettings, null, 2), "utf8");
  return userSettings;
}

function loadHotWordsState() {
  try {
    if (!fs.existsSync(hotWordsFilePath)) {
      return {
        words: [],
        vocabularyId: "",
        dirty: false,
        updatedAt: ""
      };
    }
    const parsed = JSON.parse(fs.readFileSync(hotWordsFilePath, "utf8"));
    return {
      words: normalizeHotWords(parsed.words),
      vocabularyId: String(parsed.vocabularyId || ""),
      dirty: Boolean(parsed.dirty),
      updatedAt: String(parsed.updatedAt || "")
    };
  } catch {
    return {
      words: [],
      vocabularyId: "",
      dirty: false,
      updatedAt: ""
    };
  }
}

function saveHotWordsState(nextState) {
  hotWordsState = {
    words: normalizeHotWords(nextState.words),
    vocabularyId: String(nextState.vocabularyId || ""),
    dirty: Boolean(nextState.dirty),
    updatedAt: nextState.updatedAt || new Date().toISOString()
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(hotWordsFilePath, JSON.stringify(hotWordsState, null, 2), "utf8");
  return hotWordsState;
}

function getActiveVocabularyId() {
  return hotWordsState.vocabularyId || fallbackVocabularyId;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };
  return map[ext] || "application/octet-stream";
}

function resolveStaticFile(requestPath) {
  const safePath =
    requestPath === "/" || requestPath === "/index.html"
      ? "/index.html"
      : requestPath.startsWith("/web/")
        ? requestPath.replace(/^\/web/, "")
        : requestPath;
  const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(webDir, normalized);
  if (!filePath.startsWith(webDir)) {
    return null;
  }
  return filePath;
}

function createRunTaskMessage(taskId) {
  const vocabularyId = getActiveVocabularyId();
  const parameters = {
    format: "pcm",
    sample_rate: dashscopeSampleRate,
    language: dashscopeLanguage
  };

  if (vocabularyId) {
    parameters.vocabulary_id = vocabularyId;
  }

  return {
    header: {
      action: "run-task",
      task_id: taskId,
      streaming: "duplex"
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: dashscopeModel,
      parameters,
      input: {}
    }
  };
}

function createFinishTaskMessage(taskId) {
  return {
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex"
    },
    payload: {
      input: {}
    }
  };
}

function createWsEventMessage(traceId, type, payload = {}) {
  return JSON.stringify({
    traceId,
    type,
    ...payload
  });
}

function createSentenceBuffer() {
  return {
    finalized: [],
    current: "",
    update(sentence) {
      const text = String(sentence?.text || "").trim();
      if (!text) return "";

      this.current = text;

      if (sentence?.sentence_end) {
        const last = this.finalized[this.finalized.length - 1];
        if (last !== text) {
          this.finalized.push(text);
        }
      }

      return text;
    },
    buildFinalText(fallback = "") {
      const finalText = this.finalized.join("");
      return finalText || this.current || fallback || "";
    }
  };
}

function cleanTranscriptLocally(text) {
  let output = String(text || "").trim();
  if (!output) return "";

  output = output
    .replace(/\s+/g, " ")
    .replace(/([，。！？、,.!?])\1+/g, "$1")
    .replace(/(?:^|[，。！？\s])(嗯+|呃+|额+|啊+|呀+|就是|那个|然后)(?=[，。！？\s]|$)/g, "")
    .replace(/(.{2,40})\1{2,}/g, "$1")
    .replace(/(.{4,80})\1+/g, "$1")
    .replace(/\s+([，。！？,.!?])/g, "$1")
    .replace(/([，。！？])\s+/g, "$1")
    .trim();

  if (output && !/[。！？!?]$/.test(output)) {
    output += "。";
  }
  return output;
}

function buildPostProcessPrompt(text, scenarioKey) {
  const scenario = AI_SCENARIOS[scenarioKey] || AI_SCENARIOS.general;
  return [
    {
      role: "system",
      content: [
        "你是语音输入文本后处理器，只输出处理后的中文文本。",
        "必须保守处理，不能新增事实，不能改变用户立场，不能扩写用户没有说出的内容。",
        "任务：去除明显重复、添加必要标点、修正常见识别错字、去掉语气助词和口头禅。",
        "如果原文已经清楚，就尽量少改。",
        "不要输出解释、不要输出“请提供文本”、不要输出任何客服式提示。",
        "如果输入内容不可理解，原样返回输入文本。",
        "保留专有名词、英文缩写、代码名、产品名和数字。",
        `场景：${scenario.label}。${scenario.instruction}`
      ].join("\n")
    },
    {
      role: "user",
      content: `请处理下面的语音转写文本，只返回最终可使用文本：\n${text}`
    }
  ];
}

function isBadPostProcessOutput(output) {
  return /请提供|无法处理|没有提供|作为|我可以|以下是|处理后的文本/i.test(String(output || ""));
}

async function postProcessText(text, options = {}) {
  const originalText = String(text || "").trim();
  const localText = cleanTranscriptLocally(originalText);
  const scenario = AI_SCENARIOS[options.scenario] ? options.scenario : userSettings.aiScenario;

  if (!originalText) {
    return {
      text: "",
      originalText,
      changed: false,
      mode: "empty",
      scenario
    };
  }

  if (!options.enabled) {
    return {
      text: originalText,
      originalText,
      changed: false,
      mode: "disabled",
      scenario
    };
  }

  if (!dashscopeApiKey) {
    return {
      text: localText || originalText,
      originalText,
      changed: (localText || originalText) !== originalText,
      mode: "local",
      scenario,
      warning: "DASHSCOPE_API_KEY is not configured"
    };
  }

  try {
    const response = await fetch(`${dashscopeOpenAiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dashscopeApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: dashscopeTextModel,
        messages: buildPostProcessPrompt(localText || originalText, scenario),
        temperature: 0.1,
        max_tokens: 800
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || data.error?.message || `DashScope text request failed: ${response.status}`);
    }
    const output = String(data.choices?.[0]?.message?.content || "").trim();
    const finalText = output && !isBadPostProcessOutput(output) ? output : (localText || originalText);
    return {
      text: finalText,
      originalText,
      changed: finalText !== originalText,
      mode: "dashscope",
      scenario,
      model: dashscopeTextModel
    };
  } catch (error) {
    return {
      text: localText || originalText,
      originalText,
      changed: (localText || originalText) !== originalText,
      mode: "local",
      scenario,
      warning: error.message
    };
  }
}

async function transcribeWithDashScope(audioBuffer, options = {}) {
  const traceId = options.traceId || createTraceId();
  const logger = typeof options.logger === "function" ? options.logger : () => {};

  return new Promise((resolve, reject) => {
    let ws;
    const taskId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 32);
    let settled = false;
    let started = false;
    let finishSent = false;
    let requestId = "";
    const sentenceBuffer = createSentenceBuffer();
    const timings = {
      requestStartedAt: Date.now()
    };
    const timeout = setTimeout(() => {
      fail(new Error("DashScope ASR timeout"));
    }, 45000);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error.traceId = traceId;
      error.requestId = requestId || null;
      error.timings = {
        ...timings,
        elapsedMs: Date.now() - timings.requestStartedAt
      };
      logger("failed", {
        message: error.message,
        requestId: error.requestId,
        elapsedMs: error.timings.elapsedMs
      });
      try {
        ws.close();
      } catch {}
      reject(error);
    };

    const succeed = (text, raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const elapsedMs = Date.now() - timings.requestStartedAt;
      logger("succeeded", {
        requestId,
        elapsedMs,
        textLength: text.length
      });
      try {
        ws.close();
      } catch {}
      resolve({
        text,
        raw,
        traceId,
        requestId: requestId || null,
        timings: {
          ...timings,
          elapsedMs
        }
      });
    };

    const sendAudioFrames = async () => {
      if (finishSent || settled) return;
      const frameSize = 3200;
      const frameIntervalMs = 100;
      let frameCount = 0;

      logger("audio_send_started", {
        bytes: audioBuffer.length
      });

      for (let offset = 0; offset < audioBuffer.length; offset += frameSize) {
        if (settled) return;
        const frame = audioBuffer.subarray(offset, offset + frameSize);
        ws.send(frame);
        frameCount += 1;
        if (frameCount === 1) {
          timings.firstAudioFrameSentAt = Date.now();
        }
        if (offset + frameSize < audioBuffer.length) {
          await sleep(frameIntervalMs);
        }
      }

      timings.audioSentAt = Date.now();
      logger("audio_send_finished", {
        frameCount,
        elapsedMs: timings.audioSentAt - timings.requestStartedAt
      });

      if (!finishSent && !settled) {
        finishSent = true;
        ws.send(JSON.stringify(createFinishTaskMessage(taskId)));
        timings.finishTaskSentAt = Date.now();
        logger("finish_task_sent", {
          elapsedMs: timings.finishTaskSentAt - timings.requestStartedAt
        });
      }
    };

    ws = new WebSocket(dashscopeBaseUrl, {
      headers: {
        Authorization: `bearer ${dashscopeApiKey}`
      }
    });

    ws.on("open", () => {
      logger("ws_open", {
        taskId
      });
      ws.send(JSON.stringify(createRunTaskMessage(taskId)));
    });

    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        return;
      }

      const event = message?.header?.event;
      if (event === "task-started") {
        started = true;
        requestId =
          message?.header?.request_id ||
          message?.header?.requestId ||
          message?.header?.task_id ||
          taskId;
        timings.taskStartedAt = Date.now();
        logger("task_started", {
          requestId,
          elapsedMs: timings.taskStartedAt - timings.requestStartedAt
        });
        sendAudioFrames().catch((error) => {
          fail(error);
        });
        return;
      }

      if (event === "result-generated") {
        const sentence = message?.payload?.output?.sentence;
        const text = sentenceBuffer.update(sentence);
        if (text) {
          if (!timings.firstResultAt) {
            timings.firstResultAt = Date.now();
            logger("first_result", {
              elapsedMs: timings.firstResultAt - timings.requestStartedAt,
              textLength: text.length
            });
          }
        }
        return;
      }

      if (event === "task-finished") {
        timings.taskFinishedAt = Date.now();
        requestId =
          requestId ||
          message?.header?.request_id ||
          message?.header?.requestId ||
          message?.header?.task_id ||
          taskId;
        const finalText = sentenceBuffer.buildFinalText(
          message?.payload?.output?.sentence?.text || ""
        );
        logger("task_finished", {
          requestId,
          elapsedMs: timings.taskFinishedAt - timings.requestStartedAt,
          textLength: finalText.length
        });
        succeed(finalText, message);
        return;
      }

      if (event === "task-failed") {
        const errorMessage = message?.header?.error_message || "DashScope ASR failed";
        logger("task_failed", {
          errorMessage
        });
        fail(new Error(errorMessage));
      }
    });

    ws.on("error", (error) => {
      logger("ws_error", {
        message: error.message
      });
      fail(error);
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      const message = started
        ? `DashScope WebSocket closed before task finished: ${code} ${reason}`
        : `DashScope WebSocket closed before task start: ${code} ${reason}`;
      logger("ws_close", {
        code,
        reason: String(reason)
      });
      fail(new Error(message));
    });
  });
}

async function handleTranscribe(req, res) {
  const traceId = String(req.headers["x-trace-id"] || createTraceId());
  const logger = (stage, details = {}) => logTranscription(traceId, stage, details);
  const chunks = [];
  logger("request_received", {
    contentLength: Number(req.headers["content-length"] || 0),
    remoteAddress: req.socket?.remoteAddress || ""
  });

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const audioBuffer = Buffer.concat(chunks);

  if (!audioBuffer.length) {
    logger("empty_audio");
    sendJson(res, 400, { error: "empty_audio", traceId });
    return;
  }

  if (!dashscopeApiKey) {
    logger("api_key_missing");
    sendJson(res, 500, {
      error: "dashscope_api_key_missing",
      message: "DASHSCOPE_API_KEY is not configured",
      traceId,
      retryable: false
    });
    return;
  }

  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logger("attempt_start", {
        attempt,
        audioBytes: audioBuffer.length
      });
      const result = await transcribeWithDashScope(audioBuffer, {
        traceId,
        logger: (stage, details = {}) => logger(stage, { attempt, ...details })
      });
      sendJson(res, 200, {
        text: result.text || "",
        raw: result.raw,
        traceId: result.traceId,
        requestId: result.requestId,
        mode: "realtime",
        timings: result.timings
      });
      logger("request_succeeded", {
        attempt,
        requestId: result.requestId,
        elapsedMs: result.timings?.elapsedMs || null
      });
      return;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableTranscriptionError(error);
      logger("attempt_failed", {
        attempt,
        message: error.message,
        retryable
      });
      if (attempt < maxAttempts && retryable) {
        await sleep(300 * attempt);
        continue;
      }
      break;
    }
  }

  sendJson(res, 502, {
    error: "dashscope_transcription_failed",
    message: lastError?.message || "DashScope ASR failed",
    traceId,
    retryable: isRetryableTranscriptionError(lastError)
  });
  logger("request_failed", {
    message: lastError?.message || "DashScope ASR failed"
  });
}

async function handlePostProcess(req, res) {
  try {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const result = await postProcessText(body.text, {
      enabled: Boolean(body.enabled),
      scenario: body.scenario || userSettings.aiScenario
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 400, {
      error: "post_process_failed",
      message: error.message
    });
  }
}

function sendSettings(res) {
  sendJson(res, 200, {
    settings: userSettings,
    scenarios: Object.entries(AI_SCENARIOS).map(([id, item]) => ({
      id,
      label: item.label,
      description: item.instruction
    }))
  });
}

async function handleSaveSettings(req, res) {
  try {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const nextState = saveUserSettings({
      ...userSettings,
      ...body
    });
    sendJson(res, 200, {
      settings: nextState
    });
  } catch (error) {
    sendJson(res, 400, {
      error: "settings_save_failed",
      message: error.message
    });
  }
}

function sendHotWords(res) {
  sendJson(res, 200, {
    words: hotWordsState.words,
    vocabularyId: hotWordsState.vocabularyId,
    fallbackVocabularyId,
    activeVocabularyId: getActiveVocabularyId(),
    dirty: hotWordsState.dirty,
    updatedAt: hotWordsState.updatedAt
  });
}

async function handleSaveHotWords(req, res) {
  try {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const words = normalizeHotWords(body.words);
    const wordsChanged = JSON.stringify(words) !== JSON.stringify(hotWordsState.words);
    const nextState = saveHotWordsState({
      ...hotWordsState,
      words,
      dirty: wordsChanged ? true : hotWordsState.dirty
    });
    sendJson(res, 200, {
      words: nextState.words,
      vocabularyId: nextState.vocabularyId,
      activeVocabularyId: getActiveVocabularyId(),
      dirty: nextState.dirty,
      updatedAt: nextState.updatedAt
    });
  } catch (error) {
    sendJson(res, error.code === "body_too_large" ? 413 : 400, {
      error: "hot_words_save_failed",
      message: error.message
    });
  }
}

async function requestDashScopeVocabulary(action, payload) {
  const response = await fetch(`${dashscopeHttpBaseUrl.replace(/\/$/, "")}/api/v1/services/audio/asr/customization`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${dashscopeApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "speech-biasing",
      input: {
        action,
        ...payload
      }
    })
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.code) {
    const error = new Error(data.message || data.Message || `DashScope hot words request failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function extractVocabularyId(response) {
  return (
    response?.output?.vocabulary_id ||
    response?.output?.vocabularyId ||
    response?.vocabulary_id ||
    response?.vocabularyId ||
    ""
  );
}

async function syncHotWordsWithDashScope(words, vocabularyId = "") {
  const action = vocabularyId ? "update_vocabulary" : "create_vocabulary";
  const payload = {
    prefix: "voice-assistant",
    target_model: dashscopeHotWordsTargetModel,
    vocabulary: words.map((text) => ({
      text,
      weight: 4,
      lang: dashscopeLanguage
    }))
  };

  if (vocabularyId) {
    payload.vocabulary_id = vocabularyId;
  }

  const response = await requestDashScopeVocabulary(action, payload);
  return extractVocabularyId(response) || vocabularyId;
}

async function handleSyncHotWords(_req, res) {
  if (!dashscopeApiKey) {
    sendJson(res, 500, {
      error: "dashscope_api_key_missing",
      message: "DASHSCOPE_API_KEY is not configured"
    });
    return;
  }

  if (!hotWordsState.words.length) {
    const nextState = saveHotWordsState({
      words: [],
      vocabularyId: "",
      dirty: false
    });
    sendJson(res, 200, {
      words: nextState.words,
      vocabularyId: "",
      activeVocabularyId: fallbackVocabularyId,
      dirty: false,
      updatedAt: nextState.updatedAt
    });
    return;
  }

  try {
    const vocabularyId = await syncHotWordsWithDashScope(hotWordsState.words, hotWordsState.vocabularyId);
    const nextState = saveHotWordsState({
      words: hotWordsState.words,
      vocabularyId,
      dirty: false
    });
    sendJson(res, 200, {
      words: nextState.words,
      vocabularyId: nextState.vocabularyId,
      activeVocabularyId: getActiveVocabularyId(),
      dirty: false,
      updatedAt: nextState.updatedAt
    });
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
      error: "hot_words_sync_failed",
      message: error.message,
      details: error.details || null
    });
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || "/", true);
  const pathname = parsedUrl.pathname || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (pathname === "/api/transcribe" && req.method === "POST") {
    await handleTranscribe(req, res);
    return;
  }

  if (pathname === "/api/post-process" && req.method === "POST") {
    await handlePostProcess(req, res);
    return;
  }

  if (pathname === "/api/settings" && req.method === "GET") {
    sendSettings(res);
    return;
  }

  if (pathname === "/api/settings" && req.method === "POST") {
    await handleSaveSettings(req, res);
    return;
  }

  if (pathname === "/api/hot-words" && req.method === "GET") {
    sendHotWords(res);
    return;
  }

  if (pathname === "/api/hot-words" && req.method === "POST") {
    await handleSaveHotWords(req, res);
    return;
  }

  if (pathname === "/api/hot-words/sync" && req.method === "POST") {
    await handleSyncHotWords(req, res);
    return;
  }

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      dashscopeConfigured: Boolean(dashscopeApiKey),
      hotWords: {
        activeVocabularyId: getActiveVocabularyId(),
        userVocabularyId: hotWordsState.vocabularyId,
        fallbackVocabularyId,
        dirty: hotWordsState.dirty,
        count: hotWordsState.words.length
      },
      model: dashscopeModel,
      baseUrl: dashscopeBaseUrl,
      textModel: dashscopeTextModel,
      postProcessEnabled: userSettings.aiPostProcessEnabled,
      aiScenario: userSettings.aiScenario
    });
    return;
  }

  if (pathname === "/") {
    res.writeHead(302, {
      Location: "/web/index.html",
      "Access-Control-Allow-Origin": "*"
    });
    res.end();
    return;
  }

  const staticPath = resolveStaticFile(pathname);
  if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    res.writeHead(200, {
      "Content-Type": getMimeType(staticPath),
      "Access-Control-Allow-Origin": "*"
    });
    fs.createReadStream(staticPath).pipe(res);
    return;
  }

  sendText(res, 404, "Not Found");
});

server.on("upgrade", (request, socket, head) => {
  const parsedUrl = url.parse(request.url || "/", true);
  if (parsedUrl.pathname === "/api/asr-stream") {
    asrStreamServer.handleUpgrade(request, socket, head, (ws) => {
      asrStreamServer.emit("connection", ws, request);
    });
    return;
  }
  socket.destroy();
});

const asrStreamServer = new WebSocketServer({ noServer: true });

asrStreamServer.on("connection", (clientWs, request) => {
  const traceId = createTraceId("stream");
  const logger = (stage, details = {}) => logTranscription(traceId, stage, details);
  let clientFinished = false;
  let dashscopeStarted = false;
  let dashscopeFinished = false;
  let dashscopeWs = null;
  let dashscopeRequestId = "";
  let clientClosed = false;
  let sendQueue = Promise.resolve();
  const pendingFrames = [];
  const sentenceBuffer = createSentenceBuffer();
  const timings = {
    requestStartedAt: Date.now()
  };

  const closeClient = (code = 1000, reason = "done") => {
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      try {
        clientWs.close(code, reason);
      } catch {}
    }
  };

  const sendClient = (type, payload = {}) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    clientWs.send(createWsEventMessage(traceId, type, payload));
  };

  const finishStream = (text) => {
    if (dashscopeFinished) return;
    dashscopeFinished = true;
    timings.completedAt = Date.now();
    logger("stream_finished", {
      dashscopeRequestId,
      textLength: text.length,
      elapsedMs: timings.completedAt - timings.requestStartedAt
    });
    sendClient("final", {
      text,
      requestId: dashscopeRequestId || null,
      timings: {
        ...timings,
        elapsedMs: timings.completedAt - timings.requestStartedAt
      }
    });
    closeClient(1000, "finished");
    try {
      dashscopeWs?.close();
    } catch {}
  };

  const failStream = (message, extra = {}) => {
    if (dashscopeFinished) return;
    dashscopeFinished = true;
    logger("stream_failed", {
      message,
      ...extra
    });
    sendClient("error", {
      message,
      ...extra
    });
    closeClient(1011, "failed");
    try {
      dashscopeWs?.close();
    } catch {}
  };

  const forwardAudioFrame = (frameBuffer) => {
    if (!dashscopeWs || dashscopeWs.readyState !== WebSocket.OPEN || !dashscopeStarted) {
      pendingFrames.push(Buffer.from(frameBuffer));
      return;
    }
    sendQueue = sendQueue
      .then(() => {
        if (!dashscopeWs || dashscopeWs.readyState !== WebSocket.OPEN) {
          return;
        }
        dashscopeWs.send(frameBuffer);
      })
      .catch((error) => {
        failStream(error.message);
      });
  };

  const startDashscope = () => {
    if (dashscopeWs) return;
    logger("stream_start", {
      remoteAddress: request.socket?.remoteAddress || ""
    });

    dashscopeWs = new WebSocket(dashscopeBaseUrl, {
      headers: {
        Authorization: `bearer ${dashscopeApiKey}`
      }
    });

    dashscopeWs.on("open", () => {
      logger("upstream_open");
      dashscopeWs.send(JSON.stringify(createRunTaskMessage(traceId)));
    });

    dashscopeWs.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      const event = message?.header?.event;
      if (event === "task-started") {
        dashscopeStarted = true;
        dashscopeRequestId =
          message?.header?.request_id ||
          message?.header?.requestId ||
          message?.header?.task_id ||
          traceId;
        timings.taskStartedAt = Date.now();
        logger("upstream_task_started", {
          requestId: dashscopeRequestId
        });
        while (pendingFrames.length) {
          const frame = pendingFrames.shift();
          forwardAudioFrame(frame);
        }
        sendClient("status", {
          phase: "listening",
          requestId: dashscopeRequestId
        });
        return;
      }

      if (event === "result-generated") {
        const sentence = message?.payload?.output?.sentence;
        const text = sentenceBuffer.update(sentence);
        if (text) {
          if (!timings.firstResultAt) {
            timings.firstResultAt = Date.now();
            logger("upstream_first_result", {
              elapsedMs: timings.firstResultAt - timings.requestStartedAt
            });
          }
          sendClient("partial", {
            text,
            requestId: dashscopeRequestId || null,
            sentenceEnd: Boolean(sentence?.sentence_end)
          });
        }
        return;
      }

      if (event === "task-finished") {
        const finalText = sentenceBuffer.buildFinalText(
          message?.payload?.output?.sentence?.text || ""
        );
        finishStream(finalText);
        return;
      }

      if (event === "task-failed") {
        const errorMessage = message?.header?.error_message || "DashScope ASR failed";
        failStream(errorMessage, {
          requestId: dashscopeRequestId || null,
          retryable: isRetryableTranscriptionError(new Error(errorMessage))
        });
      }
    });

    dashscopeWs.on("error", (error) => {
      failStream(error.message, {
        requestId: dashscopeRequestId || null
      });
    });

    dashscopeWs.on("close", (code, reason) => {
      if (dashscopeFinished) return;
      if (clientClosed && !dashscopeStarted) return;
      failStream(`DashScope WebSocket closed: ${code} ${reason}`, {
        requestId: dashscopeRequestId || null
      });
    });
  };

  clientWs.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      if (Buffer.isBuffer(raw)) {
        startDashscope();
        forwardAudioFrame(Buffer.from(raw));
      }
      return;
    }

    if (message.type === "start") {
      sendClient("status", { phase: "connecting" });
      startDashscope();
      return;
    }

    if (message.type === "audio") {
      if (!message.data) return;
      startDashscope();
      forwardAudioFrame(Buffer.from(message.data, "base64"));
      return;
    }

    if (message.type === "stop") {
      clientFinished = true;
      sendQueue = sendQueue.then(() => {
        if (dashscopeWs && dashscopeWs.readyState === WebSocket.OPEN && !dashscopeFinished) {
          dashscopeWs.send(JSON.stringify(createFinishTaskMessage(traceId)));
          logger("client_stop_sent");
        }
      });
      return;
    }
  });

  clientWs.on("close", () => {
    clientClosed = true;
    if (dashscopeWs && dashscopeWs.readyState === WebSocket.OPEN && !dashscopeFinished) {
      try {
        dashscopeWs.close();
      } catch {}
    }
  });

  clientWs.on("error", (error) => {
    failStream(error.message);
  });
});

server.listen(port, () => {
  console.log(`VoiceAssistant server running at http://127.0.0.1:${port}`);
  console.log(`DashScope ASR: ${dashscopeApiKey ? "enabled" : "disabled"}`);
  console.log(`DashScope hot words: ${getActiveVocabularyId() ? getActiveVocabularyId() : "disabled"}`);
});
