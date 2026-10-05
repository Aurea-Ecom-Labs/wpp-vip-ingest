export async function connect({ authDir, pair = false, onDisconnect = () => {} }) {
  const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = await import('@whiskeysockets/baileys');
  const { default: pino } = await import('pino');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  if (!pair && !state.creds.registered) throw new Error('Pair in a terminal before starting the worker');
  const logger = pino({ level: 'silent' });
  const socket = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger, markOnlineOnConnect: false, syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });
  let writes = Promise.resolve(), opened = false;
  socket.ev.on('creds.update', () => {
    writes = writes.then(saveCreds).catch(() => onDisconnect({ reason: 'Credential persistence failed', loggedOut: false }));
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timed out')), 120_000);
    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr && pair) { const { default: qrTerminal } = await import('qrcode-terminal'); qrTerminal.generate(qr, { small: true }); }
      if (connection === 'open') { clearTimeout(timer); opened = true; resolve(); }
      if (connection === 'close') {
        clearTimeout(timer);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (!opened) reject(new Error(`Connection closed (${code ?? 'unknown'}); run pair again if required`));
        else onDisconnect({ reason: `Connection closed (${code ?? 'unknown'})`, loggedOut: code === 401 });
      }
    });
  });
  try { await ready; } catch (error) { socket.end(undefined); throw error; }
  let closed = false;
  return { socket, async close() { if (!closed) { closed = true; socket.end(undefined); } await writes; } };
}
