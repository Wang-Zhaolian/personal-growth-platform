@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.19 或更新版本，再重新运行本脚本。
  pause
  exit /b 1
)
echo 正在安装依赖...
npm install
if errorlevel 1 goto failed
echo 正在构建应用...
npm run build
if errorlevel 1 goto failed
echo 正在创建桌面快捷方式...
npm run desktop
if errorlevel 1 goto failed
echo.
echo 安装完成。双击桌面上的“拾阶 · 个人成长平台”即可打开。
pause
exit /b 0
:failed
echo.
echo 安装未完成。请检查上方提示后重试。
pause
exit /b 1
