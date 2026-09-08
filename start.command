#!/bin/zsh
set -e
cd "${0:A:h}"
command -v node >/dev/null || { echo '请先安装 Node.js 22 LTS，再重新打开。'; read -r '?按 Enter 退出'; exit 1; }
if [ ! -d node_modules ]; then npm ci; fi
npm run build
PORT_VALUE="$(node --input-type=module -e 'import "dotenv/config"; console.log(process.env.PORT || "4321")')"
(sleep 2; open "http://127.0.0.1:${PORT_VALUE}") &
exec npm start
