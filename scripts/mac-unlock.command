#!/bin/bash
# YamchaMemo가 "확인되지 않은 개발자" 또는 "손상되었다고 표시되어 있어 열 수 없습니다"
# 라는 메시지로 안 열릴 때, 이 파일을 더블클릭하면 됩니다.
#
# 하는 일: macOS가 인터넷에서 받은 앱에 붙이는 격리(quarantine) 표시를
# YamchaMemo.app에서만 지웁니다. 앱 자체나 시스템 보안 설정은 건드리지 않습니다.

set -e

APP="/Applications/YamchaMemo.app"

if [ ! -d "$APP" ]; then
  osascript -e 'display dialog "/Applications 폴더에서 YamchaMemo.app을 찾지 못했습니다.\n\n먼저 다운로드한 DMG를 열어 YamchaMemo를 Applications 폴더로 옮긴 뒤, 이 파일을 다시 실행해주세요." buttons {"확인"} default button 1 with icon caution'
  exit 1
fi

xattr -cr "$APP"

osascript -e 'display dialog "완료되었습니다.\n\n이제 Launchpad나 Applications 폴더에서 YamchaMemo를 실행할 수 있습니다." buttons {"확인"} default button 1 with icon note'
