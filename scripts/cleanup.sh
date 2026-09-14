#!/bin/bash
# 合规透镜日志清理脚本
# 每天凌晨 3 点自动运行，删除 30 天前的日志

LOG_DIR="/var/log/compliance-lens"
LOG_FILE="${LOG_DIR}/user-questions.log"
RETENTION_DAYS=30

# 确保日志目录存在
mkdir -p "${LOG_DIR}"

# 如果日志文件不存在，直接退出
if [ ! -f "${LOG_FILE}" ]; then
    exit 0
fi

# 计算 30 天前的日期（兼容 GNU date 和 BSD date）
if date --version >/dev/null 2>&1; then
    # GNU date (Linux)
    CUTOFF_DATE=$(date -d "${RETENTION_DAYS} days ago" +%Y-%m-%d)
else
    # BSD date (macOS)
    CUTOFF_DATE=$(date -v-${RETENTION_DAYS}d +%Y-%m-%d)
fi

# 创建临时文件
TEMP_FILE="${LOG_FILE}.tmp"

# 保留 30 天内的记录（基于时间戳过滤）
# 日志格式: {"timestamp":"2026-08-24T08:02:05.591Z",...}
while IFS= read -r line; do
    # 提取时间戳中的日期部分
    LOG_DATE=$(echo "$line" | grep -oP '"timestamp":"\K[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")
    
    if [ -n "$LOG_DATE" ] && [ "$LOG_DATE" \> "$CUTOFF_DATE" ] || [ "$LOG_DATE" = "$CUTOFF_DATE" ]; then
        echo "$line" >> "$TEMP_FILE"
    fi
done < "$LOG_FILE"

# 统计清理前后
BEFORE_LINES=$(wc -l < "$LOG_FILE")
AFTER_LINES=$(wc -l < "$TEMP_FILE" 2>/dev/null || echo 0)
DELETED_LINES=$((BEFORE_LINES - AFTER_LINES))

# 替换原文件
mv "$TEMP_FILE" "$LOG_FILE"
chmod 644 "$LOG_FILE"

# 记录清理日志
echo "[$(date -Iseconds)] 日志清理完成: 删除 ${DELETED_LINES} 条, 保留 ${AFTER_LINES} 条 (30天内)" >> "${LOG_DIR}/cleanup.log"

# 可选：压缩备份（如果需要更长的离线存档）
# tar czf "${LOG_DIR}/archive/user-questions-$(date +%Y%m).log.gz" -C "${LOG_DIR}" user-questions.log
