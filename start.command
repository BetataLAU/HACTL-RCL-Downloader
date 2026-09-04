#!/bin/bash
# HACTL RCL Auto-Download Tool - macOS / Linux 啟動腳本
# (Windows 用 start.bat)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 搵唔到 Node.js。請先到 https://nodejs.org 安裝。"
  read -r -p "按 Enter 結束..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "第一次執行: 安裝相依套件中, 請稍候..."
  echo " (需要網絡連線, 約需 1-2 分鐘)"
  npm install || { echo "[ERROR] npm install 失敗。請檢查網絡後重試。"; read -r -p "按 Enter 結束..."; exit 1; }
fi

echo ""
echo "============================================="
echo "   HACTL RCL Auto Download Tool"
echo "   瀏覽器會自動開啟 http://localhost:3090"
echo "   (如冇自動開, 請手動開啟)"
echo "   關閉此視窗或按 Ctrl+C 即可停止"
echo "============================================="
echo ""

node server.js