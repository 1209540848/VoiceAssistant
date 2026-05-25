# Input Settings And Post Process

## Scope

This iteration adds three product capabilities without redesigning the main UI:

- Configurable global shortcut.
- Desktop microphone device selection.
- Optional AI post processing with lightweight scenarios.

## Shortcut

The shortcut is stored in `data/user-settings.json` and ignored by Git.

The renderer saves the shortcut through Electron first. If Electron cannot register it, the setting is rejected and the old shortcut is kept. This avoids showing a shortcut that does not actually work.

The UI also shows the active shortcut because some combinations, such as `CommandOrControl+Space`, can be occupied by the system or another app.

## Microphone

The Windows capture script can list `waveIn` input devices and can start capture from a selected device id.

The app still defaults to the system microphone. Users only need to select a device when the default input is wrong.

## AI Post Process

AI post processing is optional and off by default.

When enabled, the flow is:

1. ASR returns the final transcript.
2. Local cleanup removes obvious repeated punctuation, simple repeated phrases, and common filler words.
3. DashScope text model performs conservative cleanup.
4. If the model fails or returns an invalid assistant-style message, the app falls back to the local cleanup result.

The prompt is intentionally conservative:

- Do not add facts.
- Do not change the user's stance.
- Do not expand content that was not spoken.
- Preserve product names, technical terms, English abbreviations, commands, numbers, and code-like text.

## Scenarios

Current scenarios:

- General: light cleanup for everyday input.
- Office: concise and clear work communication.
- Tech: preserve technical terms and mixed Chinese/English expressions.
- Email: polite, structured, but no invented commitments.

These are not full personas yet. They are small prompt profiles for safer text cleanup.
