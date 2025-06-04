// index.js

require('dotenv').config();
const express = require('express');
const { Client, Intents, MessageAttachment } = require('discord.js');
const axios = require('axios');
const http = require('http');

// =====================
// 1) Express HTTP server (Render Web Service)
const app = express();
const RENDER_PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Discord Bot is running.'));
app.listen(RENDER_PORT, () => console.log(`Express listening on port ${RENDER_PORT}`));

// =====================
// 2) Bot Discord
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ESP32_PUBLIC_URL = process.env.ESP32_PUBLIC_URL; 
// Ví dụ: "http://myesp32cam.duckdns.org:9080"

if (!DISCORD_TOKEN || !ESP32_PUBLIC_URL) {
  console.error('❌ Missing environment variables.');
  process.exit(1);
}

const STREAM_URL = `${ESP32_PUBLIC_URL.replace(/\/$/, '')}/`; 
// Thêm slash để URL thấy tương tự: http://...:9080/

const httpAgent = new http.Agent({ keepAlive: true });
const client = new Client({
  intents: [ Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES ]
});

let pirPollTimer = null;

async function sendEsp32Command(path, responseType = 'json') {
  let url;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    url = path;
  } else {
    // Kết hợp ESP32_PUBLIC_URL + path
    url = `${ESP32_PUBLIC_URL}${path}`;
  }
  const opts = {
    timeout: 5000,
    httpAgent,
    responseType: (responseType === 'arraybuffer') ? 'arraybuffer' : 'json'
  };
  const res = await axios.get(url, opts);
  return res.data;
}

client.once('ready', () => {
  console.log(`🤖 Bot ready: ${client.user.tag}`);
});

async function pollPir(message) {
  try {
    await sendEsp32Command('/pir_status', 'json');
    pirPollTimer = setTimeout(() => pollPir(message), 1000);
  } catch (e) {
    console.error('PIR polling error:', e.message);
    if (e.code === 'ECONNABORTED' || (e.message && e.message.includes('Network Error'))) {
      if (pirPollTimer) {
        clearTimeout(pirPollTimer);
        pirPollTimer = null;
      }
      await message.channel.send('❌ Cannot connect to ESP32 for PIR check. Auto-PIR stopped.');
    } else {
      pirPollTimer = setTimeout(() => pollPir(message), 1000);
    }
  }
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    const txt = message.content.trim();
    if (!txt.startsWith('!')) return;

    const args = txt.split(/\s+/);
    const cmd  = args[0].toLowerCase();
    const sub  = args[1] ? args[1].toLowerCase() : null;

    if (cmd === '!help' || cmd === '!start') {
      return message.reply(
        '**AVAILABLE COMMANDS:**\n' +
        '• `!help` or `!start` → Show this guide.\n' +
        '• `!pir on` / `!pir off` → Enable/disable PIR auto-capture.\n' +
        '• `!relay on` / `!relay off` → Control relay.\n' +
        '• `!flash on` / `!flash off` → Control flash LED.\n' +
        '• `!dht` → Read DHT11 sensor.\n' +
        '• `!photo` → Manual photo capture (SVGA 800×600).\n' +
        '• `!status` → System status (chip info, temp, uptime, RSSI).\n' +
        '• `!stream` → Get URL to view MJPEG multi-client stream.\n\n' +
        `🔔 **NOTE**:\n • MJPEG stream luôn live tại \`${STREAM_URL}\`.\n`
      );
    }

    if (cmd === '!pir') {
      if (sub !== 'on' && sub !== 'off') return message.reply('❓ Use `!pir on` or `!pir off`.');
      try {
        await sendEsp32Command(`/pir?state=${sub}`, 'text');
        if (sub === 'on') {
          if (pirPollTimer) clearTimeout(pirPollTimer);
          pollPir(message);
          return message.reply('👀 PIR auto **enabled**.');
        } else {
          if (pirPollTimer) { clearTimeout(pirPollTimer); pirPollTimer = null; }
          return message.reply('🚫 PIR auto **disabled**.');
        }
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to enable/disable PIR.');
      }
    }

    if (cmd === '!relay') {
      if (sub !== 'on' && sub !== 'off') return message.reply('❓ Use `!relay on` or `!relay off`.');
      try {
        await sendEsp32Command(`/relay?state=${sub}`, 'text');
        return message.reply(sub === 'on' ? '💡 Relay **ON**.' : '💡 Relay **OFF**.');
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to control relay.');
      }
    }

    if (cmd === '!flash') {
      if (sub !== 'on' && sub !== 'off') return message.reply('❓ Use `!flash on` or `!flash off`.');
      try {
        await sendEsp32Command(`/flash?state=${sub}`, 'text');
        return message.reply(sub === 'on' ? '🔦 Flash LED **ON**.' : '🔦 Flash LED **OFF**.');
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to control flash.');
      }
    }

    if (cmd === '!dht') {
      try {
        const data = await sendEsp32Command('/dht', 'json');
        if (data.error) return message.reply('⚠️ Failed to read DHT11 sensor.');
        const temp = parseFloat(data.temperature).toFixed(1);
        const humi = parseFloat(data.humidity).toFixed(1);
        return message.reply(`🌡 **Temperature**: ${temp} °C\n💧 **Humidity**: ${humi} %`);
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to read DHT11.');
      }
    }

    if (cmd === '!photo') {
      try {
        const jpgData = await sendEsp32Command('/capture?method=manual', 'arraybuffer');
        const attachment = new MessageAttachment(Buffer.from(jpgData), 'photo.jpg');
        return message.reply({
          content: '📸 Manual capture SVGA 800×600:',
          files: [attachment]
        });
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to capture photo.');
      }
    }

    if (cmd === '!status') {
      try {
        const data = await sendEsp32Command('/status', 'json');

        const pirState   = data.pir   === 'on' ? 'ON' : 'OFF';
        const relayState = data.relay === 'on' ? 'ON' : 'OFF';
        const flashState = data.flash === 'on' ? 'ON' : 'OFF';

        const uptimeSec = parseInt(data.uptime_sec, 10);
        const h = String(Math.floor(uptimeSec / 3600)).padStart(2, '0');
        const m = String(Math.floor((uptimeSec % 3600) / 60)).padStart(2, '0');
        const s = String(uptimeSec % 60).padStart(2, '0');
        const uptimeFmt = `${h}:${m}:${s}`;

        return message.reply(
          '🎛 **SYSTEM STATUS:**\n' +
          `• PIR auto    : **${pirState}**\n` +
          `• Relay       : **${relayState}**\n` +
          `• Flash       : **${flashState}**\n\n` +
          '**DETAILED INFO:**\n' +
          `• Chip        : **${data.chip_model}** with **${data.chip_cores} cores**, features: ${Array.isArray(data.chip_features) ? data.chip_features.join(', ') : data.chip_features}\n` +
          `• Temperature : **${data.temperature} °C**\n` +
          `• Uptime      : **${uptimeFmt}**\n` +
          `• RSSI        : **${data.rssi} dBm**`
        );
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to get status.');
      }
    }

    if (cmd === '!stream') {
      return message.reply(`📺 View MJPEG stream (multi-client) at:\n${STREAM_URL}`);
    }

    return message.reply('❓ Invalid command. Use `!help` for a list of commands.');
  } catch (outerErr) {
    console.error('Unhandled exception in messageCreate:', outerErr);
  }
});

client.login(DISCORD_TOKEN);
