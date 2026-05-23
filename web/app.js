const styleOutputs = {
  original:
    "明天下午三点我们开个会，讨论一下这个方案，然后把重点整理成三条，发给产品和技术同学看一下。",
  formal:
    "我们将于明天下午三点召开会议，讨论该方案，并将重点整理为三项内容，发送给产品和技术同学确认。",
  concise: "明天下午三点开会讨论方案，并整理三条重点发给产品和技术同学。",
  polite:
    "方便的话，我们明天下午三点开会讨论一下这个方案。会后我会把重点整理成三条，再发给产品和技术同学确认。",
  summary: "会议时间：明天下午三点。主题：讨论方案。后续动作：整理三条重点并发给产品和技术同学。"
};

const styleLabels = {
  original: "原文",
  formal: "正式",
  concise: "简洁",
  polite: "礼貌",
  summary: "总结"
};

const state = {
  isRecording: false,
  activeStyle: "original",
  transcript: "",
  polished: "",
  elapsedSeconds: 0,
  timerId: null,
  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  muteNode: null,
  audioChunks: [],
  lastTraceId: "",
  lastRequestId: "",
  lastTimings: null,
  streamSocket: null,
  streamPendingMessages: [],
  streamOpen: false,
  streamFailed: false,
  streamFinalized: false,
  streamLiveText: "",
  streamFinalText: "",
  streamLastError: ""
};

const elements = {
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  recordButton: document.querySelector("#recordButton"),
  recordButtonText: document.querySelector("#recordButtonText"),
  meter: document.querySelector("#meter"),
  timer: document.querySelector("#timer"),
  transcriptText: document.querySelector("#transcriptText"),
  transcriptMeta: document.querySelector("#transcriptMeta"),
  polishedText: document.querySelector("#polishedText"),
  polishMeta: document.querySelector("#polishMeta"),
  styleTabs: document.querySelectorAll(".style-tab"),
  copyOriginalButton: document.querySelector("#copyOriginalButton"),
  copyPolishedButton: document.querySelector("#copyPolishedButton"),
  regenerateButton: document.querySelector("#regenerateButton"),
  clearButton: document.querySelector("#clearButton"),
  feedback: document.querySelector("#feedback"),
  environmentNote: document.querySelector("#environmentNote")
};

const TRANSCRIBE_ENDPOINT = "/api/transcribe";
const ASR_STREAM_ENDPOINT = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/asr-stream`;

function setStatus(label, mode = "") {
  elements.statusText.textContent = label;
  elements.statusPill.className = `status-pill ${mode}`.trim();
}

function setFeedback(message) {
  elements.feedback.textContent = message;
  if (!message) return;
  window.clearTimeout(elements.feedback.timeoutId);
  elements.feedback.timeoutId = window.setTimeout(() => {
    elements.feedback.textContent = "";
  }, 2600);
}

function formatTime(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function startTimer() {
  state.elapsedSeconds = 0;
  elements.timer.textContent = "00:00";
  state.timerId = window.setInterval(() => {
    state.elapsedSeconds += 1;
    elements.timer.textContent = formatTime(state.elapsedSeconds);
  }, 1000);
}

function stopTimer() {
  window.clearInterval(state.timerId);
  state.timerId = null;
}

function cleanupStream() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
  if (state.sourceNode) {
    try {
      state.sourceNode.disconnect();
    } catch {}
    state.sourceNode = null;
  }
  if (state.processorNode) {
    try {
      state.processorNode.disconnect();
    } catch {}
    state.processorNode = null;
  }
  if (state.muteNode) {
    try {
      state.muteNode.disconnect();
    } catch {}
    state.muteNode = null;
  }
  if (state.audioContext) {
    try {
      state.audioContext.close();
    } catch {}
    state.audioContext = null;
  }
  state.audioChunks = [];
}

function decodeTextFromResponse(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  return (
    payload.text ||
    payload.transcript ||
    payload.result?.text ||
    payload.data?.text ||
    payload.result ||
    ""
  );
}

function formatTimingSummary(timings) {
  if (!timings) return "";
  const parts = [];
  if (typeof timings.elapsedMs === "number") {
    parts.push(`总耗时 ${timings.elapsedMs}ms`);
  }
  if (typeof timings.firstResultAt === "number") {
    parts.push("已收到首包");
  }
  return parts.join("，");
}

function bytesToBase64(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return window.btoa(binary);
}

function createStreamSocket() {
  if (state.streamSocket && state.streamSocket.readyState === WebSocket.OPEN) {
    return state.streamSocket;
  }

  const socket = new WebSocket(ASR_STREAM_ENDPOINT);
  state.streamSocket = socket;
  state.streamPendingMessages = [];
  state.streamOpen = false;
  state.streamFailed = false;
  state.streamFinalized = false;

  socket.addEventListener("open", () => {
    state.streamOpen = true;
    socket.send(JSON.stringify({ type: "start" }));
    while (state.streamPendingMessages.length) {
      socket.send(state.streamPendingMessages.shift());
    }
  });

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "status") {
      if (payload.phase === "listening") {
        setStatus("实时识别中", "processing");
      }
      return;
    }

    if (payload.type === "partial") {
      state.streamLiveText = payload.text || "";
      state.transcript = state.streamLiveText;
      elements.transcriptText.textContent = state.streamLiveText || "正在等待识别结果...";
      elements.transcriptText.classList.toggle("empty", !state.streamLiveText);
      const metaParts = ["实时转写中"];
      if (payload.requestId) metaParts.push(`requestId ${payload.requestId}`);
      elements.transcriptMeta.textContent = metaParts.join(" | ");
      return;
    }

    if (payload.type === "final") {
      state.streamFinalized = true;
      state.streamFinalText = payload.text || state.streamLiveText || "";
      state.lastTraceId = payload.traceId || state.lastTraceId || "";
      state.lastRequestId = payload.requestId || state.lastRequestId || "";
      state.lastTimings = payload.timings || null;
      renderTranscribedText(state.streamFinalText);
      setStatus("正在优化", "processing");
      elements.polishedText.textContent = "正在根据风格优化文本...";
      elements.polishedText.classList.add("empty");
      setFeedback(
        [
          payload.traceId ? `traceId: ${payload.traceId}` : "",
          payload.requestId ? `requestId: ${payload.requestId}` : "",
          formatTimingSummary(payload.timings)
        ]
          .filter(Boolean)
          .join(" | ")
      );
      window.setTimeout(() => {
        generatePolishedText();
        setStatus("已生成", "done");
      }, 520);
      return;
    }

    if (payload.type === "error") {
      state.streamFailed = true;
      state.streamLastError = payload.message || "流式转写失败";
      state.lastTraceId = payload.traceId || state.lastTraceId || "";
      setStatus("转写失败", "processing");
      elements.transcriptMeta.textContent = "真实转写失败";
      elements.polishedText.textContent = "本次没有生成优化结果，因为真实转写失败了。";
      elements.polishedText.classList.remove("empty");
      setFeedback(
        [
          `转写失败：${payload.message || "流式转写失败"}`,
          payload.traceId ? `traceId: ${payload.traceId}` : "",
          payload.retryable === false ? "不可重试" : ""
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }
  });

  socket.addEventListener("close", () => {
    state.streamOpen = false;
    state.streamSocket = null;
  });

  socket.addEventListener("error", () => {
    state.streamFailed = true;
  });

  return socket;
}

function sendStreamAudio(chunk) {
  const socket = createStreamSocket();
  const message = JSON.stringify({
    type: "audio",
    data: bytesToBase64(chunk)
  });

  if (socket.readyState === WebSocket.OPEN && state.streamOpen) {
    socket.send(message);
    return;
  }

  state.streamPendingMessages.push(message);
}

function stopStreamSocket() {
  if (!state.streamSocket) return;
  try {
    if (state.streamSocket.readyState === WebSocket.OPEN) {
      state.streamSocket.send(JSON.stringify({ type: "stop" }));
    }
  } catch {}
}

async function transcribeAudio(blob) {
  const response = await fetch(
    `${TRANSCRIBE_ENDPOINT}?scene=chat&language=zh&format=pcm&sample_rate=16000&model=fun-asr-realtime`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream"
      },
      body: blob
    }
  );

  if (!response.ok) {
    let errorMessage = `转写接口返回 ${response.status}`;
    let errorPayload = null;
    try {
      errorPayload = await response.json();
      errorMessage = errorPayload.message || errorMessage;
    } catch {}
    const error = new Error(errorMessage);
    error.status = response.status;
    error.payload = errorPayload;
    throw error;
  }

  const payload = await response.json();
  return {
    text: decodeTextFromResponse(payload),
    traceId: payload.traceId || "",
    requestId: payload.requestId || "",
    mode: payload.mode || "realtime",
    timings: payload.timings || null
  };
}

function renderTranscribedText(text) {
  state.transcript = text || "";
  elements.transcriptText.textContent = state.transcript || "未识别到有效内容。";
  elements.transcriptText.classList.toggle("empty", !state.transcript);
  if (state.lastTraceId || state.lastRequestId) {
    const metaParts = [];
    if (state.lastTraceId) metaParts.push(`traceId ${state.lastTraceId}`);
    if (state.lastRequestId) metaParts.push(`requestId ${state.lastRequestId}`);
    if (state.lastTimings?.elapsedMs) metaParts.push(`${state.lastTimings.elapsedMs}ms`);
    elements.transcriptMeta.textContent = metaParts.join(" | ");
  } else {
    elements.transcriptMeta.textContent = state.transcript ? "转写完成" : "未识别到内容";
  }
}

function generatePolishedText() {
  if (!state.transcript) {
    setFeedback("还没有可优化的原文。");
    return;
  }
  state.polished = styleOutputs[state.activeStyle];
  elements.polishedText.textContent = state.polished;
  elements.polishedText.classList.remove("empty");
  elements.polishMeta.textContent = `${styleLabels[state.activeStyle]}风格`;
}

function setIdleView() {
  state.isRecording = false;
  state.transcript = "";
  state.polished = "";
  state.lastTraceId = "";
  state.lastRequestId = "";
  state.lastTimings = null;
  state.streamSocket = null;
  state.streamPendingMessages = [];
  state.streamOpen = false;
  state.streamFailed = false;
  state.streamFinalized = false;
  state.streamLiveText = "";
  state.streamFinalText = "";
  state.streamLastError = "";
  stopTimer();
  cleanupStream();
  elements.timer.textContent = "00:00";
  elements.recordButton.classList.remove("is-recording");
  elements.recordButton.setAttribute("aria-pressed", "false");
  elements.recordButtonText.textContent = "开始说话";
  elements.meter.classList.remove("active");
  elements.transcriptText.textContent = "点击“开始说话”后，这里会显示识别结果。";
  elements.transcriptText.classList.add("empty");
  elements.polishedText.textContent = "停止录音后，AI 会根据所选风格生成优化结果。";
  elements.polishedText.classList.add("empty");
  elements.transcriptMeta.textContent = "等待语音输入";
  elements.polishMeta.textContent = "未生成";
  setStatus("待输入");
}

function convertToPcm16Chunk(input, sourceSampleRate) {
  const targetSampleRate = 16000;
  const ratio = sourceSampleRate / targetSampleRate;
  const newLength = Math.round(input.length / ratio);
  const downsampled = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
      accum += input[i];
      count += 1;
    }
    downsampled[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  const pcm16 = new Int16Array(downsampled.length);
  for (let i = 0; i < downsampled.length; i += 1) {
    const s = Math.max(-1, Math.min(1, downsampled[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16.buffer;
}

async function startRecording() {
  state.isRecording = true;
  state.transcript = "";
  state.polished = "";
  setStatus("准备录音", "processing");
  setFeedback("");
  elements.recordButton.classList.add("is-recording");
  elements.recordButton.setAttribute("aria-pressed", "true");
  elements.recordButtonText.textContent = "结束录音";
  elements.meter.classList.add("active");
  elements.transcriptText.textContent = "";
  elements.transcriptText.classList.remove("empty");
  elements.polishedText.textContent = "录音结束后将生成优化结果。";
  elements.polishedText.classList.add("empty");
  elements.transcriptMeta.textContent = "等待麦克风";
  elements.polishMeta.textContent = "等待原文";
  startTimer();

  if (window.location.protocol === "file:") {
    setFeedback("请用 http://127.0.0.1:4173/web/index.html 打开页面，file:// 下无法正常录音。");
    setStatus("录音中", "recording");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    setFeedback("当前浏览器不支持麦克风录音。");
    setStatus("录音中", "recording");
    return;
  }

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }
    state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.processorNode = state.audioContext.createScriptProcessor(4096, 1, 1);
    state.muteNode = state.audioContext.createGain();
    state.muteNode.gain.value = 0;

    state.processorNode.onaudioprocess = (event) => {
      if (!state.isRecording) return;
      const input = event.inputBuffer.getChannelData(0);
      const chunk = convertToPcm16Chunk(input, state.audioContext.sampleRate);
      state.audioChunks.push(chunk);
      sendStreamAudio(chunk);
    };

    state.sourceNode.connect(state.processorNode);
    state.processorNode.connect(state.muteNode);
    state.muteNode.connect(state.audioContext.destination);
    createStreamSocket();

    setStatus("录音中", "recording");
    elements.transcriptMeta.textContent = "正在收音";
  } catch (error) {
    setFeedback(`麦克风不可用：${error.message}`);
    setStatus("录音中", "recording");
  }
}

function stopRecording() {
  state.isRecording = false;
  stopTimer();
  elements.recordButton.classList.remove("is-recording");
  elements.recordButton.setAttribute("aria-pressed", "false");
  elements.recordButtonText.textContent = "重新说话";
  elements.meter.classList.remove("active");

  stopStreamSocket();
  state.audioChunks = [];
  cleanupStream();
}

async function copyText(text, label) {
  if (!text) {
    setFeedback(`没有可复制的${label}。`);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setFeedback(`${label}已复制。`);
  } catch {
    setFeedback("复制失败，请手动选择文本。");
  }
}

function clearAll() {
  cleanupStream();
  setIdleView();
  setFeedback("已清空。");
}

function bindEvents() {
  elements.recordButton.addEventListener("click", () => {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  elements.styleTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeStyle = tab.dataset.style;
      elements.styleTabs.forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      if (state.transcript) {
        generatePolishedText();
        setFeedback(`已切换为${styleLabels[state.activeStyle]}风格。`);
      }
    });
  });

  elements.copyOriginalButton.addEventListener("click", () => {
    copyText(state.transcript, "原文");
  });

  elements.copyPolishedButton.addEventListener("click", () => {
    copyText(state.polished, "优化结果");
  });

  elements.regenerateButton.addEventListener("click", () => {
    if (!state.transcript) {
      setFeedback("还没有可重新生成的内容。");
      return;
    }
    setStatus("正在优化", "processing");
    elements.polishedText.textContent = "正在重新生成...";
    window.setTimeout(() => {
      generatePolishedText();
      setStatus("已生成", "done");
      setFeedback("已重新生成。");
    }, 480);
  });

  elements.clearButton.addEventListener("click", clearAll);
}

function initEnvironmentNote() {
  if (window.location.protocol === "file:") {
    elements.environmentNote.textContent =
      "当前通过 file:// 打开，录音不会真正工作。请改用 http://127.0.0.1:4173/web/index.html。";
    elements.environmentNote.classList.add("warning-note");
    elements.recordButton.disabled = true;
    elements.recordButton.setAttribute("aria-disabled", "true");
  } else {
    elements.environmentNote.textContent =
      "当前页面支持真实麦克风录音；如果转写失败，会直接显示错误。";
    elements.environmentNote.classList.add("success-note");
    elements.recordButton.disabled = false;
    elements.recordButton.removeAttribute("aria-disabled");
  }
}

bindEvents();
initEnvironmentNote();
setIdleView();

if (window.lucide) {
  window.lucide.createIcons();
}
