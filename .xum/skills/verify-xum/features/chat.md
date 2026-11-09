# Chat

The user types a message in a workspace's composer and sends it. The reply streams into the
`Conversation transcript` log, the user can stop a reply that is still streaming, and the
transcript is the same after a reload.

## Sub-features

- `chat-send` sends a message and shows the user row and the reply.
- `chat-stop` stops a streaming reply and marks it interrupted.
- `chat-persist` shows the same transcript after a page reload, from `chat.jsonl`.

## How to get to it (user POV)

- Type in the `Message` textbox of an open workspace and press Enter, or choose `Send message`.
- Choose `Stop streaming` while a reply streams.
- Reload the page on `/workspace/<id>`.

## Driving it with agent-browser

Preconditions:

- Baseline state. The app is open on `Verify playground` with an empty transcript.
- `verify-xum.sh idle` returned.

- **Send with Enter.** Run
  `agent-browser find role textbox fill "Hello from verify-xum" --name "Message" --exact`,
  `verify-xum.sh send-ready`, `agent-browser press Enter`,
  `agent-browser wait --text "Mock response: Hello from verify-xum"` and `verify-xum.sh idle`. The
  transcript shows the user row `Hello from verify-xum` and the reply
  `Mock response: Hello from verify-xum`. Capture `chat/reply`.
- **Send with the button.** Fill `Second message`, run `verify-xum.sh send-ready`, then run
  `agent-browser find role button click --name "Send message" --exact` and
  `agent-browser wait --text "Mock response: Second message"`.
- **Check history.** The transcript shows a reply before the server writes it to `chat.jsonl` at
  the end of the stream. Wait for the saved reply, then save the last four rows of the workspace
  history:

  ```bash
  chat_jsonl="$VERIFY_XUM_ROOT/sessions/$VERIFY_XUM_WORKSPACE_ID/chat.jsonl"
  timeout 10 sh -c 'until grep -qF "Mock response: Second message" "$1"; do sleep 0.2; done' sh "$chat_jsonl"
  mkdir -p "$VERIFY_XUM_EVIDENCE/chat"
  tail -n 4 "$chat_jsonl" >"$VERIFY_XUM_EVIDENCE/chat/history.txt"
  ```

  The file has two `"role":"user"` rows and two `"role":"assistant"` rows with the reply texts.

- **Stop a stream.** Fill `[mock:long-stream] tell a long story`, run `verify-xum.sh send-ready`
  and press Enter. Run `agent-browser wait '[aria-label="Stop streaming"]'`, then wait for a few
  chunks with
  `agent-browser wait --fn "document.body.innerText.split('Streaming response').length > 40"`.
  Run `agent-browser click '[aria-label="Stop streaming"]'` and `verify-xum.sh idle`. The reply
  keeps its partial text, an `INTERRUPTED` divider follows it, and the button
  `Continue interrupted response` appears. Capture `chat/stopped`.
- **Reload.** Run `agent-browser reload` and `verify-xum.sh idle`. The transcript still shows both
  replies, the partial reply and `INTERRUPTED`. Capture `chat/reloaded`.

## Gotchas

- Enter pressed before `send-ready` returns is refused with the alert
  `Transcript is still loading — wait until it is up to date before sending or editing.` The draft
  stays in the box, and the alert stays until you choose `Dismiss`.
- `verify-xum.sh idle` returns at once before a stream starts. Wait for the reply text or the
  `Stop streaming` button first, then for idle.
- The mock writes partial text to disk every 100 ms. A Stop in the first 100 ms of a stream can
  leave `INTERRUPTED` with no text after a reload. Wait for chunks before you stop.
- A model picked in the composer stays in memory until a send. A reload before the send shows the
  workspace's saved model again (`src/browser/utils/modelChange.ts`).
