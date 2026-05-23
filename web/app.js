const sampleTranscript =
  "明天下午三点我们开个会讨论一下这个方案，然后把重点整理成三条，发给产品和技术同学看一下。";

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
  useMockFlow: true
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
    throw new Error(`转写接口返回 ${response.status}`);
  }

  const payload = await response.json();
  return decodeTextFromResponse(payload);
}

function renderTranscribedText(text) {
  state.transcript = text || "";
  elements.transcriptText.textContent = state.transcript || "未识别到有效内容。";
  elements.transcriptText.classList.toggle("empty", !state.transcript);
  elements.transcriptMeta.textContent = state.transcript ? "转写完成" : "未识别到内容";
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

async function finishRecordingWithBlob(blob) {
  setStatus("正在转写", "processing");
  elements.transcriptMeta.textContent = "上传音频中";
  elements.polishedText.textContent = "正在等待转写结果...";
  elements.polishedText.classList.add("empty");
  try {
    const transcribedText = await transcribeAudio(blob);
    renderTranscribedText(transcribedText || sampleTranscript);
    setStatus("正在优化", "processing");
    elements.polishedText.textContent = "正在根据风格优化文本...";
    elements.polishedText.classList.add("empty");
    window.setTimeout(() => {
      generatePolishedText();
      setStatus("已生成", "done");
    }, 520);
  } catch (error) {
    renderTranscribedText(sampleTranscript);
    setStatus("已降级", "done");
    elements.transcriptMeta.textContent = "已使用本地降级结果";
    setFeedback(`转写接口不可用，已回退到本地模拟结果。${error.message}`);
    generatePolishedText();
  }
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
    state.useMockFlow = true;
    setFeedback("当前是 file:// 打开，已切换为模拟录音流程。");
    setStatus("录音中", "recording");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    state.useMockFlow = true;
    setFeedback("当前浏览器不支持录音，已切换为模拟流程。");
    setStatus("录音中", "recording");
    return;
  }

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.useMockFlow = false;
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
    };

    state.sourceNode.connect(state.processorNode);
    state.processorNode.connect(state.muteNode);
    state.muteNode.connect(state.audioContext.destination);

    setStatus("录音中", "recording");
    elements.transcriptMeta.textContent = "正在收音";
  } catch (error) {
    state.useMockFlow = true;
    setFeedback(`麦克风不可用，已切换为模拟流程。${error.message}`);
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

  if (state.useMockFlow || window.location.protocol === "file:") {
    state.transcript = sampleTranscript;
    elements.transcriptText.textContent = sampleTranscript;
    elements.transcriptText.classList.remove("empty");
    elements.transcriptMeta.textContent = "模拟识别完成";
    setStatus("正在优化", "processing");
    elements.polishedText.textContent = "正在根据风格优化文本...";
    elements.polishedText.classList.add("empty");
    window.setTimeout(() => {
      generatePolishedText();
      setStatus("已生成", "done");
    }, 620);
    cleanupStream();
    return;
  }

  const blob = new Blob(state.audioChunks, { type: "application/octet-stream" });
  state.audioChunks = [];
  cleanupStream();
  finishRecordingWithBlob(blob);
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
      "当前页面支持真实麦克风录音；若转写接口不可用，会自动回退到模拟流程。";
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
