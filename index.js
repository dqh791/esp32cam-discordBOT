// index.js

require('dotenv').config();

const express = require('express');
const { Client, Intents, MessageAttachment } = require('discord.js');
const axios = require('axios');
const http = require('http');

// =====================
// 1) Express HTTP server (để chắc chắn Render phát hiện port-binding)
// =====================
const app = express();
const RENDER_PORT = process.env.PORT || 3000;

// Khi có request GET tới gốc, trả chuỗi đơn giản
app.get('/', (req, res) => {
  res.send('Discord Bot is running.');
});

// Bắt đầu lắng nghe cổng do Render cung cấp
app.listen(RENDER_PORT, () => {
  console.log(`🚀 Express server listening on port ${RENDER_PORT}`);
});

// =====================
// 2) Các thiết lập bot Discord
// =====================

// Đọc biến môi trường
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ESP32_IP      = process.env.ESP32_IP   || '192.168.137.173';
const ESP32_PORT    = process.env.ESP32_PORT || '80';
const BASE_URL      = `http://${ESP32_IP}:${ESP32_PORT}`;

// MJPEG stream luôn live ở port 81
const STREAM_URL    = `http://${ESP32_IP}:81/`;  

if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// HTTP agent với keepAlive (giúp kết nối TCP tái sử dụng nếu bot gọi ESP32 nhiều lần)
const httpAgent = new http.Agent({ keepAlive: true });

// Tạo Discord client
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES
  ]
});

// PIR polling timer
let pirPollTimer = null;

/**
 * Gửi HTTP GET đến ESP32 (có thể trả JSON, text, hoặc arraybuffer cho ảnh)
 * @param {string} path - endpoint của ESP32, ví dụ "/status" hoặc "/capture?method=manual"
 * @param {string} responseType - 'json' hoặc 'arraybuffer'
 * @param {string|number} port - port để request (mặc định dùng ESP32_PORT)
 */
async function sendEsp32Command(path, responseType = 'json', port = ESP32_PORT) {
  // Nếu path bắt đầu bằng "http" (URL đầy đủ), thì dùng nguyên
  let url;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    url = path;
  } else {
    url = `http://${ESP32_IP}:${port}${path}`;
  }
  const opts = {
    timeout: 5000,
    httpAgent,
    responseType: (responseType === 'arraybuffer') ? 'arraybuffer' : 'json'
  };
  const res = await axios.get(url, opts);
  return res.data;
}

// =====================
// 3) Xử lý khi bot đã sẵn sàng
// =====================
client.once('ready', () => {
  console.log(`🤖 Bot ready: ${client.user.tag}`);
});

// =====================
// 4) Hàm poll PIR (để phát hiện mất kết nối ESP32 khi PIR auto đang bật)
// =====================
async function pollPir(message) {
  try {
    await sendEsp32Command('/pir_status', 'json');
    // Nếu thành công, tiếp tục gọi lại sau 1 giây
    pirPollTimer = setTimeout(() => pollPir(message), 1000);
  } catch (e) {
    console.error('PIR polling error:', e.message);
    // Nếu error do time out hoặc network error => tắt PIR polling
    if (e.code === 'ECONNABORTED' || (e.message && e.message.includes('Network Error'))) {
      if (pirPollTimer) {
        clearTimeout(pirPollTimer);
        pirPollTimer = null;
      }
      await message.channel.send('❌ Cannot connect to ESP32 for PIR check. Auto-PIR stopped.');
    } else {
      // Nếu lỗi khác (ví dụ HTTP error), vẫn thử lại sau 1 giây
      pirPollTimer = setTimeout(() => pollPir(message), 1000);
    }
  }
}

// =====================
// 5) Xử lý sự kiện messageCreate
// =====================
client.on('messageCreate', async (message) => {
  try {
    // Bỏ qua tin nhắn từ bot khác
    if (message.author.bot) return;

    // Chỉ xử lý tin nhắn bắt đầu bằng dấu "!"
    const txt = message.content.trim();
    if (!txt.startsWith('!')) return;

    const args = txt.split(/\s+/);
    const cmd  = args[0].toLowerCase();
    const sub  = args[1] ? args[1].toLowerCase() : null;

    // ————————— !help / !start —————————
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
        '🔔 **NOTE**:\n' +
        ' • MJPEG stream luôn live tại `' + STREAM_URL + '` (port 81).\n' +
        ' • Không cần gọi `/stream_on`; ESP32 auto-stream khi client connect `/` (port 81).'
      );
    }

    // ————————— !pir on/off —————————
    if (cmd === '!pir') {
      if (sub !== 'on' && sub !== 'off') {
        return message.reply('❓ Use `!pir on` or `!pir off`.');
      }
      try {
        await sendEsp32Command(`/pir?state=${sub}`, 'text');
        if (sub === 'on') {
          if (pirPollTimer) clearTimeout(pirPollTimer);
          pollPir(message);
          return message.reply('👀 PIR auto **enabled**. ESP32 sẽ gửi ảnh qua webhook khi có chuyển động.');
        } else {
          if (pirPollTimer) {
            clearTimeout(pirPollTimer);
            pirPollTimer = null;
          }
          return message.reply('🚫 PIR auto **disabled**.');
        }
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to enable/disable PIR.');
      }
    }

    // ————————— !relay on/off —————————
    if (cmd === '!relay') {
      if (sub !== 'on' && sub !== 'off') {
        return message.reply('❓ Use `!relay on` or `!relay off`.');
      }
      try {
        await sendEsp32Command(`/relay?state=${sub}`, 'text');
        return message.reply(sub === 'on' ? '💡 Relay **ON**.' : '💡 Relay **OFF**.');
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to control relay.');
      }
    }

    // ————————— !flash on/off —————————
    if (cmd === '!flash') {
      if (sub !== 'on' && sub !== 'off') {
        return message.reply('❓ Use `!flash on` or `!flash off`.');
      }
      try {
        await sendEsp32Command(`/flash?state=${sub}`, 'text');
        return message.reply(sub === 'on' ? '🔦 Flash LED **ON**.' : '🔦 Flash LED **OFF**.');
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to control flash.');
      }
    }

    // ————————— !dht —————————
    if (cmd === '!dht') {
      try {
        const data = await sendEsp32Command('/dht', 'json');
        if (data.error) {
          return message.reply('⚠️ Failed to read DHT11 sensor.');
        }
        const temp = parseFloat(data.temperature).toFixed(1);
        const humi = parseFloat(data.humidity).toFixed(1);
        return message.reply(`🌡 **Temperature**: ${temp} °C\n💧 **Humidity**: ${humi} %`);
      } catch (e) {
        console.error(e);
        return message.reply('❌ Cannot connect to ESP32 to read DHT11.');
      }
    }

    // ————————— !photo (manual SVGA) —————————
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

    // ————————— !status —————————
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

    // ————————— !stream —————————
    if (cmd === '!stream') {
      return message.reply(`📺 View MJPEG stream (multi-client) at:\n${STREAM_URL}`);
    }

    // ————————— Không hợp lệ —————————
    return message.reply('❓ Invalid command. Use `!help` for a list of commands.');
  } catch (outerErr) {
    console.error('Unhandled exception in messageCreate:', outerErr);
  }
});

// Đăng nhập bot Discord
client.login(DISCORD_TOKEN);
