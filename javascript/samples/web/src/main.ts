// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Player } from "./player.ts";
import { Recorder } from "./recorder.ts";
import "./style.css";
import { LowLevelRTClient, SessionUpdateMessage, Voice } from "rt-client";

let realtimeStreaming: LowLevelRTClient;
let audioRecorder: Recorder;
let audioPlayer: Player;

// New global conversation log (each elements is one dialogue line)
let conversationLog: string[] = [];
let currentCustomerDelta: string = "";

// Helper function to update conversation and the UI
function updateConversation(message: string) {
  // If the message starts with a sender label, add a new dialogue line
  if (message.startsWith("User:") || message.startsWith("Assistant:")) {
    conversationLog.push(message);
  } else if (conversationLog.length > 0) {
    // If the message doesn't start with a sender label, append it to the last dialogue line
    conversationLog[conversationLog.length - 1] += message;
  } else {
    // If there are no dialogue lines, create a new one
    conversationLog.push(message);
  }
}

async function start_realtime(endpoint: string, apiKey: string, deploymentOrModel: string) {
  if (isAzureOpenAI()) {
    realtimeStreaming = new LowLevelRTClient(new URL(endpoint), { key: apiKey }, { deployment: deploymentOrModel });
  } else {
    realtimeStreaming = new LowLevelRTClient({ key: apiKey }, { model: deploymentOrModel });
  }

  try {
    console.log("sending session config");
    await realtimeStreaming.send(createConfigMessage());
  } catch (error) {
    console.log(error);
    makeNewTextBlock("[Connection error]: Unable to send initial config message. Please check your endpoint and authentication details.");
    setFormInputState(InputState.ReadyToStart);
    return;
  }
  console.log("sent");
  await Promise.all([resetAudio(true), handleRealtimeMessages()]);
}

function createConfigMessage() : SessionUpdateMessage {

  // Read UI fielods for VAD configuration:
  const vadThreshold = parseFloat(formVadThresholdField.value);
  const prefixPadding = parseInt(formPrefixPaddingField.value);
  const silenceDuration = parseInt(formSilenceDurationField.value);


  let configMessage : SessionUpdateMessage = {
    type: "session.update",
    session: {
      turn_detection: {
        type: "server_vad",
        threshold: !isNaN(vadThreshold) ? vadThreshold : undefined,
        prefix_padding_ms: !isNaN(prefixPadding) ? prefixPadding : undefined,
        silence_duration_ms: !isNaN(silenceDuration) ? silenceDuration : undefined,
      },
      input_audio_transcription: {
        model: "whisper-1"
      }
    }
  };

  const systemMessage = getSystemMessage();
  const temperature = getTemperature();
  const voice = getVoice();

  // if (systemMessage) {
  //   configMessage.session.instructions = systemMessage;
  // }
  const conversationHistory = conversationLog.join("\n");
  // Append conversation log to the system promopt if available
  const fullSystemMessage = systemMessage ? `${systemMessage}\n\n${conversationHistory}` : conversationHistory;
  if (fullSystemMessage) {
    configMessage.session.instructions = fullSystemMessage;
  }

  if (!isNaN(temperature)) {
    configMessage.session.temperature = temperature;
  }
  if (voice) {
    configMessage.session.voice = voice;
  }

  return configMessage;
}

function appendToAITextBlock(aiText: string) {
  let aiTextElements = formReceivedTextContainer.children;
  if (!aiTextElements[aiTextElements.length -1].textContent) {
    aiTextElements[aiTextElements.length -1].textContent += "Assistant: " + aiText;
  } else {
    aiTextElements[aiTextElements.length -1].textContent += aiText;
  }
}

async function handleRealtimeMessages() {
  for await (const message of realtimeStreaming.messages()) {
    let consoleLog = "" + message.type;

    switch (message.type) {
      case "session.created":
        setFormInputState(InputState.ReadyToStop);
        makeNewTextBlock("<< Session Started >>");
        makeNewTextBlock();
        break;
      case "input_audio_buffer.speech_started":
        makeNewTextBlock();
        let textElements = formReceivedTextContainer.children;
        latestInputSpeechBlock = textElements[textElements.length - 1];
        makeNewTextBlock();
        audioPlayer.clear();
        break;
      case "conversation.item.input_audio_transcription.completed":
        latestInputSpeechBlock.textContent += " User: " + message.transcript;
        updateConversation("User: " + message.transcript);
        break;
      case "response.audio_transcript.delta":
        appendToAITextBlock(message.delta);
        currentCustomerDelta += message.delta;
        break;
      case "response.audio.delta":
        const binary = atob(message.delta);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const pcmData = new Int16Array(bytes.buffer);
        audioPlayer.play(pcmData);
        break;
      case "response.done":
        if (currentCustomerDelta) {
          updateConversation("Assistant: " + currentCustomerDelta);
          currentCustomerDelta = "";
        }
        formReceivedTextContainer.appendChild(document.createElement("hr"));
        break;
      default:
        consoleLog = JSON.stringify(message, null, 2);
        break
    }
    if (consoleLog) {
      console.log(consoleLog);
    }
  }
  resetAudio(false);
}

/**
 * Basic audio handling
 */

let recordingActive: boolean = false;
let buffer: Uint8Array = new Uint8Array();

function combineArray(newData: Uint8Array) {
  const newBuffer = new Uint8Array(buffer.length + newData.length);
  newBuffer.set(buffer);
  newBuffer.set(newData, buffer.length);
  buffer = newBuffer;
}

function processAudioRecordingBuffer(data: Buffer) {
  const uint8Array = new Uint8Array(data);
  combineArray(uint8Array);
  if (buffer.length >= 4800) {
    const toSend = new Uint8Array(buffer.slice(0, 4800));
    buffer = new Uint8Array(buffer.slice(4800));
    const regularArray = String.fromCharCode(...toSend);
    const base64 = btoa(regularArray);
    if (recordingActive) {
      realtimeStreaming.send({
        type: "input_audio_buffer.append",
        audio: base64,
      });
    }
  }

}

async function resetAudio(startRecording: boolean) {
  recordingActive = false;
  if (audioRecorder) {
    audioRecorder.stop();
  }
  if (audioPlayer) {
    audioPlayer.clear();
  }
  audioRecorder = new Recorder(processAudioRecordingBuffer);
  audioPlayer = new Player();
  audioPlayer.init(24000);
  if (startRecording) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioRecorder.start(stream);
    recordingActive = true;
  }
}

/**
 * UI and controls
 */

const formReceivedTextContainer = document.querySelector<HTMLDivElement>(
  "#received-text-container",
)!;
const formStartButton =
  document.querySelector<HTMLButtonElement>("#start-recording")!;
const formStopButton =
  document.querySelector<HTMLButtonElement>("#stop-recording")!;
const formClearAllButton =
  document.querySelector<HTMLButtonElement>("#clear-all")!;
const formEndpointField =
  document.querySelector<HTMLInputElement>("#endpoint")!;
const formAzureToggle =
  document.querySelector<HTMLInputElement>("#azure-toggle")!;
const formApiKeyField = document.querySelector<HTMLInputElement>("#api-key")!;
const formDeploymentOrModelField = document.querySelector<HTMLInputElement>("#deployment-or-model")!;
const formSessionInstructionsField =
  document.querySelector<HTMLTextAreaElement>("#session-instructions")!;
const formTemperatureField = document.querySelector<HTMLInputElement>("#temperature")!;
const formVoiceSelection = document.querySelector<HTMLInputElement>("#voice")!;
const formVadThresholdField = document.querySelector<HTMLInputElement>("#vad-threshold")!;
const formPrefixPaddingField = document.querySelector<HTMLInputElement>("#prefix-padding-ms")!;
const formSilenceDurationField = document.querySelector<HTMLInputElement>("#silence-duration-ms")!;

let latestInputSpeechBlock: Element;

enum InputState {
  Working,
  ReadyToStart,
  ReadyToStop,
}

function isAzureOpenAI(): boolean {
  return formAzureToggle.checked;
}

function guessIfIsAzureOpenAI() {
  const endpoint = (formEndpointField.value || "").trim();
  formAzureToggle.checked = endpoint.indexOf('azure') > -1;
}

function setFormInputState(state: InputState) {
  formEndpointField.disabled = state != InputState.ReadyToStart;
  formApiKeyField.disabled = state != InputState.ReadyToStart;
  formDeploymentOrModelField.disabled = state != InputState.ReadyToStart;
  formStartButton.disabled = state != InputState.ReadyToStart;
  formStopButton.disabled = state != InputState.ReadyToStop;
  formSessionInstructionsField.disabled = state != InputState.ReadyToStart;
  formAzureToggle.disabled = state != InputState.ReadyToStart;
}

function getSystemMessage(): string {
  return formSessionInstructionsField.value || "";
}

function getTemperature(): number {
  return parseFloat(formTemperatureField.value);
}

function getVoice(): Voice {
  return formVoiceSelection.value as Voice;
}

function makeNewTextBlock(text: string = "") {
  let newElement = document.createElement("p");
  newElement.textContent = text;
  formReceivedTextContainer.appendChild(newElement);
}

// function appendToTextBlock(text: string) {
//   let textElements = formReceivedTextContainer.children;
//   if (textElements.length == 0) {
//     makeNewTextBlock();
//   }
//   textElements[textElements.length - 1].textContent += text;
// }

formStartButton.addEventListener("click", async () => {
  setFormInputState(InputState.Working);

  const endpoint = formEndpointField.value.trim();
  const key = formApiKeyField.value.trim();
  const deploymentOrModel = formDeploymentOrModelField.value.trim();

  if (isAzureOpenAI() && !endpoint && !deploymentOrModel) {
    alert("Endpoint and Deployment are required for Azure OpenAI");
    return;
  }

  if (!isAzureOpenAI() && !deploymentOrModel) {
    alert("Model is required for OpenAI");
    return;
  }

  if (!key) {
    alert("API Key is required");
    return;
  }

  try {
    start_realtime(endpoint, key, deploymentOrModel);
  } catch (error) {
    console.log(error);
    setFormInputState(InputState.ReadyToStart);
  }
});

formStopButton.addEventListener("click", async () => {
  setFormInputState(InputState.Working);
  resetAudio(false);
  realtimeStreaming.close();
  setFormInputState(InputState.ReadyToStart);
  // After stopping, update the UI with the full conversation log, as a debugging aid:
  //formReceivedTextContainer.textContent = conversationLog.join("\n");
});

formClearAllButton.addEventListener("click", async () => {
  formReceivedTextContainer.innerHTML = "";
  conversationLog = [];
});

formEndpointField.addEventListener('change', async () => {
  guessIfIsAzureOpenAI();
});
guessIfIsAzureOpenAI();

document.addEventListener("DOMContentLoaded", () => {
  formApiKeyField.value = import.meta.env.VITE_AZURE_OPENAI_API_KEY || "";
});