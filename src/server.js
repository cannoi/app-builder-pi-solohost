const express = require('express');
const cors = require('cors');
const path = require('path');

// Bắt lỗi toàn cục để tránh crash server đột ngột
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Hàm nhận diện ngôn ngữ đơn giản & phản hồi tin nhắn AI
function generateAIResponse(message) {
  const text = message.toLowerCase();
  
  // Phát hiện ngôn ngữ tiếng Việt
  const isVietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text) || 
                       text.includes('xin chào') || text.includes('tạo app') || text.includes('pi');

  if (isVietnamese) {
    if (text.includes('node') || text.includes('solohost')) {
      return "⚡ **Pi SoloHost Assistant**: Để cấu hình Node SoloHost, bạn chỉ cần chọn tên App, bật SSL và nhấn 'Tạo App'. Hệ thống sẽ tự động tối ưu hóa container cho Pi Network!";
    }
    return "⚡ **Pi SoloHost Assistant**: Chào mừng bạn! Tôi có thể giúp gì cho bạn trong việc tạo App cho Pi SoloHost hôm nay?";
  } 
  
  // Mặc định phản hồi Tiếng Anh tinh gọn
  if (text.includes('node') || text.includes('build') || text.includes('app')) {
    return "⚡ **Pi SoloHost Assistant**: To build your Pi SoloHost app, just enter your App Name, enable SSL, and click 'Build App'. Optimization is handled automatically!";
  }
  return "⚡ **Pi SoloHost Assistant**: Welcome! How can I help you build your Pi SoloHost application today?";
}

// API Chat AI hỗ trợ đa ngôn ngữ
app.post('/api/chat', (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const reply = generateAIResponse(message);
    res.json({ reply });
  } catch (error) {
    console.error('Chat API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API Tạo App SoloHost
app.post('/api/build', (req, res) => {
  try {
    const { appName, domain, enableSSL } = req.body;
    if (!appName) {
      return res.status(400).json({ success: false, message: 'App Name is required' });
    }

    const appConfig = {
      name: appName,
      domain: domain || `${appName.toLowerCase().replace(/\s+/g, '-')}.pisolohost.net`,
      ssl: !!enableSSL,
      piSdkStatus: 'Ready',
      dockerCompose: `version: '3.8'\nservices:\n  ${appName.toLowerCase()}:\n    image: node:18-alpine\n    ports:\n      - "8080:8080"\n    restart: always`
    };

    res.json({
      success: true,
      message: 'App SoloHost configured successfully!',
      config: appConfig
    });
  } catch (error) {
    console.error('Build API Error:', error);
    res.status(500).json({ success: false, message: 'Failed to build app configuration' });
  }
});

// Serve Single Page Application
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Khởi chạy server trên cổng 8080 và Bind 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================`);
  console.log(`🚀 Pi SoloHost App Builder Running`);
  console.log(`🌐 Address: http://0.0.0.0:${PORT}`);
  console.log(`=================================`);
});
