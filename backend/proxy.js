const fs = require('fs');
const path = require('path');

// ========== 加载 .env ==========
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

// ========== 强制环境变量 ==========
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
if (!API_KEY) {
    console.error('❌ 错误: 未设置 DEEPSEEK_API_KEY');
    process.exit(1);
}

const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) {
    console.error('❌ 错误: 未设置 ADMIN_KEY');
    process.exit(1);
}

// ========== 信任代理配置 ==========
// 如果有 Nginx 等反向代理，配置信任的源
const TRUSTED_PROXY = process.env.TRUSTED_PROXY || '';

// ========== 日志目录 ==========
const LOG_DIR = '/var/log/compliance-lens';
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) { console.warn('⚠️ 无法创建日志目录:', e.message); }

// ========== 按日期轮转日志 ==========
function getLogFile(baseName) {
    const date = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `${baseName}.${date}.log`);
}

function writeLog(baseName, line) {
    const file = getLogFile(baseName);
    try { fs.appendFileSync(file, line); } catch (e) { console.error('日志写入失败:', e.message); }
}

// ========== 配额限制（内存级，重启清零） ==========
const quotaStore = new Map(); // ip -> { count, date }
const QUOTA_PER_IP_PER_DAY = parseInt(process.env.QUOTA_PER_IP_PER_DAY, 10) || 20;

function checkQuota(ip) {
    const today = new Date().toDateString();
    const record = quotaStore.get(ip);
    if (!record || record.date !== today) {
        quotaStore.set(ip, { count: 1, date: today });
        return { allowed: true, remaining: QUOTA_PER_IP_PER_DAY - 1 };
    }
    if (record.count >= QUOTA_PER_IP_PER_DAY) {
        return { allowed: false, remaining: 0 };
    }
    record.count++;
    return { allowed: true, remaining: QUOTA_PER_IP_PER_DAY - record.count };
}

function getQuotaStatus(ip) {
    const today = new Date().toDateString();
    const record = quotaStore.get(ip);
    if (!record || record.date !== today) {
        return { remaining: QUOTA_PER_IP_PER_DAY, total: QUOTA_PER_IP_PER_DAY };
    }
    return { remaining: Math.max(0, QUOTA_PER_IP_PER_DAY - record.count), total: QUOTA_PER_IP_PER_DAY };
}

// ========== 获取真实 IP ==========
function getClientIP(req) {
    // 优先从反向代理的 X-Forwarded-For 获取，但只信任已配置的代理
    // 生产环境应在 Nginx 层配置 set_real_ip_from
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && TRUSTED_PROXY) {
        const ips = forwarded.split(',').map(s => s.trim());
        // 取最左边的非空IP（客户端真实IP）
        for (const ip of ips) {
            if (ip && ip !== 'unknown') return ip;
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

// ========== 日志函数 ==========
function logQuestion(ip, question, userAgent) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        ip,
        question: question ? question.substring(0, 500) : '',
        userAgent: userAgent ? userAgent.substring(0, 200) : ''
    };
    writeLog('user-questions', JSON.stringify(logEntry) + '\n');
    console.log(`[${timestamp}] 📥 用户提问 | IP:${ip} | "${question ? question.substring(0, 80) : ''}..."`);
}

function logEvent(ip, eventName, params, userAgent) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        ip,
        event: eventName,
        params: params || {},
        userAgent: userAgent ? userAgent.substring(0, 200) : ''
    };
    writeLog('events', JSON.stringify(logEntry) + '\n');
    console.log(`[${timestamp}] 📊 埋点事件 | IP:${ip} | ${eventName}`);
}

function logProgress(ip, type, data, userAgent) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        ip,
        type,
        data: data || {},
        userAgent: userAgent ? userAgent.substring(0, 200) : ''
    };
    writeLog('progress', JSON.stringify(logEntry) + '\n');
    console.log(`[${timestamp}] 📈 进度上报 | IP:${ip} | ${type}`);
}

// ========== 读取历史日志 ==========
function readAllLogs(baseName, maxEntries, since) {
    const entries = [];
    const files = [];

    try {
        const dirFiles = fs.readdirSync(LOG_DIR);
        dirFiles.forEach(f => {
            if (f.startsWith(baseName + '.') && f.endsWith('.log')) {
                files.push(path.join(LOG_DIR, f));
            }
        });
    } catch (e) {}

    files.sort().reverse();

    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.timestamp) entries.push(entry);
                } catch (e) {}
            }
        } catch (e) { console.warn('读取日志文件失败:', file, e.message); }
        if (entries.length >= maxEntries * 2) break;
    }

    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const sinceDate = since ? new Date(since) : null;
    let filtered = entries;
    if (sinceDate) {
        filtered = entries.filter(e => new Date(e.timestamp) >= sinceDate);
    }
    return filtered.slice(0, maxEntries);
}

function analyzeQuestions(entries) {
    const stats = {
        total: entries.length,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        uniqueIPs: new Set(),
        hourly: Array(24).fill(0),
        daily: {}
    };

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

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

// ========== 简单速率限制（内存级） ==========
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15分钟
const RATE_MAX_REQUESTS = parseInt(process.env.RATE_MAX_REQUESTS, 10) || 100;

function rateLimitCheck(ip) {
    const now = Date.now();
    const record = rateLimitStore.get(ip);
    if (!record) {
        rateLimitStore.set(ip, { count: 1, startTime: now });
        return { allowed: true };
    }
    if (now - record.startTime > RATE_WINDOW_MS) {
        rateLimitStore.set(ip, { count: 1, startTime: now });
        return { allowed: true };
    }
    if (record.count >= RATE_MAX_REQUESTS) {
        return { allowed: false, retryAfter: Math.ceil((record.startTime + RATE_WINDOW_MS - now) / 1000) };
    }
    record.count++;
    return { allowed: true };
}

// 清理过期记录（每10分钟）
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitStore) {
        if (now - record.startTime > RATE_WINDOW_MS) {
            rateLimitStore.delete(ip);
        }
    }
}, 10 * 60 * 1000);

// ========== 配额端点 ==========
app.get('/api/quota', (req, res) => {
    const clientIP = getClientIP(req);
    res.json(getQuotaStatus(clientIP));
});

// ========== 中间件 ==========
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 全局速率限制
app.use((req, res, next) => {
    const clientIP = getClientIP(req);
    const result = rateLimitCheck(clientIP);
    if (!result.allowed) {
        return res.status(429).json({
            error: '请求过于频繁，请稍后再试',
            retryAfter: result.retryAfter
        });
    }
    next();
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== 管理后台 ==========
function checkAdminAuth(req, res) {
    const auth = req.headers['x-admin-key'] || (req.query && req.query.key);
    if (auth !== ADMIN_KEY) {
        res.status(403).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

app.get('/admin/questions', (req, res) => {
    if (!checkAdminAuth(req, res)) return;

    const limit = parseInt(req.query.limit) || 200;
    const since = req.query.since || '2026-09-07';
    const entries = readAllLogs('user-questions', limit, since);
    const stats = analyzeQuestions(entries);

    res.json({
        questions: entries,
        stats,
        count: entries.length,
        logFiles: fs.readdirSync(LOG_DIR).filter(f => f.startsWith('user-questions')),
        generatedAt: new Date().toISOString()
    });
});

app.get('/admin/report', (req, res) => {
    if (!checkAdminAuth(req, res)) return;

    const since = req.query.since || '2026-09-07';
    const entries = readAllLogs('user-questions', 500, since);
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
        const q = e.question ? e.question.substring(0, 80) : '';
        report += `${i + 1}. [${date}] ${q}\n`;
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(report);
});

app.get('/admin/events', (req, res) => {
    if (!checkAdminAuth(req, res)) return;

    const limit = parseInt(req.query.limit) || 500;
    const entries = readAllLogs('events', limit);

    const stats = {};
    entries.forEach(e => { stats[e.event] = (stats[e.event] || 0) + 1; });

    res.json({
        events: entries,
        stats,
        count: entries.length,
        generatedAt: new Date().toISOString()
    });
});

app.get('/admin/progress', (req, res) => {
    if (!checkAdminAuth(req, res)) return;

    const entries = readAllLogs('progress', 1000);

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

// ========== 进度追踪 ==========
app.post('/api/progress', (req, res) => {
    const clientIP = getClientIP(req);
    const userAgent = req.headers['user-agent'];
    const { type, data } = req.body || {};

    if (!type || !data) return res.status(400).json({ error: 'Missing type or data' });

    logProgress(clientIP, type, data, userAgent);
    res.json({ success: true });
});

// ========== 事件追踪 ==========
app.post('/api/track', (req, res) => {
    const clientIP = getClientIP(req);
    const userAgent = req.headers['user-agent'];
    const { event, params } = req.body || {};

    if (!event) return res.status(400).json({ error: 'Missing event name' });

    logEvent(clientIP, event, params, userAgent);
    res.json({ success: true });
});

// ========== API 代理 ==========
async function handleDebate(req, res) {
    const startTime = Date.now();
    const clientIP = getClientIP(req);
    const userAgent = req.headers['user-agent'];

    // 配额检查
    const quota = checkQuota(clientIP);
    if (!quota.allowed) {
        return res.status(429).json({
            error: '今日额度已用完',
            remaining: 0,
            total: QUOTA_PER_IP_PER_DAY
        });
    }

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
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(req.body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${new Date().toISOString()}] API错误:`, response.status, errorText.substring(0, 200));
            return res.status(response.status).json({
                error: 'DeepSeek API错误',
                status: response.status,
                detail: errorText.substring(0, 500)
            });
        }

        const data = await response.json();
        console.log(`[${new Date().toISOString()}] 请求成功 (${Date.now() - startTime}ms)`);

        // 在响应头中返回剩余额度
        res.setHeader('X-Quota-Remaining', quota.remaining);
        res.json(data);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 代理错误:`, err.message);
        res.status(500).json({ error: '代理请求失败', message: err.message });
    }
}

app.post('/api/debate', handleDebate);
app.post('/debate', handleDebate);

app.use(express.static('/var/www/compliance-lens'));

app.listen(PORT, '127.0.0.1', () => {
    console.log(`✅ 合规透镜后端代理已启动`);
    console.log(`   端口: ${PORT}`);
    console.log(`   管理后台: http://127.0.0.1:${PORT}/admin/questions`);
    console.log(`   文本报告: http://127.0.0.1:${PORT}/admin/report`);
    console.log(`   每日IP配额: ${QUOTA_PER_IP_PER_DAY}`);
    console.log(`   速率限制: ${RATE_MAX_REQUESTS}次/${RATE_WINDOW_MS/60000}分钟`);
});
