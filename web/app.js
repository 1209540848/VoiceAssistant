const state = {
  isRecording: false,
  transcript: "",
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
  sessionMeta: document.querySelector("#sessionMeta"),
  liveStateBadge: document.querySelector("#liveStateBadge"),
  resultCount: document.querySelector("#resultCount"),
  traceValue: document.querySelector("#traceValue"),
  requestValue: document.querySelector("#requestValue"),
  timingValue: document.querySelector("#timingValue"),
  errorValue: document.querySelector("#errorValue"),
  copyOriginalButton: document.querySelector("#copyOriginalButton"),
  clearButton: document.querySelector("#clearButton"),
  feedback: document.querySelector("#feedback"),
  environmentNote: document.querySelector("#environmentNote"),
  controlHint: document.querySelector("#controlHint"),
  sourceBadge: document.querySelector("#sourceBadge")
};

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

function formatTimingSummary(timings) {
  if (!timings) return "-";
  const parts = [];
  if (typeof timings.elapsedMs === "number") {
    parts.push(`${timings.elapsedMs}ms`);
  }
  if (typeof timings.firstResultAt === "number") {
    parts.push("首包已到");
  }
  return parts.length ? parts.join(" | ") : "-";
}

function updateDiagnostics() {
  elements.traceValue.textContent = state.lastTraceId || "-";
  elements.requestValue.textContent = state.lastRequestId || "-";
  elements.timingValue.textContent = formatTimingSummary(state.lastTimings);
  elements.errorValue.textContent = state.streamLastError || "-";
  elements.resultCount.textContent = `${state.transcript ? state.transcript.length : 0} 字`;
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

function bytesToBase64(buffer) {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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
        elements.liveStateBadge.textContent = "识别中";
      }
      return;
    }

    if (payload.type === "partial") {
      state.streamLiveText = payload.text || "";
      state.transcript = state.streamLiveText;
      elements.transcriptText.textContent = state.streamLiveText || "正在等待识别结果...";
      elements.transcriptText.classList.toggle("empty", !state.streamLiveText);
      elements.transcriptMeta.textContent = payload.requestId ? `requestId ${payload.requestId}` : "实时转写中";
      elements.liveStateBadge.textContent = "实时更新";
      updateDiagnostics();
      return;
    }

    if (payload.type === "final") {
      state.streamFinalized = true;
      state.streamFinalText = payload.text || state.streamLiveText || "";
      state.transcript = state.streamFinalText;
      state.lastTraceId = payload.traceId || state.lastTraceId || "";
      state.lastRequestId = payload.requestId || state.lastRequestId || "";
      state.lastTimings = payload.timings || null;
      state.streamLastError = "";
      elements.transcriptText.textContent = state.transcript || "未识别到有效内容。";
      elements.transcriptText.classList.toggle("empty", !state.transcript);
      elements.transcriptMeta.textContent = state.lastRequestId
        ? `requestId ${state.lastRequestId}`
        : "转写完成";
      elements.liveStateBadge.textContent = "已完成";
      setStatus("转写完成", "done");
      setFeedback(
        [
          state.lastTraceId ? `traceId: ${state.lastTraceId}` : "",
          state.lastRequestId ? `requestId: ${state.lastRequestId}` : "",
          formatTimingSummary(state.lastTimings)
        ]
          .filter(Boolean)
          .join(" | ")
      );
      updateDiagnostics();
      return;
    }

    if (payload.type === "error") {
      state.streamFailed = true;
      state.streamLastError = payload.message || "流式转写失败";
      state.lastTraceId = payload.traceId || state.lastTraceId || "";
      state.lastRequestId = payload.requestId || state.lastRequestId || "";
      elements.liveStateBadge.textContent = "失败";
      setStatus("转写失败", "processing");
      elements.transcriptMeta.textContent = "真实转写失败";
      elements.transcriptText.textContent = "本次未生成结果。";
      elements.transcriptText.classList.remove("empty");
      setFeedback(
        [
          `转写失败：${state.streamLastError}`,
          state.lastTraceId ? `traceId: ${state.lastTraceId}` : "",
          payload.retryable === false ? "不可重试" : ""
        ]
          .filter(Boolean)
          .join(" | ")
      );
      updateDiagnostics();
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

function setIdleView() {
  state.isRecording = false;
  state.transcript = "";
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
  elements.transcriptMeta.textContent = "等待语音输入";
  elements.sessionMeta.textContent = "未开始";
  elements.liveStateBadge.textContent = "等待输入";
  elements.resultCount.textContent = "0 字";
  elements.traceValue.textContent = "-";
  elements.requestValue.textContent = "-";
  elements.timingValue.textContent = "-";
  elements.errorValue.textContent = "-";
  elements.controlHint.textContent = "开始后会持续发送音频帧。";
  setStatus("待输入");
  updateDiagnostics();
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
    const sample = Math.max(-1, Math.min(1, downsampled[i]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm16.buffer;
}

async function startRecording() {
  state.isRecording = true;
  state.transcript = "";
  state.lastTraceId = "";
  state.lastRequestId = "";
  state.lastTimings = null;
  state.streamLastError = "";
  setStatus("准备录音", "processing");
  setFeedback("");
  elements.recordButton.classList.add("is-recording");
  elements.recordButton.setAttribute("aria-pressed", "true");
  elements.recordButtonText.textContent = "结束录音";
  elements.meter.classList.add("active");
  elements.transcriptText.textContent = "";
  elements.transcriptText.classList.remove("empty");
  elements.transcriptMeta.textContent = "等待麦克风";
  elements.sessionMeta.textContent = "连接中";
  elements.liveStateBadge.textContent = "启动中";
  elements.controlHint.textContent = "浏览器会先申请麦克风权限。";
  elements.sourceBadge.textContent = "麦克风";
  startTimer();

  if (window.location.protocol === "file:") {
    setFeedback("请用 http://127.0.0.1:4173/web/index.html 打开页面，file:// 下无法正常录音。");
    setStatus("录音中", "recording");
    state.isRecording = false;
    stopTimer();
    elements.recordButton.classList.remove("is-recording");
    elements.recordButton.setAttribute("aria-pressed", "false");
    elements.recordButtonText.textContent = "开始说话";
    elements.meter.classList.remove("active");
    elements.sessionMeta.textContent = "未开始";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    setFeedback("当前浏览器不支持麦克风录音。");
    setStatus("录音中", "recording");
    state.isRecording = false;
    stopTimer();
    elements.recordButton.classList.remove("is-recording");
    elements.recordButton.setAttribute("aria-pressed", "false");
    elements.recordButtonText.textContent = "开始说话";
    elements.meter.classList.remove("active");
    elements.sessionMeta.textContent = "未开始";
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
    elements.sessionMeta.textContent = "已连接";
    elements.liveStateBadge.textContent = "收音中";
    elements.transcriptMeta.textContent = "正在收音";
  } catch (error) {
    setFeedback(`麦克风不可用：${error.message}`);
    setStatus("录音中", "recording");
    state.isRecording = false;
    stopTimer();
    elements.recordButton.classList.remove("is-recording");
    elements.recordButton.setAttribute("aria-pressed", "false");
    elements.recordButtonText.textContent = "开始说话";
    elements.meter.classList.remove("active");
    elements.sessionMeta.textContent = "失败";
    elements.liveStateBadge.textContent = "失败";
  }
}

function stopRecording() {
  state.isRecording = false;
  stopTimer();
  elements.recordButton.classList.remove("is-recording");
  elements.recordButton.setAttribute("aria-pressed", "false");
  elements.recordButtonText.textContent = "重新说话";
  elements.meter.classList.remove("active");
  elements.controlHint.textContent = "停止后等待最终结果。";
  elements.sessionMeta.textContent = "收尾中";

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

  elements.copyOriginalButton.addEventListener("click", () => {
    copyText(state.transcript, "转写");
  });

  elements.clearButton.addEventListener("click", clearAll);
}

function initEnvironmentNote() {
  if (window.location.protocol === "file:") {
    elements.environmentNote.textContent = "file:// 下无法录音，请用本地服务地址打开。";
    elements.environmentNote.classList.add("warning-note");
    elements.recordButton.disabled = true;
    elements.recordButton.setAttribute("aria-disabled", "true");
  } else {
    elements.environmentNote.textContent = "支持真实麦克风；失败会直接提示。";
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
