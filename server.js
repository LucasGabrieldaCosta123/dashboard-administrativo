const express = require('express');
const path = require('path');
const cors = require('cors');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

// SISTEMA DE MÚLTIPLAS SESSÕES
// Cada aba tem sua própria sessão com bot independente
const sessions = new Map(); // sessionId -> { client, clientId, createdAt }

// Limpar sessões inativas após 1 hora
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > 3600000) { // 1 hora
      if (session.client) {
        session.client.destroy().catch(() => {});
      }
      sessions.delete(sessionId);
      console.log(`[Session] ${sessionId} expirada e removida`);
    }
  }
}, 300000); // check a cada 5 minutos

// Serve index statically
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use('/static', express.static(path.join(__dirname)));

// Endpoint para configurar token/clientId e (re)logar o bot
app.post('/api/config', async (req, res) => {
  const { token, clientId, sessionId } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: 'token é obrigatório' });
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId é obrigatório' });

  try {
    // Se já existe sessão, desconectar bot anterior
    if (sessions.has(sessionId)) {
      const oldSession = sessions.get(sessionId);
      if (oldSession.client) {
        try { await oldSession.client.destroy(); } catch(e){ /* ignore */ }
      }
    }

    const discordClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      partials: [Partials.Channel]
    });

    discordClient.once('ready', function () {
      console.log(`[Bot ${sessionId}] pronto como`, this.user?.tag || '<unknown>');
    });

    await discordClient.login(token);

    // Aguardar o bot estar pronto
    if (!discordClient.user) {
      try {
        await new Promise((resolve, reject) => {
          const onReady = () => { cleanup(); resolve(); };
          const onErr = (err) => { cleanup(); reject(err); };
          const cleanup = () => {
            discordClient.removeListener('ready', onReady);
            discordClient.removeListener('error', onErr);
          };
          discordClient.once('ready', onReady);
          discordClient.once('error', onErr);
          setTimeout(() => { cleanup(); resolve(); }, 5000);
        });
      } catch (e) {
        console.error(`Erro esperando ready [${sessionId}]:`, e);
      }
    }

    // Salvar sessão
    sessions.set(sessionId, {
      client: discordClient,
      clientId: clientId || null,
      createdAt: Date.now()
    });

    return res.json({ 
      ok: true, 
      sessionId, 
      clientId: clientId || null, 
      botTag: discordClient.user ? discordClient.user.tag : null 
    });
  } catch (e) {
    sessions.delete(sessionId);
    console.error(`Erro ao logar bot [${sessionId}]:`, e);
    return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

// Desconectar bot de uma sessão específica
app.post('/api/disconnect', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId é obrigatório' });

  if (!sessions.has(sessionId)) {
    return res.json({ ok: true, message: 'sessão já desconectada' });
  }

  const session = sessions.get(sessionId);
  if (session.client) {
    try { 
      await session.client.destroy(); 
      console.log(`[Session] ${sessionId} desconectada`);
    } catch(e){ 
      console.error(`Erro ao desconectar [${sessionId}]:`, e);
    }
  }
  sessions.delete(sessionId);
  return res.json({ ok: true });
});

// retorna estado da sessão específica
app.get('/api/status', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId é obrigatório' });
  
  const session = sessions.get(sessionId);
  return res.json({ 
    online: !!(session && session.client && session.client.isReady()) 
  });
});

// lista guilds (servidores) do bot
app.get('/api/guilds', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId é obrigatório' });
  
  const session = sessions.get(sessionId);
  if (!session || !session.client || !session.client.isReady()) {
    return res.status(400).json({ ok: false, error: 'bot não conectado' });
  }
  
  const guilds = session.client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  res.json({ ok: true, guilds });
});

// lista canais de texto de um guild
app.get('/api/channels/:guildId', (req, res) => {
  const { guildId } = req.params;
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId é obrigatório' });
  
  const session = sessions.get(sessionId);
  if (!session || !session.client || !session.client.isReady()) {
    return res.status(400).json({ ok: false, error: 'bot não conectado' });
  }
  
  const guild = session.client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ ok: false, error: 'guild não encontrada' });

  const channels = guild.channels.cache
    .filter(c => c.type === 0 || c.type === 5 || c.type === 15)
    .map(c => ({ id: c.id, name: c.name, type: c.type }));
  res.json({ ok: true, channels });
});

// enviar mensagem real para canal especificado
app.post('/api/send', async (req, res) => {
  const { channelId, message, sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId é obrigatório' });
  
  const session = sessions.get(sessionId);
  if (!session || !session.client || !session.client.isReady()) {
    return res.status(400).json({ ok: false, error: 'bot não conectado' });
  }
  if (!channelId || !message) {
    return res.status(400).json({ ok: false, error: 'channelId e message são obrigatórios' });
  }

  try {
    const channel = await session.client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ ok: false, error: 'canal não encontrado' });
    if (!channel.send) return res.status(400).json({ ok: false, error: 'canal não suporta envio de mensagem' });

    const sent = await channel.send({ content: message });
    return res.json({ ok: true, id: sent.id });
  } catch (e) {
    console.error(`Erro ao enviar mensagem [${sessionId}]:`, e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// retorna link de convite
app.get('/api/invite', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId é obrigatório' });
  
  const session = sessions.get(sessionId);
  if (!session || !session.clientId) {
    return res.status(400).json({ ok: false, error: 'clientId não configurado' });
  }
  
  const url = `https://discord.com/oauth2/authorize?client_id=${session.clientId}&permissions=274877905152&scope=bot%20applications.commands`;
  return res.json({ ok: true, invite: url });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server rodando em http://localhost:${PORT}`);
});
