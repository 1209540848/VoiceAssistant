const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const rootDir = __dirname;
const webDir = path.join(rootDir, "web");

loadLocalEnv(path.join(rootDir, ".env.local"));

const port = Number(process.env.PORT || 4173);
const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || "";
const dashscopeBaseUrl =
  process.env.DASHSCOPE_BASE_URL ||
  "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const dashscopeModel = process.env.DASHSCOPE_MODEL || "fun-asr-realtime";
const dashscopeLanguage = process.env.DASHSCOPE_LANGUAGE || "zh";
const dashscopeSampleRate = Number(process.env.DASHSCOPE_SAMPLE_RATE || 16000);

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
      parameters: {
        format: "pcm",
        sample_rate: dashscopeSampleRate,
        language: dashscopeLanguage
      },
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

async function transcribeWithDashScope(audioBuffer, options = {}) {
  const traceId = options.traceId || createTraceId();
  const logger = typeof options.logger === "function" ? options.logger : () => {};

  return new Promise((resolve, reject) => {
    let ws;
    const taskId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 32);
    const chunks = [];
    let settled = false;
    let started = false;
    let finishSent = false;
    let requestId = "";
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
        const text = sentence?.text || "";
        if (text) {
          chunks.push(text);
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
        const finalText =
          chunks.join("") || message?.payload?.output?.sentence?.text || "";
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

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      dashscopeConfigured: Boolean(dashscopeApiKey),
      model: dashscopeModel,
      baseUrl: dashscopeBaseUrl
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
  const chunks = [];
  let clientFinished = false;
  let dashscopeStarted = false;
  let dashscopeFinished = false;
  let dashscopeWs = null;
  let dashscopeRequestId = "";
  let clientClosed = false;
  let sendQueue = Promise.resolve();
  const pendingFrames = [];
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
        const text = sentence?.text || "";
        if (text) {
          chunks.push(text);
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
        const finalText = chunks.join("") || message?.payload?.output?.sentence?.text || "";
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
});
