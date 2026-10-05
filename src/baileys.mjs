export async function connect({ authDir, pair = false, onDisconnect = () => {}, timers = globalThis,
  connectionTimeoutMs = 120_000 }) {
  const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } =
    await import('@whiskeysockets/baileys');
  const { default: pino } = await import('pino');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  if (!pair && !state.creds.registered) throw new Error('Pair in a terminal before starting the worker');
  const logger = pino({ level: 'silent' });
  const socket = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger, markOnlineOnConnect: false, syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });
  let writes = Promise.resolve(), credentialError, opened = false, intentionalClose = false, closePromise;
  socket.ev.on('creds.update', () => {
    writes = writes.then(saveCreds).catch(async error => {
      credentialError = error;
      await onDisconnect({ reason: 'Credential persistence failed', loggedOut: false });
    });
  });
  const ready = new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(new Error('Connection timed out')), connectionTimeoutMs);
    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr && pair) { const { default: qrTerminal } = await import('qrcode-terminal'); qrTerminal.generate(qr, { small: true }); }
      if (connection === 'open') { timers.clearTimeout(timer); opened = true; resolve(); }
      if (connection === 'close') {
        timers.clearTimeout(timer);
        if (intentionalClose) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        await onDisconnect({ reason: `Connection closed (${code ?? 'unknown'})`, loggedOut });
        if (!opened) reject(new Error(loggedOut ? 'Session needs pairing' : `Connection closed (${code ?? 'unknown'})`));
      }
    });
  });
  try { await ready; } catch (error) {
    intentionalClose = true;
    try { await socket.end(undefined); } catch { }
    await writes;
    throw error;
  }
  return {
    socket,
    async close() {
      if (!closePromise) {
        intentionalClose = true;
        closePromise = (async () => {
          await socket.end(undefined);
          await writes;
          if (credentialError) throw new Error('Credential persistence failed');
        })();
      }
      return closePromise;
    },
  };
}
