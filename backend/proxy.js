const fs = require('fs');
const path = require('path');

// 加载 .env 文件中的环境变量
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2];
        }
    }
}
loadEnv();

const express = require('express');
const cors = require('cors');
const zlib = require('zlib');
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
if (!API_KEY) {
    console.error('❌ 错误: 未设置 DEEPSEEK_API_KEY');
    process.exit(1);
}

const LOG_DIR = '/var/log/compliance-lens';
const LOG_FILE = path.join(LOG_DIR, 'user-questions.log');
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) { console.warn('⚠️ 无法创建日志目录:', e.message); }

const EVENT_LOG_FILE = path.join(LOG_DIR, 'events.log');
const PROGRESS_LOG_FILE = path.join(LOG_DIR, 'progress.log');

function logQuestion(ip, question, userAgent) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, ip, question: question ? question.substring(0, 500) : '', userAgent: userAgent ? userAgent.substring(0, 200) : '' };
    const logLine = JSON.stringify(logEntry) + '\n';
    try { fs.appendFileSync(LOG_FILE, logLine); } catch (e) { console.error('日志写入失败:', e.message); }
    console.log(`[${timestamp}] 📥 用户提问 | IP:${ip} | "${question?.substring(0, 80)}..."`);
}

function logEvent(ip, eventName, params, userAgent) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, ip, event: eventName, params: params || {}, userAgent: userAgent ? userAgent.substring(0, 200) : '' };
    const logLine = JSON.stringify(logEntry) + '\n';
    try { fs.appendFileSync(EVENT_LOG_FILE, logLine); } catch (e) { console.error('事件日志写入失败:', e.message); }
    console.log(`[${timestamp}] 📊 埋点事件 | IP:${ip} | ${eventName}`);
}

function logProgress(ip, type, data, userAgent) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, ip, type, data: data || {}, userAgent: userAgent ? userAgent.substring(0, 200) : '' };
    const logLine = JSON.stringify(logEntry) + '\n';
    try { fs.appendFileSync(PROGRESS_LOG_FILE, logLine); } catch (e) { console.error('进度日志写入失败:', e.message); }
    console.log(`[${timestamp}] 📈 进度上报 | IP:${ip} | ${type}`);
}

// ========== 读取所有历史日志 ==========
function readAllLogs(maxEntries = 200, since = null) {
    const entries = [];
    
    // 收集所有日志文件（当前 + 轮转）
    const files = [];
    if (fs.existsSync(LOG_FILE)) files.push(LOG_FILE);
    
    // 查找轮转文件 .log.1, .log.2, .log.2.gz 等
    try {
        const dirFiles = fs.readdirSync(LOG_DIR);
        dirFiles.forEach(f => {
            if (f.startsWith('user-questions.log.') && f !== 'user-questions.log') {
                files.push(path.join(LOG_DIR, f));
            }
        });
    } catch (e) {}
    
    // 读取每个文件
    for (const file of files) {
        try {
            let content;
            if (file.endsWith('.gz')) {
                content = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
            } else {
                content = fs.readFileSync(file, 'utf8');
            }
            const lines = content.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.timestamp && entry.question && entry.question !== 'permission-check') {
                        entries.push(entry);
                    }
                } catch (e) {}
            }
        } catch (e) { console.warn('读取日志文件失败:', file, e.message); }
    }
    
    // 按时间排序（最新的在前）
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // 按时间过滤（since 参数）
    const sinceDate = since ? new Date(since) : null;
    if (sinceDate) {
        const filtered = entries.filter(e => new Date(e.timestamp) >= sinceDate);
        return filtered.slice(0, maxEntries);
    }
    return entries.slice(0, maxEntries);
}
function analyzeQuestions(entries) {
    const stats = {
        total: entries.length,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        uniqueIPs: new Set(),
        topQuestions: [],
        hourly: Array(24).fill(0),
        daily: {}
    };
    
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    
    for (const e of entries) {
        const d = new Date(e.timestamp);
        stats.uniqueIPs.add(e.ip);
        stats.hourly[d.getHours()]++;
        
        const dayStr = e.timestamp.split('T')[0];
        stats.daily[dayStr] = (stats.daily[dayStr] || 0) + 1;
        
        if (dayStr === todayStr) stats.today++;
        if (d >= weekAgo) stats.thisWeek++;
        if (d >= monthAgo) stats.thisMonth++;
    }
    
    return {
        total: stats.total,
        today: stats.today,
        thisWeek: stats.thisWeek,
        thisMonth: stats.thisMonth,
        uniqueIPs: stats.uniqueIPs.size,
        hourly: stats.hourly,
        daily: stats.daily
    };
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== 改进的管理后台 ==========
app.get('/admin/questions', (req, res) => {
    const auth = req.headers['x-admin-key'] || req.query?.key;
    const ADMIN_KEY = process.env.ADMIN_KEY || 'compliance-lens-2026';
    if (auth !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    
    const limit = parseInt(req.query.limit) || 200;
    const entries = readAllLogs(limit, '2026-09-07');
    const stats = analyzeQuestions(entries);
    
    res.json({
        questions: entries,
        stats,
        count: entries.length,
        logFiles: fs.readdirSync(LOG_DIR).filter(f => f.startsWith('user-questions')),
        generatedAt: new Date().toISOString()
    });
});

// ========== 文本报告（方便复制） ==========
app.get('/admin/report', (req, res) => {
    const auth = req.headers['x-admin-key'] || req.query?.key;
    const ADMIN_KEY = process.env.ADMIN_KEY || 'compliance-lens-2026';
    if (auth !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    
    const entries = readAllLogs(500, '2026-09-07');
    const stats = analyzeQuestions(entries);
    
    let report = `=== 合规透镜 · 用户提问报告 ===\n生成时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
    report += `【统计概览】\n总计提问: ${stats.total}\n今日: ${stats.today} | 本周: ${stats.thisWeek} | 本月: ${stats.thisMonth}\n独立访客: ${stats.uniqueIPs}\n\n`;
    report += `【每日分布】\n`;
    Object.entries(stats.daily).sort().forEach(([day, count]) => {
        report += `  ${day}: ${count}条\n`;
    });
    report += `\n【最近提问】\n`;
    entries.slice(0, 50).forEach((e, i) => {
        const date = new Date(e.timestamp).toLocaleString('zh-CN');
        const q = e.question.substring(0, 80);
        report += `${i+1}. [${date}] ${q}\n`;
    });
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(report);
});

// ========== 事件报告 ==========
app.get('/admin/events', (req, res) => {
    const auth = req.headers['x-admin-key'] || req.query?.key;
    const ADMIN_KEY = process.env.ADMIN_KEY || 'compliance-lens-2026';
    if (auth !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    
    const limit = parseInt(req.query.limit) || 500;
    const entries = [];
    
    if (fs.existsSync(EVENT_LOG_FILE)) {
        try {
            const lines = fs.readFileSync(EVENT_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
            for (const line of lines.reverse().slice(0, limit)) {
                try { entries.push(JSON.parse(line)); } catch (e) {}
            }
        } catch (e) {}
    }
    
    // 简单统计
    const stats = {};
    entries.forEach(e => { stats[e.event] = (stats[e.event] || 0) + 1; });
    
    res.json({
        events: entries,
        stats,
        count: entries.length,
        generatedAt: new Date().toISOString()
    });
});

// ========== 进度追踪接口 ==========
app.post('/api/progress', (req, res) => {
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const { type, data } = req.body || {};
    
    if (!type || !data) return res.status(400).json({ error: 'Missing type or data' });
    
    logProgress(clientIP, type, data, userAgent);
    res.json({ success: true });
});

// ========== 进度报告 ==========
app.get('/admin/progress', (req, res) => {
    const auth = req.headers['x-admin-key'] || req.query?.key;
    const ADMIN_KEY = process.env.ADMIN_KEY || 'compliance-lens-2026';
    if (auth !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    
    const entries = [];
    if (fs.existsSync(PROGRESS_LOG_FILE)) {
        try {
            const lines = fs.readFileSync(PROGRESS_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
            for (const line of lines.reverse()) {
                try { entries.push(JSON.parse(line)); } catch (e) {}
            }
        } catch (e) {}
    }
    
    // 统计
    const stats = { selfCheck: 0, roadmap: 0, selfCheckScores: [], roadmapProgress: [] };
    entries.forEach(e => {
        if (e.type === 'selfcheck_complete') {
            stats.selfCheck++;
            if (e.data && e.data.score) stats.selfCheckScores.push(e.data.score);
        }
        if (e.type === 'roadmap_task') stats.roadmap++;
        if (e.type === 'roadmap_init') stats.roadmap++;
    });
    
    res.json({
        entries,
        stats,
        count: entries.length,
        generatedAt: new Date().toISOString()
    });
});

// ========== 事件追踪接口 ==========
app.post('/api/track', (req, res) => {
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const { event, params } = req.body || {};
    
    if (!event) return res.status(400).json({ error: 'Missing event name' });
    
    logEvent(clientIP, event, params, userAgent);
    res.json({ success: true });
});

// ========== API代理 ==========
app.post('/api/debate', async (req, res) => {
    const startTime = Date.now();
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    let userQuestion = '';
    try {
        if (req.body && req.body.messages && req.body.messages.length > 0) {
            const lastMsg = req.body.messages[req.body.messages.length - 1];
            if (lastMsg.content) {
                const match = lastMsg.content.match(/用户问题:"(.+?)"/);
                if (match) userQuestion = match[1];
            }
        }
    } catch (e) {}
    
    if (userQuestion) logQuestion(clientIP, userQuestion, userAgent);
    
    try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
            body: JSON.stringify(req.body)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${new Date().toISOString()}] API错误:`, response.status, errorText.substring(0, 200));
            return res.status(response.status).json({ error: 'DeepSeek API错误', status: response.status, detail: errorText.substring(0, 500) });
        }
        
        const data = await response.json();
        console.log(`[${new Date().toISOString()}] 请求成功 (${Date.now() - startTime}ms)`);
        res.json(data);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 代理错误:`, err.message);
        res.status(500).json({ error: '代理请求失败', message: err.message });
    }
});

// 兼容 /debate
app.post('/debate', async (req, res) => {
    const startTime = Date.now();
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    let userQuestion = '';
    try {
        if (req.body && req.body.messages && req.body.messages.length > 0) {
            const lastMsg = req.body.messages[req.body.messages.length - 1];
            if (lastMsg.content) {
                const match = lastMsg.content.match(/用户问题:"(.+?)"/);
                if (match) userQuestion = match[1];
            }
        }
    } catch (e) {}
    if (userQuestion) logQuestion(clientIP, userQuestion, userAgent);
    try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
            body: JSON.stringify(req.body)
        });
        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({ error: 'DeepSeek API错误', status: response.status, detail: errorText.substring(0, 500) });
        }
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: '代理请求失败', message: err.message });
    }
});

app.use(express.static('/var/www/compliance-lens'));

app.listen(PORT, '127.0.0.1', () => {
    console.log(`✅ 合规透镜后端代理已启动`);
    console.log(`   端口: ${PORT}`);
    console.log(`   管理后台: http://127.0.0.1:${PORT}/admin/questions`);
    console.log(`   文本报告: http://127.0.0.1:${PORT}/admin/report`);
});
