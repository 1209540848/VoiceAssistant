const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const WebSocket = require("ws");

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
        sample_rate: dashscopeSampleRate
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

async function transcribeWithDashScope(audioBuffer) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(dashscopeBaseUrl, {
      headers: {
        Authorization: `Bearer ${dashscopeApiKey}`
      }
    });

    const taskId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 32);
    const chunks = [];
    let settled = false;
    let started = false;
    const timeout = setTimeout(() => {
      fail(new Error("DashScope ASR timeout"));
    }, 45000);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
      reject(error);
    };

    const succeed = (text, raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
      resolve({
        text,
        raw
      });
    };

    ws.on("open", () => {
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
        const frameSize = 3200;
        for (let offset = 0; offset < audioBuffer.length; offset += frameSize) {
          const frame = audioBuffer.subarray(offset, offset + frameSize);
          ws.send(frame);
        }
        ws.send(JSON.stringify(createFinishTaskMessage(taskId)));
        return;
      }

      if (event === "result-generated") {
        const sentence = message?.payload?.output?.sentence;
        const text = sentence?.text || "";
        if (text) {
          chunks.push(text);
        }
        return;
      }

      if (event === "task-finished") {
        const finalText = chunks.join("") || message?.payload?.output?.sentence?.text || "";
        succeed(finalText, message);
        return;
      }

      if (event === "task-failed") {
        const errorMessage = message?.header?.error_message || "DashScope ASR failed";
        console.error("DashScope task failed:", message);
        fail(new Error(errorMessage));
      }
    });

    ws.on("error", (error) => {
      console.error("DashScope WebSocket error:", error.message);
      fail(error);
    });

    ws.on("close", (code, reason) => {
      if (!settled && !started) {
        fail(new Error(`DashScope WebSocket closed before task start: ${code} ${reason}`));
      }
    });
  });
}

async function handleTranscribe(req, res) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const audioBuffer = Buffer.concat(chunks);

  if (!audioBuffer.length) {
    sendJson(res, 400, { error: "empty_audio" });
    return;
  }

  if (!dashscopeApiKey) {
    sendJson(res, 200, {
      text: "明天下午三点我们开个会讨论一下这个方案，然后把重点整理成三条，发给产品和技术同学看一下。",
      mode: "mock"
    });
    return;
  }

  try {
    const result = await transcribeWithDashScope(audioBuffer);
    sendJson(res, 200, {
      text: result.text || "",
      raw: result.raw
    });
  } catch (error) {
    console.error("Transcription failed:", error.message);
    sendJson(res, 502, {
      error: "dashscope_transcription_failed",
      message: error.message
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

server.listen(port, () => {
  console.log(`VoiceAssistant server running at http://127.0.0.1:${port}`);
  console.log(`DashScope ASR: ${dashscopeApiKey ? "enabled" : "mock fallback"}`);
});
