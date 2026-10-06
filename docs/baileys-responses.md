# Baileys response evidence

Checked on 4 October 2026 UTC through the GitHub plugin.

Pinned implementation:
https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc13/src/Socket/groups.ts

`groupParticipantsUpdate` sends participant changes and maps each returned participant to:

```js
{ status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
```

The original response node is preserved in `content`.
No thrown exception is required for a participant-level refusal.
Thus, a fulfilled promise can contain a refusal.

An upstream report supplies this historical invitation response shape:
https://github.com/WhiskeySockets/Baileys/issues/263

```json
{
  "status": "403",
  "jid": "5511999999999@s.whatsapp.net",
  "content": {
    "tag": "participant",
    "attrs": { "error": "403" },
    "content": [
      { "tag": "add_request", "attrs": { "code": "REDACTED", "expiration": "REDACTED" } }
    ]
  }
}
```

A maintainer describes the response as data for a request for the user to join.
This evidence supports `invite_required` when an `add_request` node exists.
The issue includes several possible reasons for refusal. It does not prove that every `403` means a specific privacy setting.
It is historical evidence, not a guarantee of every current WhatsApp response.

The prototype uses these rules:

1. Resolve the target through explicit PN/LID mappings.
2. Require exactly one matching participant result.
3. An `add_request` node produces `invite_required`, even if status is `200`.
4. Any other error result produces `uncertain`.
5. A `200` result without invitation evidence still needs a fresh membership check.
6. Missing membership after reported success produces `uncertain`.
7. Never send an invitation or automatically repeat the addition.

Tests include the reported `403` shape and a synthetic `200` plus `add_request` case.
The synthetic case tests defensive behavior. It is not a claim that this exact shape was observed live.
No live account response was collected during these tests.

## Logout before the first open connection

The installed `@whiskeysockets/baileys@7.0.0-rc13` package defines `DisconnectReason.loggedOut` as status `401` in `node_modules/@whiskeysockets/baileys/lib/Types/index.js`. Its socket emits `connection.update` with `connection: 'close'` and `lastDisconnect.error` from `node_modules/@whiskeysockets/baileys/lib/Socket/socket.js`.

`src/baileys.mjs` checks this status even if no `open` event occurred. It calls the runtime handler before rejecting the initial connection. The handler persists `needs_pairing` and pauses admission. The worker then stays visible without opening another session. This behavior is covered through the injected fake transport. It does not prove a live logout response from WhatsApp.
